import { Client } from 'genesis-recon';

import {
    creditBalance,
    passwordLogin,
    registerUser,
    validateLogin,
    validateRegistration
} from './auth';
import { PROXY_PREFIX, ProxyDenied, proxyToGateway } from './gateway';
import { HttpError } from './http-error';
import { RECONSTRUCTION_PIPELINES, buildJobConfig, isValidRunName } from './jobs';
import {
    SESSION_COOKIE,
    SESSION_LIFETIME_MS,
    type Account,
    type Credential,
    isSessionId,
    newSessionId,
    readCookie,
    sessionCookieHeader
} from './session';

type SessionNamespace = Cloudflare.Env['RECON_SESSIONS'];
type SessionStub = ReturnType<SessionNamespace['get']>;

type BackendEnv = { GENESIS_BASE_URL: string; RECON_SESSIONS: SessionNamespace };

const RECON_PREFIX = '/api/reconstruction';
const MAX_JSON_BODY_BYTES = 256 * 1024;
const MAX_REPLAY_BODY_BYTES = 1024 * 1024;

const json = (payload: unknown, status = 200, headers: Record<string, string> = {}) => new Response(
    JSON.stringify(payload),
    {
        status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }
    }
);

const objectFor = (request: Request, env: BackendEnv) => {
    const id = readCookie(request, SESSION_COOKIE);
    if (!id || !isSessionId(id)) return null;
    if (!env.RECON_SESSIONS) {
        // Security: missing storage must not look like a logged-out session.
        throw new HttpError(503, 'Session storage is unavailable.', 'sessions_unavailable');
    }
    return env.RECON_SESSIONS.get(env.RECON_SESSIONS.idFromName(id));
};

const askSession = (object: SessionStub,
    path: string, body?: unknown): Promise<Response> => object.fetch(new Request(
    `https://session.invalid${path}`,
    body === undefined ?
        { method: 'POST' } :
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }
));

const expired = () => new HttpError(401,
    'Your session has ended. Sign in again to continue.', 'session_expired');

const requireSession = async (request: Request, env: BackendEnv): Promise<Credential> => {
    const object = objectFor(request, env);
    if (!object) {
        throw new HttpError(401, 'Open Reconstruction and sign in or enter an API key.',
            'authentication_required');
    }
    const answer = await askSession(object, '/credential');
    if (!answer.ok) throw expired();
    return await answer.json() as Credential;
};

const secureFor = (request: Request): boolean => {
    const forwarded = String(request.headers.get('x-forwarded-proto') ?? '').split(',')[0].trim();
    return forwarded === 'https' || new URL(request.url).protocol === 'https:';
};

const establish = async (request: Request, env: BackendEnv, record: Record<string, unknown>,
    status = 200): Promise<Response> => {
    if (!env.RECON_SESSIONS) {
        throw new HttpError(503, 'Session storage is unavailable.', 'sessions_unavailable');
    }
    const id = newSessionId();
    const object = env.RECON_SESSIONS.get(env.RECON_SESSIONS.idFromName(id));
    const created = await askSession(object, '/create', record);
    if (!created.ok) {
        throw new HttpError(503, 'Session storage is unavailable.', 'sessions_unavailable');
    }
    const { account } = await created.json() as { account: Account };
    return json({ authenticated: true, account }, status, {
        'Set-Cookie': sessionCookieHeader(id, {
            secure: secureFor(request),
            maxAgeSeconds: Math.floor(SESSION_LIFETIME_MS / 1000)
        })
    });
};

const loginAndEstablish = async (request: Request, env: BackendEnv, email: string, password: string,
    status: number): Promise<Response> => {
    const tokens = await passwordLogin(env.GENESIS_BASE_URL, email, password);
    const credits = await creditBalance(env.GENESIS_BASE_URL, tokens.accessToken)
    .catch((): null => null);
    return establish(request, env, {
        kind: 'oidc',
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
        label: email,
        customerId: credits?.customer_id || ''
    }, status);
};

