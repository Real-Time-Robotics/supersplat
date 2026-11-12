import createFetchClient, { type Client as FetchClient } from 'openapi-fetch';

import { GenesisError, TransportError, UploadError, raiseForResponse, unwrap } from './errors';
import { classifyStoreStatus, classifyThrown, type FailureClass } from './failure';
import { callerSignal, createRetryingFetch, delayFor, resolveRetry, type RetryOptions } from './retry';
import type { components, paths } from './schema';

type Schemas = components['schemas'];
type Api = FetchClient<paths>;
type JobStatus = Schemas['JobStatus'];
type PipelineInfo = Schemas['PipelineInfo'];
type Artifact = Schemas['Artifact'];
type RunInfo = Schemas['RunInfo'];
type ClientConfig = Schemas['ClientConfig'];
type ClientPolicy = Schemas['ClientPolicy'];
type TagOptions = Schemas['TagOptions'];
type Tags = Schemas['Tags'];
type PricingCatalog = Record<string, unknown>;
type CreditQuote = Schemas['CreditQuote'];
type CreditBalance = Schemas['CreditBalance'];
type JobDatasetEvent = Schemas['JobDatasetEvent'];
type JobPullProgress = Schemas['JobPullProgress'];
type JobGpuEvent = Schemas['JobGpuEvent'];

type NamedBlob = {
    name: string;
    data: Blob;
};

type Uploadable = File | NamedBlob;

type UploadProgress = {
    phase: 'presign' | 'upload' | 'finalize' | 'ingest';
    loaded: number;
    total: number;
    file?: string;
    datasetId: string;
};

type UploadProgressFn = (p: UploadProgress) => void;

type UploadOptions = {
    label?: string;
    tags?: Tags;
    signal?: AbortSignal;
    onProgress?: UploadProgressFn;
    datasetId?: string;
};

type ClientOptions = {
    fetch?: typeof fetch;
    retry?: RetryOptions;
    ingestTimeoutMs?: number;
    ingestPollMs?: number;
    requestTimeoutMs?: number;
    connectTimeoutMs?: number;
    uploadConcurrency?: number;
    stallTimeoutMs?: number;
};

const SDK_VERSION = '0.5.0';
const IMAGE_MIME: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    bmp: 'image/bmp',
    webp: 'image/webp'
};
const UPLOAD_CONCURRENCY = 8;
const PRESIGN_BATCH = 200;
const PUT_CHUNK_BYTES = 256 * 1024;
const INGEST_POLL_MS = 2000;
const INGEST_TIMEOUT_MS = 3_600_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const PUT_STALL_MS = 300_000;
const PUT_RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

