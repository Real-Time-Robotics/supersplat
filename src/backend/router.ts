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
    newSessionId,
    readCookie,
    sessionCookieHeader
} from './session';

type SessionNamespace = {
    idFromName: (name: string) => unknown;
    get: (id: unknown) => { fetch: (request: Request) => Promise<Response> };
};

type Env = { GENESIS_BASE_URL: string; RECON_SESSIONS: SessionNamespace };

const RECON_PREFIX = '/api/reconstruction';

const json = (payload: unknown, status = 200, headers: Record<string, string> = {}) => new Response(
    JSON.stringify(payload),
    {
        status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }
    }
);

/** The object holding this browser's session, or null when it presented no cookie. */
const objectFor = (request: Request, env: Env) => {
    const id = readCookie(request, SESSION_COOKIE);
    if (!id) return null;
    if (!env.RECON_SESSIONS) {
        // Fail closed: without the binding nothing can be authenticated, and treating
        // that as "no session" would be indistinguishable from a working logged-out app.
        throw new HttpError(503, 'Session storage is unavailable.', 'sessions_unavailable');
    }
    return env.RECON_SESSIONS.get(env.RECON_SESSIONS.idFromName(id));
};

const askSession = (object: { fetch: (request: Request) => Promise<Response> },
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

const sessionOf = async (request: Request, env: Env): Promise<Credential | null> => {
    const object = objectFor(request, env);
    if (!object) return null;
    const answer = await askSession(object, '/credential');
    return answer.ok ? await answer.json() as Credential : null;
};

const expired = () => new HttpError(401,
    'Your session has ended. Sign in again to continue.', 'session_expired');

const requireSession = async (request: Request, env: Env): Promise<Credential> => {
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

/**
 * Mint a fresh id and hand the credentials to its object. A new login is always a new
 * session id, so a cookie from before it can never name this one.
 */
const establish = async (request: Request, env: Env, record: Record<string, unknown>,
    status = 200): Promise<Response> => {
    if (!env.RECON_SESSIONS) {
        throw new HttpError(503, 'Session storage is unavailable.', 'sessions_unavailable');
    }
    const id = newSessionId();
    const object = env.RECON_SESSIONS.get(env.RECON_SESSIONS.idFromName(id));
    const created = await askSession(object, '/create', record);
    const { account } = await created.json() as { account: Account };
    return json({ authenticated: true, account }, status, {
        'Set-Cookie': sessionCookieHeader(id, {
            secure: secureFor(request),
            maxAgeSeconds: Math.floor(SESSION_LIFETIME_MS / 1000)
        })
    });
};

const loginAndEstablish = async (request: Request, env: Env, email: string, password: string,
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

const bodyOf = async (request: Request): Promise<any> => await request.json().catch(() => ({})) ?? {};

const sessionRoute = async (request: Request, env: Env, rest: string): Promise<Response | null> => {
    if (rest === '' && request.method === 'GET') {
        const session = await requireSession(request, env);
        return json({ authenticated: true, account: session.account });
    }
    if (rest === '' && request.method === 'DELETE') {
        // Idempotent, and the object's state goes before the cookie is cleared: a
        // replayed cookie must find nothing, not a session it can still spend.
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
    return json({ jobId, idempotencyKey }, 202);
};

const streamJobEvents = async (request: Request, env: Env, session: Credential,
    jobId: string): Promise<Response> => {
    const lastEventId = request.headers.get('last-event-id');
    const upstream = await fetch(
        new URL(`/v1/jobs/${encodeURIComponent(jobId)}/stream`, env.GENESIS_BASE_URL),
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

const reconRoute = async (request: Request, env: Env, session: Credential,
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
        if (third === 'runs' && !fourth && method === 'GET') {
            return json({
                dataset_id: second,
                runs: await gp.listRuns(second)
            });
        }
        if (third === 'runs' && fourth && fifth && segments[5] === 'artifacts' && method === 'GET') {
            return json({ artifacts: await gp.listRunArtifacts(second, fourth, fifth) });
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

const isUnauthorized = (value: unknown): boolean => Number((value as any)?.status) === 401;

// Distinct from a route answering `null` (no such path), which must not trigger a renewal.
const REFUSED = Symbol('upstream refused the credential');

type Attempt = (attempt: Request, session: Credential) => Promise<Response | null>;

const attemptOnce = async (run: Attempt, request: Request,
    session: Credential): Promise<Response | null | typeof REFUSED> => {
    try {
        const answered = await run(request, session);
        return answered && isUnauthorized(answered) ? REFUSED : answered;
    } catch (error) {
        if (!isUnauthorized(error)) throw error;
        return REFUSED;
    }
};

/**
 * Run an authenticated route, and give an upstream rejection exactly one more chance:
 * renew the credential, replay once, and end the session if it is still refused. Anything
 * beyond one retry is a loop against a credential that is not coming back.
 */
const authenticated = async (request: Request, env: Env,
    run: Attempt): Promise<Response | null> => {
    const replay = request.method === 'GET' || request.method === 'HEAD' ?
        request : request.clone();
    const session = await requireSession(request, env);
    const first = await attemptOnce(run, request, session);
    if (first !== REFUSED) return first;

    const object = objectFor(request, env);
    const renewed = object ? await askSession(object, '/reauthenticate') : null;
    if (!renewed?.ok) throw expired();
    const second = await attemptOnce(run, replay, await renewed.json() as Credential);
    if (second !== REFUSED) return second;

    if (object) await askSession(object, '/destroy');
    throw expired();
};

/**
 * Resolves null only for paths outside /api/, An unknown /api/ path gets a JSON 404
 */
const handle = async (request: Request, env: Env): Promise<Response | null> => {
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
            // An ended session takes its cookie with it, so the browser stops presenting
            // an id that can only be refused.
            const headers = error.code === 'session_expired' ? {
                'Set-Cookie': sessionCookieHeader('', {
                    secure: secureFor(request), maxAgeSeconds: 0
                })
            } : {};
            return json({ error: error.message, code: error.code }, error.status, headers);
        }
        return json({ error: String((error as Error)?.message ?? error), code: 'local_error' }, 500);
    }
};

export { type Env, handle, json, requireSession, sessionOf };