const contentLength = (request: Request): number | null => {
    const header = request.headers.get('content-length');
    if (header === null) return null;
    if (!/^\d+$/.test(header)) throw new HttpError(400, 'Invalid Content-Length.', 'invalid_body');
    const length = Number(header);
    if (!Number.isSafeInteger(length)) {
        throw new HttpError(400, 'Invalid Content-Length.', 'invalid_body');
    }
    return length;
};

const readBoundedBody = async (request: Request, limit: number): Promise<Uint8Array> => {
    const declared = contentLength(request);
    if (declared !== null && declared > limit) {
        throw new HttpError(413, 'Request body is too large.', 'request_body_too_large');
    }
    if (!request.body) return new Uint8Array();

    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
            await reader.cancel().catch((): void => undefined);
            throw new HttpError(413, 'Request body is too large.', 'request_body_too_large');
        }
        chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return body;
};

const bodyOf = async (request: Request): Promise<Record<string, any>> => {
    const bytes = await readBoundedBody(request, MAX_JSON_BODY_BYTES);
    if (bytes.byteLength === 0) return {};
    let payload: unknown;
    try {
        payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        throw new HttpError(400, 'Request body must be valid JSON.', 'invalid_json');
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        throw new HttpError(400, 'Request body must be a JSON object.', 'invalid_json');
    }
    return payload as Record<string, any>;
};

const sessionRoute = async (request: Request, env: BackendEnv,
    rest: string): Promise<Response | null> => {
    if (rest === '' && request.method === 'GET') {
        const session = await requireSession(request, env);
        return json({ authenticated: true, account: session.account });
    }
    if (rest === '' && request.method === 'DELETE') {
        // Security: delete server state before clearing the cookie.
        const object = objectFor(request, env);
        if (object) await askSession(object, '/destroy');
        return new Response(null, {
            status: 204,
            headers: {
                'Set-Cookie': sessionCookieHeader('', {
                    secure: secureFor(request),
                    maxAgeSeconds: 0
                })
            }
        });
    }
    if (rest === '/api-key' && request.method === 'POST') {
        const apiKey = String((await bodyOf(request)).apiKey || '').trim();
        if (!apiKey.startsWith('gp_live_')) {
            throw new HttpError(400,
                'Enter a valid Genesis API key beginning with gp_live_.', 'invalid_api_key');
        }
        const credits = await creditBalance(env.GENESIS_BASE_URL, apiKey);
        return establish(request, env, {
            kind: 'api-key',
            apiKey,
            label: credits?.customer_id ? `Customer ${credits.customer_id}` : 'API key user',
            customerId: credits?.customer_id || ''
        });
    }
    if (rest === '/login' && request.method === 'POST') {
        const body = await bodyOf(request);
        const email = String(body.email || '').trim();
        const password = String(body.password || '');
        validateLogin(email, password);
        return loginAndEstablish(request, env, email, password, 200);
    }
    if (rest === '/register' && request.method === 'POST') {
        const body = await bodyOf(request);
        const input = {
            firstName: String(body.firstName || '').trim(),
            lastName: String(body.lastName || '').trim(),
            email: String(body.email || '').trim(),
            password: String(body.password || ''),
            confirmPassword: String(body.confirmPassword || '')
        };
        validateRegistration(input);
        await registerUser(env.GENESIS_BASE_URL, input);
        return loginAndEstablish(request, env, input.email, input.password, 201);
    }
    return null;
};

const pipelineFor = (value: string | null, fallback = 'splat'): string => {
    const pipeline = String(value || fallback);
    if (!RECONSTRUCTION_PIPELINES.has(pipeline)) {
        throw new HttpError(400, `Unsupported reconstruction pipeline: ${pipeline}`,
            'invalid_pipeline');
    }
    return pipeline;
};