const isNodeRuntime = (): boolean => !!(globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node;

const optionsFromPolicy = (policy: ClientPolicy): ClientOptions => ({
    requestTimeoutMs: policy.request_timeout_ms,
    connectTimeoutMs: policy.connect_timeout_ms,
    retry: {
        maxAttempts: policy.retry_max_attempts,
        backoff: policy.retry_backoff_ms / 1000
    },
    ingestTimeoutMs: policy.ingest_timeout_ms,
    ingestPollMs: policy.ingest_poll_ms,
    uploadConcurrency: policy.upload_concurrency,
    stallTimeoutMs: policy.upload_stall_timeout_ms
});

class BytesSent {
    #settled = 0;

    #liveTotal = 0;

    readonly #live = new Map<string, number>();

    readonly #total: number;

    readonly #emit: (loaded: number, file?: string) => void;

    constructor(total: number, emit: (loaded: number, file?: string) => void) {
        this.#total = total;
        this.#emit = emit;
    }

    loaded(): number {
        return Math.min(this.#settled + this.#liveTotal, this.#total);
    }

    done(bytes: number): void {
        this.#settled += bytes;
        this.#emit(this.loaded());
    }

    inFlight(key: string, bytes: number): void {
        this.#liveTotal += bytes - (this.#live.get(key) ?? 0);
        this.#live.set(key, bytes);
        this.#emit(this.loaded());
    }

    settle(key: string, size: number): void {
        this.#liveTotal -= this.#live.get(key) ?? 0;
        this.#live.delete(key);
        this.#settled += size;
        this.#emit(this.loaded(), key);
    }
}

const putInit = (body: Blob, headers: Record<string, string> | undefined,
    signal: AbortSignal | undefined,
    onBytes?: (sentThisAttempt: number) => void): RequestInit => {
    if (!onBytes || !isNodeRuntime()) return { method: 'PUT', body, headers, signal };
    let offset = 0;
    const counted = new ReadableStream<Uint8Array>({
        async pull(controller) {
            if (offset >= body.size) {
                controller.close();
                return;
            }
            const chunk = new Uint8Array(
                await body.slice(offset, offset + PUT_CHUNK_BYTES).arrayBuffer());
            offset += chunk.byteLength;
            onBytes(offset);
            controller.enqueue(chunk);
        }
    });
    return {
        method: 'PUT',
        body: counted,
        signal,
        duplex: 'half',
        headers: { ...(headers ?? {}), 'Content-Length': String(body.size) }
    } as RequestInit;
};

const sleep = (ms: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
});

const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> => {
    if (!signal) return sleep(ms);
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        function onAbort() {
            clearTimeout(timer);
            reject(signal.reason);
        }
        signal.addEventListener('abort', onAbort, { once: true });
    });
};

const idempotencyKey = (): string => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    }
    throw new Error('secure randomness is required to create an idempotency key');
};

const asClassified = (err: unknown): unknown => {
    if (err instanceof GenesisError) return err;
    const cls = classifyThrown(err);
    const summary = cls === 'cancelled' ? 'aborted by the caller' :
        cls === 'deadline-exceeded' ? 'timed out with no response' :
            'the connection to the object store or control plane broke';
    return new TransportError(summary, err);
};

const blobOf = (f: Uploadable): Blob => (f instanceof Blob ? f : f.data);

const guessType = (name: string): string => IMAGE_MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

const encodePath = (name: string): string => name.split('/').map(encodeURIComponent).join('/');

const anySignal = (signals: (AbortSignal | undefined)[]): AbortSignal | undefined => {
    const real = signals.filter((s): s is AbortSignal => s != null);
    if (real.length === 0) return undefined;
    return real.length === 1 ? real[0] : AbortSignal.any(real);
};

class StallGuard {
    readonly #ctl = new AbortController();

    readonly signal: AbortSignal | undefined;

    readonly #ms: number;

    #timer: ReturnType<typeof setTimeout> | undefined;

