import { Client } from 'genesis-recon';

import {
    createSuperSplatKey,
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
    openSession,
    readCookie,
    sealSession,
    sessionCookieHeader,
    type SessionData
} from './session';

type Env = { GENESIS_BASE_URL: string; SESSION_SECRET: string };

const RECON_PREFIX = '/api/reconstruction';

const json = (payload: unknown, status = 200, headers: Record<string, string> = {}) => new Response(
    JSON.stringify(payload),
    {
        status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }
    }
);

const sessionOf = (request: Request, env: Env): Promise<SessionData | null> => {
    const token = readCookie(request, SESSION_COOKIE);
    return token ? openSession(token, env.SESSION_SECRET, Date.now()) : Promise.resolve(null);
};

const requireSession = async (request: Request, env: Env): Promise<SessionData> => {
    const session = await sessionOf(request, env);
    if (!session) {
        throw new HttpError(401, 'Open Reconstruction and sign in or enter an API key.',
            'authentication_required');
    }
    return session;
};

const secureFor = (request: Request): boolean => {
    const forwarded = String(request.headers.get('x-forwarded-proto') ?? '').split(',')[0].trim();
    return forwarded === 'https' || new URL(request.url).protocol === 'https:';
};

const accountOf = (data: SessionData) => ({ label: data.label, customerId: data.customerId });

const establish = async (request: Request, env: Env, data: SessionData,
    status = 200, extra: Record<string, unknown> = {}): Promise<Response> => {
    const token = await sealSession(data, env.SESSION_SECRET, Date.now());
    return json({ authenticated: true, account: accountOf(data), ...extra }, status, {
        'Set-Cookie': sessionCookieHeader(token, {
            secure: secureFor(request),
            maxAgeSeconds: Math.floor(SESSION_LIFETIME_MS / 1000)
        })
    });
};

const loginAndEstablish = async (request: Request, env: Env, email: string, password: string,
    status: number): Promise<Response> => {
    const accessToken = await passwordLogin(env.GENESIS_BASE_URL, email, password);
    const { apiKey, customerId } = await createSuperSplatKey(env.GENESIS_BASE_URL, accessToken);
    return establish(request, env, { apiKey, label: email, customerId }, status, { apiKey });
};

const bodyOf = async (request: Request): Promise<any> => await request.json().catch(() => ({})) ?? {};

const sessionRoute = async (request: Request, env: Env, rest: string): Promise<Response | null> => {
    if (rest === '' && request.method === 'GET') {
        const session = await requireSession(request, env);
        return json({ authenticated: true, account: accountOf(session) });
    }
    if (rest === '' && request.method === 'DELETE') {
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

const RUN_CACHE_TTL_MS = 60_000;

const runsCache = new Map<string, { runs: any; at: number }>();
const jobContexts = new Map<string, { datasetId: string }>();

const digestOf = async (value: string): Promise<string> => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest).slice(0, 8)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
};

const invalidateRuns = (datasetId: string): void => {
    for (const key of [...runsCache.keys()]) {
        if (key.endsWith(`:${datasetId}`)) runsCache.delete(key);
    }
};

const cachedRuns = async (gp: any, apiKey: string, datasetId: string): Promise<any> => {
    const key = `${await digestOf(apiKey)}:${datasetId}`;
    const hit = runsCache.get(key);
    if (hit && Date.now() - hit.at < RUN_CACHE_TTL_MS) return hit.runs;
    const runs = await gp.listRuns(datasetId);
    runsCache.set(key, { runs, at: Date.now() });
    return runs;
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
    const jobId = await gp.submitJob(pipeline, config, { idempotencyKey });
    invalidateRuns(datasetId);
    jobContexts.set(jobId, { datasetId });
    return json({ jobId, idempotencyKey }, 202);
};

const streamJobEvents = async (request: Request, env: Env, session: SessionData,
    jobId: string): Promise<Response> => {
    const lastEventId = request.headers.get('last-event-id');
    const upstream = await fetch(
        new URL(`/v1/jobs/${encodeURIComponent(jobId)}/stream`, env.GENESIS_BASE_URL),
        {
            headers: {
                Authorization: `Bearer ${session.apiKey}`,
                Accept: 'text/event-stream',
                ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {})
            },
            signal: request.signal
        }
    );

    const context = jobContexts.get(jobId);
    if (context) invalidateRuns(context.datasetId);
    return new Response(upstream.body, {
        status: upstream.status,
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive'
        }
    });
};