const runNameFieldFor = async (gp: any, pipeline: string): Promise<string> => {
    const info = (await gp.listPipelines()).find((entry: any) => entry.name === pipeline);
    if (!info?.run_name_field) {
        throw new HttpError(502, `Genesis did not say where ${pipeline} keeps its run name.`,
            'run_name_field_unknown');
    }
    return info.run_name_field;
};

const segmentsOf = (pathname: string): string[] => pathname.slice(RECON_PREFIX.length + 1).split('/').map(decodeURIComponent);

/** The display name out of a request body. The gateway does the trimming and capping. */
const labelOf = (body: any): string => String(body?.label ?? '');

const submitJob = async (request: Request, gp: any): Promise<Response> => {
    const body = await bodyOf(request);
    const datasetId = String(body.datasetId || '');
    if (!datasetId) return json({ error: 'Thiếu datasetId.' }, 400);
    const pipeline = pipelineFor(body.pipeline);
    const preset = String(body.preset || 'standard');
    const runName = String(body.runName || preset);
    if (!isValidRunName(runName)) {
        throw new HttpError(400, `Tên lần chạy không hợp lệ: ${runName}`, 'invalid_run_name');
    }
    const [presetConfig, runNameField] = await Promise.all([
        gp.getPreset(pipeline, preset),
        runNameFieldFor(gp, pipeline)
    ]);
    const config = buildJobConfig({ presetConfig, pipeline, datasetId, runNameField, runName });
    const idempotencyKey = String(body.idempotencyKey || crypto.randomUUID());
    // `label` is what the user calls the run; `runName` is where it lands on the store.
    const jobId = await gp.submitJob(pipeline, config,
        { idempotencyKey, label: labelOf(body) || undefined });
    return json({ jobId, idempotencyKey }, 202);
};

const STREAM_KINDS = new Set(['log', 'stage', 'progress', 'gpu', 'artifact', 'dataset', 'end']);

const streamJobEvents = async (request: Request, env: BackendEnv, session: Credential,
    jobId: string, search: URLSearchParams): Promise<Response> => {
    const lastEventId = request.headers.get('last-event-id');
    const kinds = (search.get('events') || '').split(',').filter(k => STREAM_KINDS.has(k));
    const url = new URL(`/v1/jobs/${encodeURIComponent(jobId)}/stream`, env.GENESIS_BASE_URL);
    if (kinds.length) url.searchParams.set('events', kinds.join(','));
    const upstream = await fetch(
        url,
        {
            headers: {
                Authorization: `Bearer ${session.token}`,
                Accept: 'text/event-stream',
                ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {})
            },
            signal: request.signal
        }
    );

    return new Response(upstream.body, {
        status: upstream.status,
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive'
        }
    });
};