    constructor(ms: number, caller?: AbortSignal) {
        this.#ms = ms;
        this.signal = anySignal([caller, this.#ctl.signal]);
        this.kick();
    }

    kick(): void {
        clearTimeout(this.#timer);
        this.#timer = setTimeout(
            () => this.#ctl.abort(new DOMException(`no bytes sent for ${this.#ms}ms`, 'TimeoutError')),
            this.#ms);
        (this.#timer as unknown as { unref?: () => void }).unref?.();
    }

    stop(): void {
        clearTimeout(this.#timer);
    }
}

const classifying = (fetchImpl: typeof fetch): typeof fetch => (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
        return await fetchImpl(input, init);
    } catch (err) {
        if (callerSignal(input, init)?.aborted) throw err;
        throw asClassified(err);
    }
}) as typeof fetch;

const withPerAttemptTimeout = (fetchImpl: typeof fetch, ms: number): typeof fetch => (async (input: RequestInfo | URL, init?: RequestInit) => {
    const caller = callerSignal(input, init);
    if (caller?.aborted) throw caller.reason;
    const ac = new AbortController();
    const timer = setTimeout(() => {
        caller?.removeEventListener('abort', onAbort);
        ac.abort(new DOMException('signal timed out', 'TimeoutError'));
    }, ms);
    function onAbort() {
        clearTimeout(timer);
        ac.abort(caller.reason);
    }
    caller?.addEventListener('abort', onAbort, { once: true });
    try {
        const res = await fetchImpl(input, { ...init, signal: ac.signal });
        (timer as unknown as { unref?: () => void }).unref?.();
        return res;
    } catch (err) {
        clearTimeout(timer);
        caller?.removeEventListener('abort', onAbort);
        throw err;
    }
}) as typeof fetch;

const withConnectTimeout = (fetchImpl: typeof fetch, ms: number): typeof fetch => (async (input: RequestInfo | URL, init?: RequestInit) => {
    const caller = callerSignal(input, init);
    if (caller?.aborted) throw caller.reason;
    const ac = new AbortController();
    const timer = setTimeout(() => {
        caller?.removeEventListener('abort', onAbort);
        ac.abort(new DOMException(`no response headers within ${ms}ms`, 'TimeoutError'));
    }, ms);
    function onAbort() {
        clearTimeout(timer);
        ac.abort(caller.reason);
    }
    caller?.addEventListener('abort', onAbort, { once: true });
    try {
        return await fetchImpl(input, { ...init, signal: ac.signal });
    } catch (err) {
        caller?.removeEventListener('abort', onAbort);
        throw err;
    } finally {
        clearTimeout(timer);
    }
}) as typeof fetch;

const fetchErrorText = (err: unknown): string => {
    const parts: string[] = [];
    const add = (text: string) => {
        if (text && !parts.some(p => p.includes(text))) parts.push(text);
    };
    let node: unknown = err;
    for (let depth = 0; node != null && depth < 4; depth++) {
        const current = node;
        if (!(current instanceof Error)) {
            add(String(current));
            break;
        }
        add(current.message);
        const code = (current as { code?: unknown }).code;
        if (typeof code === 'string') add(code);
        node = current.cause;
    }
    return parts.join(': ') || String(err);
};

const mapLimit = async <T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> => {
    let next = 0;
    const worker = async () => {
        while (next < items.length) await fn(items[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
};

class Client {
    readonly #raw: Api;

    readonly #rawLong: Api;

    readonly #baseUrl: string;

    readonly #headers: Record<string, string>;

    readonly #fetch: typeof fetch;

    readonly #apiFetch: typeof fetch;

    readonly #retry: Required<RetryOptions>;

    readonly #ingestTimeoutMs: number;

    readonly #ingestPollMs: number;

    readonly #uploadConcurrency: number;

    readonly #stallTimeoutMs: number;

    constructor(baseUrl: string, token: string, opts: ClientOptions = {}) {
        this.#baseUrl = baseUrl.replace(/\/+$/, '');
        this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
        const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        const connectTimeoutMs = opts.connectTimeoutMs ?? requestTimeoutMs;
        const retrying = (withTimeout: (f: typeof fetch, ms: number) => typeof fetch, timeoutMs: number) => createRetryingFetch(timeoutMs > 0 ? withTimeout(this.#fetch, timeoutMs) : this.#fetch, opts.retry);
        this.#apiFetch = classifying(retrying(withPerAttemptTimeout, requestTimeoutMs));
        const streamFetch = classifying(retrying(withConnectTimeout, connectTimeoutMs));
        this.#retry = resolveRetry(opts.retry);
        this.#ingestTimeoutMs = opts.ingestTimeoutMs ?? INGEST_TIMEOUT_MS;
        this.#ingestPollMs = opts.ingestPollMs ?? INGEST_POLL_MS;
        this.#uploadConcurrency = Math.max(1, opts.uploadConcurrency ?? UPLOAD_CONCURRENCY);
        this.#stallTimeoutMs = opts.stallTimeoutMs ?? PUT_STALL_MS;

        const commonHeaders: Record<string, string> = {};
        if (isNodeRuntime()) commonHeaders['User-Agent'] = `genesis-recon-typescript/${SDK_VERSION}`;
        const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
        this.#headers = { ...auth, ...commonHeaders };
        const api = (fetchImpl: typeof fetch) => createFetchClient<paths>({
            baseUrl: this.#baseUrl,
            headers: { ...auth, ...commonHeaders },
            fetch: fetchImpl
        });
        this.#raw = api(this.#apiFetch);
        this.#rawLong = api(streamFetch);
    }

    get baseUrl(): string {
        return this.#baseUrl;
    }

    #authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
        const headers = new Headers(init.headers);
        for (const [k, v] of Object.entries(this.#headers)) headers.set(k, v);
        return this.#apiFetch(url, { ...init, headers });
    }

    async #billingJson<T>(path: string, init: RequestInit = {}): Promise<T> {
        const res = await this.#authedFetch(`${this.#baseUrl}${path}`, init);
        if (!res.ok) await raiseForResponse(res);
        return (await res.json()) as T;
    }

    async #presignedUrl(path: string, signal?: AbortSignal): Promise<string> {
        const res = await this.#authedFetch(`${this.#baseUrl}${path}`, { signal });
        if (!res.ok) await raiseForResponse(res);
        return (await res.json() as { url: string }).url;
    }

    async getConfig(opts: { signal?: AbortSignal } = {}): Promise<ClientConfig> {
        return unwrap(await this.#raw.GET('/v1/config', { signal: opts.signal }));
    }

    async listPipelines(opts: { signal?: AbortSignal } = {}): Promise<PipelineInfo[]> {
        return unwrap(await this.#raw.GET('/v1/pipelines', { signal: opts.signal }));
    }

    async getPreset(pipeline: string, name: string,
        opts: { signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
        return unwrap(await this.#raw.GET('/v1/pipelines/{pipeline}/presets/{name}', {
            params: { path: { pipeline, name } }, signal: opts.signal
        })).config;
    }

    async getPricingCatalog(opts: { signal?: AbortSignal } = {}): Promise<PricingCatalog> {
        return unwrap(await this.#raw.GET('/v1/pricing', { signal: opts.signal }));
    }

    async listDatasets(opts: { limit?: number; offset?: number; signal?: AbortSignal } = {}) {
        return unwrap(await this.#raw.GET('/v1/datasets', {
            params: { query: { limit: opts.limit, offset: opts.offset } }, signal: opts.signal
        }));
    }

    async deleteDataset(datasetId: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
        unwrap(await this.#raw.DELETE('/v1/datasets/{dataset_id}', {
            params: { path: { dataset_id: datasetId } }, signal: opts.signal
        }));
    }

    async setDatasetLabel(datasetId: string, label: string,
        opts: { signal?: AbortSignal } = {}): Promise<string> {
        return unwrap(await this.#raw.PUT('/v1/datasets/{dataset_id}', {
            params: { path: { dataset_id: datasetId } }, body: { label }, signal: opts.signal
        })).label;
    }

    async listDatasetTags(opts: { signal?: AbortSignal } = {}): Promise<TagOptions> {
        return unwrap(await this.#raw.GET('/v1/datasets/tags', { signal: opts.signal }));
    }

    async listRuns(datasetId: string, opts: { signal?: AbortSignal } = {}): Promise<RunInfo[]> {
        return unwrap(await this.#raw.GET('/v1/datasets/{dataset_id}/runs', {
            params: { path: { dataset_id: datasetId } }, signal: opts.signal
        })).runs;
    }

    async deleteRun(datasetId: string, pipeline: string, runName: string,
        opts: { signal?: AbortSignal } = {}): Promise<void> {
        unwrap(await this.#raw.DELETE('/v1/datasets/{dataset_id}/runs/{pipeline}/{run_name}', {
            params: { path: { dataset_id: datasetId, pipeline, run_name: runName } },
            signal: opts.signal
        }));
    }