const reconRoute = async (request: Request, env: Env, pathname: string,
    search: URLSearchParams): Promise<Response | null> => {
    const session = await requireSession(request, env);
    const gp: any = new Client(env.GENESIS_BASE_URL, session.apiKey);
    const segments = segmentsOf(pathname);
    const [head, second, third, fourth, fifth] = segments;
    const { method } = request;

    if (head === 'health' && method === 'GET') {
        return json({ ok: true, baseUrl: gp.baseUrl, credits: await gp.getCreditBalance() });
    }
    if (head === 'credits' && method === 'GET') return json(await gp.getCreditBalance());
    if (head === 'pricing' && method === 'GET') return json(await gp.getPricingCatalog());

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
                run_counts: dataset.runs
            }))
        });
    }

    if (head === 'datasets' && second) {
        if (third === 'quote' && method === 'GET') {
            return json(await gp.quote(second, pipelineFor(search.get('pipeline'))));
        }
        if (third === 'runs' && !fourth && method === 'GET') {
            return json({
                dataset_id: second,
                runs: await cachedRuns(gp, session.apiKey, second)
            });
        }
        if (third === 'runs' && fourth && fifth && segments[5] === 'artifacts' && method === 'GET') {
            return json({ artifacts: await gp.listRunArtifacts(second, fourth, fifth) });
        }
        if (!third && method === 'DELETE') {
            await gp.deleteDataset(second);
            invalidateRuns(second);
            for (const [jobId, context] of [...jobContexts]) {
                if (context.datasetId === second) jobContexts.delete(jobId);
            }
            return new Response(null, { status: 204 });
        }
    }

    if (head === 'jobs') {
        if (!second && method === 'POST') return submitJob(request, gp);
        if (second && third === 'cancel' && method === 'POST') {
            await gp.cancelJob(second);
            return new Response(null, { status: 204 });
        }
        if (second && third === 'events' && method === 'GET') {
            return streamJobEvents(request, env, session, second);
        }
        if (second && !third && method === 'GET') {
            const job = await gp.getJob(second);
            const delivering = job.current_stage?.step === 'publish_results';
            const artifacts = job.terminal || delivering ?
                await gp.listArtifacts(second).catch((): any[] => []) :
                [];
            return json({ job, artifacts });
        }
    }

    return null;
};

/**
 * Resolves null only for paths outside /api/, An unknown /api/ path gets a JSON 404
 */
const handle = async (request: Request, env: Env): Promise<Response | null> => {
    const { pathname, searchParams } = new URL(request.url);
    if (!pathname.startsWith('/api/')) return null;
    try {
        if (pathname.startsWith(`${PROXY_PREFIX}/`)) {
            const session = await requireSession(request, env);
            return await proxyToGateway(request, session.apiKey, env.GENESIS_BASE_URL);
        }
        if (pathname === `${RECON_PREFIX}/session` ||
            pathname.startsWith(`${RECON_PREFIX}/session/`)) {
            const answered = await sessionRoute(request, env,
                pathname.slice(`${RECON_PREFIX}/session`.length));
            if (answered) return answered;
        } else if (pathname.startsWith(`${RECON_PREFIX}/`)) {
            const answered = await reconRoute(request, env, pathname, searchParams);
            if (answered) return answered;
        }
        return json({ error: 'Not found.', code: 'not_found' }, 404);
    } catch (error) {
        if (error instanceof ProxyDenied) {
            return json({ error: 'Proxy path not allowed.', code: 'proxy_path_denied' }, 404);
        }
        if (error instanceof HttpError) {
            return json({ error: error.message, code: error.code }, error.status);
        }
        return json({ error: String((error as Error)?.message ?? error), code: 'local_error' }, 500);
    }
};

export { type Env, handle, json, requireSession, sessionOf };