const reconRoute = async (request: Request, env: BackendEnv, session: Credential,
    pathname: string, search: URLSearchParams): Promise<Response | null> => {
    const gp: any = new Client(env.GENESIS_BASE_URL, session.token);
    const segments = segmentsOf(pathname);
    const [head, second, third, fourth, fifth] = segments;
    const { method } = request;

    if (head === 'health' && method === 'GET') {
        return json({ ok: true, baseUrl: gp.baseUrl, credits: await gp.getCreditBalance() });
    }
    if (head === 'credits' && method === 'GET') return json(await gp.getCreditBalance());
    if (head === 'pricing' && method === 'GET') return json(await gp.getPricingCatalog());

    if (head === 'estimate' && method === 'POST') {
        const body = await bodyOf(request);
        const nImages = Number(body.nImages);
        if (!Number.isInteger(nImages) || nImages < 1) {
            return json({ error: 'nImages phải là số ảnh lớn hơn 0.' }, 400);
        }
        const totalPixels = body.totalPixels == null ? undefined : Number(body.totalPixels);
        return json(await gp.estimate(nImages, pipelineFor(body.pipeline), { totalPixels }));
    }

    if (head === 'checkout' && method === 'POST') {
        const body = await bodyOf(request);
        const packCredits = body.packCredits == null ? undefined : Number(body.packCredits);
        const customCredits = body.customCredits == null ? undefined : Number(body.customCredits);
        if ((packCredits == null) === (customCredits == null)) {
            return json({ error: 'Hãy chọn đúng một gói hoặc nhập số credit tùy chỉnh.' }, 400);
        }
        const amount = packCredits != null ? { packCredits } : { customCredits };
        return json(await gp.createCheckout({ ...amount, client: 'web' }));
    }
    if (head === 'checkouts' && second && method === 'GET') {
        return json(await gp.getCheckout(second));
    }

    if (head === 'runs' && method === 'GET') {
        const limit = Math.min(50, Math.max(1, Number(search.get('limit')) || 12));
        const envelope = await gp.listDatasets({ limit });
        const datasets = envelope.datasets || envelope.rows || [];
        return json({
            datasets: datasets.map((dataset: any) => ({
                dataset_id: dataset.dataset_id,
                label: dataset.label,
                image_count: dataset.image_count,
                bytes: dataset.bytes,
                created: dataset.created,
                run_counts: dataset.runs,
                model_counts: dataset.models || {}
            }))
        });
    }

    if (head === 'datasets' && second) {
        if (third === 'quote' && method === 'GET') {
            return json(await gp.quote(second, pipelineFor(search.get('pipeline'))));
        }
        if (third === 'runs') {
            if (!fourth && method === 'GET') {
                return json({
                    dataset_id: second,
                    runs: await gp.listRuns(second)
                });
            }
            // One place to validate the pipeline segment, so no run route can forget to.
            const [pipeline, runName] = fourth && fifth ?
                [pipelineFor(fourth), fifth] : [null, null];
            if (pipeline && runName) {
                if (!segments[5] && method === 'DELETE') {
                    await gp.deleteRun(second, pipeline, runName);
                    return new Response(null, { status: 204 });
                }
                if (segments[5] === 'artifacts') {
                    if (!segments[6] && method === 'GET') {
                        return json({
                            artifacts: await gp.listRunArtifacts(second, pipeline, runName)
                        });
                    }
                    if (segments[6] && method === 'DELETE') {
                        await gp.deleteRunArtifact(second, pipeline, runName, segments[6]);
                        return new Response(null, { status: 204 });
                    }
                }
            }
        }
        if (!third && method === 'PUT') {
            return json({ label: await gp.setDatasetLabel(second, labelOf(await bodyOf(request))) });
        }
        if (!third && method === 'DELETE') {
            await gp.deleteDataset(second);
            return new Response(null, { status: 204 });
        }
    }

    if (head === 'jobs') {
        if (!second && method === 'POST') return submitJob(request, gp);
        if (second && third === 'cancel' && method === 'POST') {
            await gp.cancelJob(second);
            return new Response(null, { status: 204 });
        }
        if (second && third === 'label' && method === 'PUT') {
            return json({ label: await gp.setJobLabel(second, labelOf(await bodyOf(request))) });
        }
        if (second && third === 'events' && method === 'GET') {
            return streamJobEvents(request, env, session, second, search);
        }
        if (second && third === 'artifacts' && fourth && method === 'DELETE') {
            await gp.deleteArtifact(second, fourth);
            return new Response(null, { status: 204 });
        }
        if (second && !third && method === 'GET') {
            const job = await gp.getJob(second);
            const delivering = job.current_stage?.step === 'publish_results';
            const artifacts = job.terminal || delivering ?
                await gp.listArtifacts(second).catch((): any[] => []) :
                [];
            return json({ job, artifacts });
        }
        if (second && !third && method === 'DELETE') {
            await gp.deleteJob(second);
            return new Response(null, { status: 204 });
        }
    }

    return null;
};

const isUnauthorized = (value: unknown): boolean => Number((value as any)?.status) === 401;

const REFUSED = Symbol('upstream refused the credential');

type Attempt = (attempt: Request, session: Credential) => Promise<Response | null>;