    async deleteRunArtifact(datasetId: string, pipeline: string, runName: string, name: string,
        opts: { signal?: AbortSignal } = {}): Promise<void> {
        unwrap(await this.#raw.DELETE(
            '/v1/datasets/{dataset_id}/runs/{pipeline}/{run_name}/artifacts/{name}', {
                params: { path: { dataset_id: datasetId, pipeline, run_name: runName, name } },
                signal: opts.signal
            }));
    }

    async listOpenSessions(opts: { signal?: AbortSignal } = {}) {
        return unwrap(await this.#raw.GET('/v1/datasets/sessions', { signal: opts.signal })).sessions;
    }

    async createDatasetSession(opts: { signal?: AbortSignal; tags?: Tags } = {}): Promise<string> {
        return unwrap(await this.#raw.POST('/v1/datasets/sessions', {
            body: opts.tags ? { tags: opts.tags } : undefined, signal: opts.signal
        })).dataset_id;
    }

    async uploadDataset(files: Uploadable[], opts: UploadOptions = {}): Promise<string> {
        try {
            if (opts.signal?.aborted) throw new DOMException('uploadDataset aborted', 'AbortError');
            if (files.length === 0) throw new Error('uploadDataset: no files given');
            const datasetId = opts.datasetId ??
                await this.createDatasetSession({ signal: opts.signal, tags: opts.tags });
            await this.#uploadLoose(datasetId, files, opts);
            if (opts.label != null) {
                await this.setDatasetLabel(datasetId, opts.label, { signal: opts.signal });
            }
            return datasetId;
        } catch (err) {
            throw asClassified(err);
        }
    }

    async submitJob(pipeline: string, config: Record<string, unknown>,
        opts: { node?: string; label?: string; preset?: string; idempotencyKey?: string;
            signal?: AbortSignal } = {}): Promise<string> {
        const res = await this.#raw.POST('/v1/jobs', {
            params: { header: { 'Idempotency-Key': opts.idempotencyKey ?? idempotencyKey() } },
            body: {
                pipeline_name: pipeline,
                config,
                node: opts.node,
                label: opts.label,
                preset: opts.preset
            },
            signal: opts.signal
        });
        return unwrap(res).job_id;
    }

    async getJob(jobId: string, opts: { signal?: AbortSignal } = {}): Promise<JobStatus> {
        return unwrap(await this.#raw.GET('/v1/jobs/{job_id}', {
            params: { path: { job_id: jobId } }, signal: opts.signal
        }));
    }

    async cancelJob(jobId: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
        unwrap(await this.#raw.POST('/v1/jobs/{job_id}/cancel', {
            params: { path: { job_id: jobId } }, signal: opts.signal
        }));
    }

    async setJobLabel(jobId: string, label: string,
        opts: { signal?: AbortSignal } = {}): Promise<string> {
        return unwrap(await this.#raw.PUT('/v1/jobs/{job_id}/label', {
            params: { path: { job_id: jobId } }, body: { label }, signal: opts.signal
        })).label;
    }

    async deleteJob(jobId: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
        unwrap(await this.#raw.DELETE('/v1/jobs/{job_id}', {
            params: { path: { job_id: jobId } }, signal: opts.signal
        }));
    }

    async deleteArtifact(jobId: string, name: string,
        opts: { signal?: AbortSignal } = {}): Promise<void> {
        unwrap(await this.#raw.DELETE('/v1/jobs/{job_id}/artifacts/{name}', {
            params: { path: { job_id: jobId, name } }, signal: opts.signal
        }));
    }

    async listArtifacts(jobId: string, opts: { signal?: AbortSignal } = {}): Promise<Artifact[]> {
        return unwrap(await this.#raw.GET('/v1/jobs/{job_id}/artifacts', {
            params: { path: { job_id: jobId } }, signal: opts.signal
        })).artifacts;
    }

    getArtifactUrl(jobId: string, name: string,
        opts: { signal?: AbortSignal } = {}): Promise<string> {
        return this.#presignedUrl(
            `/v1/jobs/${encodePath(jobId)}/artifacts/${encodePath(name)}?redirect=false`,
            opts.signal);
    }

    async listRunArtifacts(datasetId: string, pipeline: string, runName: string,
        opts: { signal?: AbortSignal } = {}): Promise<Artifact[]> {
        return unwrap(await this.#raw.GET(
            '/v1/datasets/{dataset_id}/runs/{pipeline}/{run_name}/artifacts',
            { params: { path: { dataset_id: datasetId, pipeline, run_name: runName } },
                signal: opts.signal }
        )).artifacts;
    }

    getRunArtifactUrl(datasetId: string, pipeline: string, runName: string,
        name: string, opts: { signal?: AbortSignal } = {}): Promise<string> {
        return this.#presignedUrl(
            `/v1/datasets/${encodeURIComponent(datasetId)}` +
            `/runs/${encodeURIComponent(pipeline)}/${encodeURIComponent(runName)}` +
            `/artifacts/${encodePath(name)}?redirect=false`,
            opts.signal);
    }

    getCreditBalance(opts: { signal?: AbortSignal } = {}): Promise<CreditBalance> {
        return this.#billingJson('/v1/billing/credits', { signal: opts.signal });
    }

    quote(datasetId: string, pipeline: string,
        opts: { signal?: AbortSignal } = {}): Promise<CreditQuote> {
        const qs = new URLSearchParams({ dataset: datasetId, pipeline });
        return this.#billingJson(`/v1/billing/quote?${qs}`, { signal: opts.signal });
    }

    estimate(nImages: number, pipeline: string,
        opts: { totalPixels?: number; signal?: AbortSignal } = {}): Promise<CreditQuote> {
        const body: Record<string, unknown> = { n_images: nImages, pipeline };
        if (opts.totalPixels != null) body.total_pixels = opts.totalPixels;
        return this.#billingJson('/v1/billing/estimate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: opts.signal
        });
    }

    async #presignImages(datasetId: string, names: string[],
        signal?: AbortSignal): Promise<Map<string, string>> {
        const { urls } = unwrap(await this.#raw.POST('/v1/datasets/sessions/{dataset_id}/presign', {
            params: { path: { dataset_id: datasetId } }, body: { names }, signal
        }));
        return new Map(urls.map(u => [u.name, u.url]));
    }

    async #sessionContents(datasetId: string, signal?: AbortSignal): Promise<Map<string, number>> {
        const listing = unwrap(await this.#raw.GET('/v1/datasets/sessions/{dataset_id}', {
            params: { path: { dataset_id: datasetId } }, signal
        }));
        return new Map(listing.images.map(i => [i.name, i.bytes]));
    }

    async #uploadLoose(datasetId: string, files: Uploadable[], opts: UploadOptions): Promise<void> {
        const blobByName = new Map(files.map(f => [f.name, blobOf(f)]));
        const sizeByName = new Map([...blobByName].map(([name, b]) => [name, b.size]));
        const total = [...sizeByName.values()].reduce((a, b) => a + b, 0);
        const sent = new BytesSent(total, (loaded, file) => opts.onProgress?.({ phase: 'upload', loaded, total, file, datasetId }));
        opts.onProgress?.({ phase: 'presign', loaded: 0, total, datasetId });
        let pending = files;
        if (opts.datasetId) {
            const have = await this.#sessionContents(datasetId, opts.signal);
            pending = files.filter(f => have.get(f.name) !== sizeByName.get(f.name));
            sent.done(total - pending.reduce((a, f) => a + (sizeByName.get(f.name) ?? 0), 0));
        }
        const cancel = new AbortController();
        const fileSignal = anySignal([opts.signal, cancel.signal]);
        try {
            for (let i = 0; i < pending.length; i += PRESIGN_BATCH) {
                const batch = pending.slice(i, i + PRESIGN_BATCH);
                const urlByName = await this.#presignImages(datasetId, batch.map(f => f.name), opts.signal);
                await mapLimit(batch, this.#uploadConcurrency, async (f) => {
                    const url = urlByName.get(f.name);
                    if (!url) throw new UploadError(`server did not presign ${f.name}`);
                    await this.#putObject(url, blobByName.get(f.name) as Blob, `upload ${f.name}`,
                        async () => (await this.#presignImages(datasetId, [f.name], opts.signal)).get(f.name),
                        { 'Content-Type': guessType(f.name) }, fileSignal,
                        n => sent.inFlight(f.name, n));
                    sent.settle(f.name, sizeByName.get(f.name) ?? 0);
                });
            }
        } catch (err) {
            cancel.abort();
            throw err;
        }
        const loaded = sent.loaded();
        opts.onProgress?.({ phase: 'finalize', loaded, total, datasetId });
        const res = await this.#rawLong.POST('/v1/datasets/sessions/{dataset_id}/finalize', {
            params: { path: { dataset_id: datasetId }, header: { 'Idempotency-Key': idempotencyKey() } },
            signal: opts.signal
        });
        const body = unwrap(res) as { upload_id?: string };
        if (res.response.status === 202 && body.upload_id) {
            opts.onProgress?.({ phase: 'ingest', loaded, total, datasetId });
            await this.#waitIngest(body.upload_id, 'dataset ingest', opts.signal);
        }
    }

    async #putObject(url: string, body: Blob, what: string,
        remint: () => Promise<string | undefined>,
        headers: Record<string, string>,
        signal: AbortSignal | undefined,
        onBytes: (sentThisAttempt: number) => void): Promise<Response> {
        let lastFailure = '';
        let lastStatus: number | undefined;
        let lastResponse: Response | null = null;
        let lastClass: FailureClass = 'network-interrupted';
        let lastCause: unknown;
        let lastDetail: string | undefined;
        for (let attempt = 0; attempt < this.#retry.maxAttempts; attempt++) {
            if (attempt > 0) {
                await abortableSleep(delayFor(lastResponse, attempt - 1, this.#retry.backoff) * 1000,
                    signal);
                onBytes(0);
            }
            let put: Response;
            const guard = this.#stallTimeoutMs > 0 ? new StallGuard(this.#stallTimeoutMs, signal) : null;
            try {
                put = await this.#fetch(url, putInit(body, headers, guard?.signal ?? signal, (n) => {
                    guard?.kick();
                    onBytes(n);
                }));
            } catch (err) {
                if (signal?.aborted) throw err;
                lastFailure = fetchErrorText(err);
                lastResponse = null;
                lastCause = err;
                lastClass = classifyThrown(err);
                continue;
            } finally {
                guard?.stop();
            }
            if (put.ok) return put;
            lastFailure = `object store returned ${put.status}`;
            lastStatus = put.status;
            lastResponse = put;
            lastCause = undefined;
            lastClass = classifyStoreStatus(put.status);
            lastDetail = (await put.text().catch(() => '')).slice(0, 500) || undefined;
            if (put.status === 403) {
                url = (await remint()) ?? url;
                continue;
            }
            if (!PUT_RETRY_STATUS.has(put.status)) break;
        }
        throw new UploadError(`${what}: ${lastFailure}`, lastStatus, lastClass,
            { cause: lastCause, detail: lastDetail });
    }

    async #waitIngest(uploadId: string, what: string, signal?: AbortSignal): Promise<void> {
        const deadline = Date.now() + this.#ingestTimeoutMs;
        for (;;) {
            const st = unwrap(await this.#raw.GET('/v1/uploads/{upload_id}', {
                params: { path: { upload_id: uploadId } }, signal
            }));
            if (st.terminal) {
                if (st.status === 'committed') return;
                throw new UploadError(`${what} ${st.status}: ${st.detail ?? uploadId}`,
                    undefined, 'permanent');
            }
            if (Date.now() >= deadline) {
                throw new UploadError(
                    `${what} for ${uploadId} still ${st.status} after ${this.#ingestTimeoutMs}ms`,
                    undefined, 'deadline-exceeded');
            }
            await abortableSleep(this.#ingestPollMs, signal);
        }
    }
}

export { Client, optionsFromPolicy };
export type {
    ClientOptions,
    ClientPolicy,
    JobDatasetEvent,
    JobGpuEvent,
    JobPullProgress,
    TagOptions,
    Tags,
    Uploadable,
    UploadOptions,
    UploadProgress
};