const attemptOnce = async (run: Attempt, request: Request,
    session: Credential): Promise<Response | null | typeof REFUSED> => {
    try {
        const answered = await run(request, session);
        if (answered && isUnauthorized(answered)) {
            await answered.body?.cancel().catch((): void => undefined);
            return REFUSED;
        }
        return answered;
    } catch (error) {
        if (!isUnauthorized(error)) throw error;
        return REFUSED;
    }
};

const requestWithBody = (request: Request, body: Uint8Array): Request => {
    const buffer = body.buffer.slice(
        body.byteOffset, body.byteOffset + body.byteLength
    ) as ArrayBuffer;
    return new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: buffer,
        redirect: request.redirect,
        signal: request.signal
    });
};

const replayPair = async (request: Request): Promise<{
    first: Request;
    replay: Request | null;
}> => {
    if (request.method === 'GET' || request.method === 'HEAD' || !request.body) {
        return { first: request, replay: request };
    }
    const declared = contentLength(request);
    const jsonBody = request.headers.get('content-type')?.toLowerCase()
    .startsWith('application/json') ?? false;
    if ((declared === null && !jsonBody) || (declared !== null && declared > MAX_REPLAY_BODY_BYTES)) {
        return { first: request, replay: null };
    }
    const body = await readBoundedBody(request, MAX_REPLAY_BODY_BYTES);
    return {
        first: requestWithBody(request, body),
        replay: requestWithBody(request, body.slice())
    };
};

const authenticated = async (request: Request, env: BackendEnv,
    run: Attempt): Promise<Response | null> => {
    const session = await requireSession(request, env);
    const { first: firstRequest, replay } = await replayPair(request);
    const first = await attemptOnce(run, firstRequest, session);
    if (first !== REFUSED) return first;

    const object = objectFor(request, env);
    const renewed = object ? await askSession(object, '/reauthenticate') : null;
    if (!renewed?.ok) throw expired();
    if (!replay) {
        throw new HttpError(409,
            'Your credential was renewed; retry this request.',
            'credential_refreshed_retry_required');
    }
    const second = await attemptOnce(run, replay, await renewed.json() as Credential);
    if (second !== REFUSED) return second;

    if (object) await askSession(object, '/destroy');
    throw expired();
};

const handle = async (request: Request, env: BackendEnv): Promise<Response | null> => {
    const { pathname, searchParams } = new URL(request.url);
    if (!pathname.startsWith('/api/')) return null;
    try {
        if (pathname.startsWith(`${PROXY_PREFIX}/`)) {
            return await authenticated(request, env, (attempt, session) => proxyToGateway(attempt, session.token, env.GENESIS_BASE_URL));
        }
        if (pathname === `${RECON_PREFIX}/session` ||
            pathname.startsWith(`${RECON_PREFIX}/session/`)) {
            const answered = await sessionRoute(request, env,
                pathname.slice(`${RECON_PREFIX}/session`.length));
            if (answered) return answered;
        } else if (pathname.startsWith(`${RECON_PREFIX}/`)) {
            const answered = await authenticated(request, env, (attempt, session) => reconRoute(attempt, env, session, pathname, searchParams));
            if (answered) return answered;
        }
        return json({ error: 'Not found.', code: 'not_found' }, 404);
    } catch (error) {
        if (error instanceof ProxyDenied) {
            return json({ error: 'Proxy path not allowed.', code: 'proxy_path_denied' }, 404);
        }
        if (error instanceof HttpError) {
            const headers: Record<string, string> = error.code === 'session_expired' ? {
                'Set-Cookie': sessionCookieHeader('', {
                    secure: secureFor(request), maxAgeSeconds: 0
                })
            } : {};
            return json({ error: error.message, code: error.code }, error.status, headers);
        }
        return json({ error: String((error as Error)?.message ?? error), code: 'local_error' }, 500);
    }
};

export { type BackendEnv, handle, json, requireSession };
