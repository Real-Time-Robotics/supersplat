import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, openAsBlob } from 'node:fs';
import { mkdir, open as openFile, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import express from 'express';
import multer from 'multer';
import { ApiError, Client } from 'genesis-recon';

import { currentLogPath, errorSummary, initLogging, instrumentFetch, logger } from './server-log.mjs';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(rootDir, '.server-uploads');
const artifactCacheDir = path.join(rootDir, '.artifact-cache');
const logDir = path.join(rootDir, '.server-logs');
const envPath = path.join(rootDir, '.env.local');

const parseEnv = (text) => Object.fromEntries(
    text.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
        const split = line.indexOf('=');
        return [line.slice(0, split).trim(), line.slice(split + 1).trim().replace(/^['"]|['"]$/g, '')];
    })
);

let localEnv = {};
try {
    localEnv = parseEnv(await readFile(envPath, 'utf8'));
} catch {
    // Environment variables are also supported, so a local file is optional.
}

const baseUrl = process.env.GENESIS_BASE_URL || localEnv.GENESIS_BASE_URL || 'https://recons.rtrobotics.com';
const port = Number(process.env.PORT || localEnv.PORT || 3000);
const sessionCookie = 'genesis_reconstruction_session';
const sessionLifetimeMs = 7 * 24 * 60 * 60 * 1000;

await Promise.all([
    mkdir(uploadDir, { recursive: true }),
    mkdir(artifactCacheDir, { recursive: true }),
    initLogging(logDir)
]);

// A rejection nobody awaited is the normal shape of a failure inside the SDK's
// parallel upload fan-out: once one presigned PUT rejects, the siblings still in
// flight resolve into nothing. Without this they vanish silently.
process.on('unhandledRejection', (reason) => {
    logger.fail('process.unhandled_rejection', reason);
});
process.on('uncaughtException', (error) => {
    logger.fail('process.uncaught_exception', error);
});

const app = express();
const jobContexts = new Map();
const uploadChannels = new Map();
const sessions = new Map();
const upload = multer({
    dest: uploadDir,
    limits: {
        files: 2000,
        fileSize: 1024 * 1024 * 1024
    }
});

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const asyncRoute = (handler) => (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
};

class HttpError extends Error {
    constructor(status, message, code = 'local_error') {
        super(message);
        this.status = status;
        this.code = code;
    }
}

const reconstructionPipelines = new Set(['splat', 'photogrammetry']);
const pipelineFor = (value, fallback = 'splat') => {
    const pipeline = String(value || fallback);
    if (!reconstructionPipelines.has(pipeline)) {
        throw new HttpError(400, `Unsupported reconstruction pipeline: ${pipeline}`, 'invalid_pipeline');
    }
    return pipeline;
};

const photogrammetryUploadOverrides = {
    run_downscale: true,
    run_feature: true,
    run_matching: true,
    run_mapper: true,
    run_sor: true,
    downscale_factor: 4,
    image_subdir: 'images_4',
    sparse_subdir: 'sparse/0_geo',
    geo_register: true,
    run_georef: true,
    run_ortho: true,
    run_name: 'standard'
};

const cookiesFor = req => Object.fromEntries(
    String(req.headers.cookie || '')
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map((part) => {
        const split = part.indexOf('=');
        if (split < 0) return [part, ''];
        return [part.slice(0, split), decodeURIComponent(part.slice(split + 1))];
    })
);

const sessionFor = (req) => {
    const id = cookiesFor(req)[sessionCookie];
    const session = id ? sessions.get(id) : null;
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
        sessions.delete(id);
        return null;
    }
    session.expiresAt = Date.now() + sessionLifetimeMs;
    return session;
};

const requireSession = (req) => {
    const session = sessionFor(req);
    if (!session) throw new HttpError(401, 'Open Reconstruction and sign in or enter an API key.', 'authentication_required');
    return session;
};

const gatewayOrigin = (() => {
    try {
        return new URL(baseUrl).origin;
    } catch {
        return '';
    }
})();

// Every Client gets an instrumented fetch. This is the only seam that sees BOTH
// the gateway's JSON calls and the presigned PUTs the SDK sends straight to the
// object store -- the latter bypass this server's routes entirely, so without
// this wrapper an upload that dies at 89% leaves no trace here at all.
const makeClient = (apiKey, context = {}) => new Client(baseUrl, apiKey, {
    fetch: instrumentFetch(globalThis.fetch.bind(globalThis), { gatewayOrigin, context })
});

const clientFor = req => makeClient(requireSession(req).apiKey);

const cookieAttributes = (req, maxAge) => {
    const attributes = [
        `${sessionCookie}=`,
        'HttpOnly',
        'SameSite=Strict',
        'Path=/',
        `Max-Age=${maxAge}`
    ];
    const forwardedProtocol = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    if (req.secure || forwardedProtocol === 'https') attributes.push('Secure');
    return attributes;
};

const establishSession = (req, res, apiKey, account = {}) => {
    const id = randomUUID();
    const session = {
        id,
        apiKey,
        account: {
            label: String(account.label || 'API key user'),
            customerId: String(account.customerId || '')
        },
        expiresAt: Date.now() + sessionLifetimeMs
    };
    sessions.set(id, session);
    const attributes = cookieAttributes(req, Math.floor(sessionLifetimeMs / 1000));
    attributes[0] = `${sessionCookie}=${encodeURIComponent(id)}`;
    res.setHeader('Set-Cookie', attributes.join('; '));
    return session;
};

const clearSession = (req, res) => {
    const id = cookiesFor(req)[sessionCookie];
    if (id) sessions.delete(id);
    res.setHeader('Set-Cookie', cookieAttributes(req, 0).join('; '));
};

const errorDetail = (payload, fallback) => {
    const detail = payload?.detail ?? payload?.error_description ?? payload?.error ?? fallback;
    if (typeof detail === 'string') return detail;
    if (detail && typeof detail.message === 'string') return detail.message;
    return fallback;
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const validateLogin = (email, password) => {
    if (!emailPattern.test(email) || email.length > 255) {
        throw new HttpError(400, 'Enter a valid email address.', 'invalid_email');
    }
    if (!password || password.length > 256) {
        throw new HttpError(400, 'Enter your password.', 'invalid_password');
    }
};

const validateRegistration = ({ firstName, lastName, email, password, confirmPassword }) => {
    validateLogin(email, password);
    if (!firstName || firstName.length > 100) {
        throw new HttpError(400, 'First Name is required.', 'invalid_first_name');
    }
    if (!lastName || lastName.length > 100) {
        throw new HttpError(400, 'Last Name is required.', 'invalid_last_name');
    }
    if (password.length < 6) {
        throw new HttpError(400, 'Password must contain at least 6 characters.', 'password_too_short');
    }
    if (!confirmPassword || password !== confirmPassword) {
        throw new HttpError(400, 'Passwords do not match.', 'password_mismatch');
    }
};

const gatewayJson = async (pathname, init = {}) => {
    const response = await fetch(new URL(pathname, `${baseUrl.replace(/\/$/, '')}/`), init);
    const payload = response.status === 204
        ? null
        : await response.json().catch(() => null);
    if (!response.ok) {
        throw new HttpError(
            response.status,
            errorDetail(payload, `Genesis API returned ${response.status}.`),
            payload?.code || 'gateway_error'
        );
    }
    return payload;
};

const passwordLogin = async (email, password) => {
    const config = await gatewayJson('/v1/config');
    const issuer = String(config?.oidc_issuer || '').replace(/\/$/, '');
    const clientId = String(config?.oidc_client_id || '');
    if (!issuer || !clientId) {
        throw new HttpError(503, 'Genesis authentication is not configured.', 'auth_not_configured');
    }
    const body = new URLSearchParams({
        grant_type: 'password',
        client_id: clientId,
        username: email,
        password,
        scope: 'openid'
    });
    const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.access_token) {
        throw new HttpError(
            response.status === 400 || response.status === 401 ? 401 : response.status,
            errorDetail(payload, 'Email or password is incorrect.'),
            'login_failed'
        );
    }
    return payload.access_token;
};

const createSuperSplatKey = async (accessToken) => {
    const headers = { Authorization: `Bearer ${accessToken}` };
    const listed = await gatewayJson('/v1/api-keys', { headers });
    const keys = Array.isArray(listed) ? listed : (listed?.api_keys || listed?.keys || []);
    const existing = keys.filter(key => key?.name === 'SuperSplat Reconstruction' && !key?.revoked_at);
    await Promise.all(existing.map(key => gatewayJson(`/v1/api-keys/${encodeURIComponent(key.id)}`, {
        method: 'DELETE',
        headers
    })));
    const created = await gatewayJson('/v1/api-keys', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'SuperSplat Reconstruction' })
    });
    const apiKey = created?.key || created?.api_key;
    if (!apiKey) throw new HttpError(502, 'Genesis did not return the newly created API key.', 'missing_api_key');
    return { apiKey, customerId: created?.customer_id || '' };
};

const loginAndCreateSession = async (req, res, email, password) => {
    const accessToken = await passwordLogin(email, password);
    const { apiKey, customerId } = await createSuperSplatKey(accessToken);
    const session = establishSession(req, res, apiKey, { label: email, customerId });
    return { session, apiKey };
};

const normalizeName = (name, index) => {
    const cleaned = String(name || `image-${index}.jpg`)
    .replaceAll('\\', '/')
    .split('/')
    .filter(Boolean)
    .join('__')
    .replace(/[^a-zA-Z0-9._-]/g, '_');
    return cleaned || `image-${index}.jpg`;
};

const runCacheScope = (datasetId, pipeline, runName, created) =>
    ['run', datasetId, pipeline, runName, String(created)];

const artifactCachePath = (scope, artifactName) => {
    const digest = createHash('sha256')
    .update(JSON.stringify([...scope, artifactName]))
    .digest('hex')
    .slice(0, 24);
    const basename = path.basename(artifactName)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(-120) || 'artifact';
    return path.join(artifactCacheDir, `${digest}-${basename}`);
};

const cachedArtifact = async (scope, artifact) => {
    const cachePath = artifactCachePath(scope, artifact.name);
    try {
        const entry = await stat(cachePath);
        if (!entry.isFile() || (artifact.size > 0 && entry.size !== artifact.size)) {
            await rm(cachePath, { force: true });
            return null;
        }
        return { path: cachePath, size: entry.size };
    } catch {
        return null;
    }
};

const artifactsWithCacheStatus = async (scope, artifacts) => Promise.all(
    artifacts.map(async artifact => ({
        ...artifact,
        local: Boolean(await cachedArtifact(scope, artifact))
    }))
);

const datasetArtifactCachePaths = async (gp, datasetId) => {
    const cachePaths = new Set();
    const runs = await gp.listRuns(datasetId).catch(() => []);
    await Promise.all(runs.map(async (run) => {
        const artifacts = await gp.listRunArtifacts(datasetId, run.pipeline, run.run_name).catch(() => []);
        const scope = runCacheScope(datasetId, run.pipeline, run.run_name, run.created);
        artifacts.forEach(artifact => cachePaths.add(artifactCachePath(scope, artifact.name)));
    }));
    await Promise.all([...jobContexts.entries()]
    .filter(([, context]) => context.datasetId === datasetId)
    .map(async ([jobId, context]) => {
        const artifacts = await gp.listArtifacts(jobId).catch(() => []);
        const scopes = [['job', jobId]];
        if (context.created != null) {
            scopes.push(runCacheScope(
                datasetId,
                context.pipeline,
                context.runName,
                context.created
            ));
        }
        artifacts.forEach(artifact => {
            scopes.forEach(scope => cachePaths.add(artifactCachePath(scope, artifact.name)));
        });
    }));
    return [...cachePaths];
};

const resolveJobCacheScope = async (gp, jobId, job) => {
    const context = jobContexts.get(jobId);
    if (!context) return ['job', jobId];
    if ((job?.terminal || job == null) && context.created == null) {
        const runs = await gp.listRuns(context.datasetId).catch(() => []);
        const run = runs
        .filter(item => {
            const created = item.created < 1e12 ? item.created : item.created / 1000;
            return item.pipeline === context.pipeline &&
                item.run_name === context.runName &&
                created >= context.submittedAt - 60;
        })
        .sort((a, b) => b.created - a.created)[0];
        if (run) context.created = run.created;
    }
    return context.created == null
        ? ['job', jobId]
        : runCacheScope(context.datasetId, context.pipeline, context.runName, context.created);
};

const writeResponseChunk = (res, chunk) => new Promise((resolve, reject) => {
    if (res.destroyed) {
        reject(new Error('Client disconnected'));
        return;
    }
    if (res.write(chunk)) {
        resolve();
        return;
    }
    const cleanup = () => {
        res.off('drain', onDrain);
        res.off('close', onClose);
        res.off('error', onError);
    };
    const onDrain = () => {
        cleanup();
        resolve();
    };
    const onClose = () => {
        cleanup();
        reject(new Error('Client disconnected'));
    };
    const onError = (error) => {
        cleanup();
        reject(error);
    };
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
});

const contentTypeFor = (filename) => {
    const extension = path.extname(filename).toLowerCase();
    const contentTypes = {
        '.json': 'application/json',
        '.glb': 'model/gltf-binary',
        '.gltf': 'model/gltf+json',
        '.ksplat': 'application/x-gaussian-splat',
        '.obj': 'model/obj',
        '.ply': 'application/ply',
        '.spz': 'application/x-gaussian-splat',
        '.splat': 'application/x-gaussian-splat',
        '.sog': 'application/x-gaussian-splat',
        '.zip': 'application/zip'
    };
    return contentTypes[extension] || 'application/octet-stream';
};

const sendArtifact = async (res, scope, artifact, getRemoteStream) => {
    const filename = path.basename(artifact.name).replace(/[^a-zA-Z0-9._-]/g, '_');
    const cached = await cachedArtifact(scope, artifact);
    res.setHeader('Content-Type', contentTypeFor(filename));
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    const contentLength = cached?.size ?? Number(artifact.size);
    if (Number.isFinite(contentLength) && contentLength >= 0) {
        res.setHeader('Content-Length', String(contentLength));
    }
    res.setHeader('X-Artifact-Local', String(Boolean(cached)));
    res.setHeader('Cache-Control', 'no-store');
    if (cached) {
        await new Promise((resolve, reject) => {
            const source = createReadStream(cached.path);
            const cleanup = () => {
                source.off('error', onError);
                res.off('error', onError);
                res.off('finish', onFinish);
                res.off('close', onClose);
            };
            const onError = (error) => {
                cleanup();
                reject(error);
            };
            const onFinish = () => {
                cleanup();
                resolve();
            };
            const onClose = () => {
                cleanup();
                source.destroy();
                resolve();
            };
            source.on('error', onError);
            res.on('error', onError);
            res.on('finish', onFinish);
            res.on('close', onClose);
            source.pipe(res);
        });
        return;
    }

    const finalPath = artifactCachePath(scope, artifact.name);
    const partialPath = `${finalPath}.${randomUUID()}.part`;
    const file = await openFile(partialPath, 'wx');
    let complete = false;
    try {
        const stream = Readable.fromWeb(await getRemoteStream());
        for await (const chunk of stream) {
            await file.write(chunk);
            await writeResponseChunk(res, chunk);
        }
        await file.close();
        await rename(partialPath, finalPath);
        complete = true;
        res.end();
    } catch (error) {
        if (!res.destroyed) throw error;
    } finally {
        if (!complete) {
            await file.close().catch(() => undefined);
            await rm(partialPath, { force: true }).catch(() => undefined);
        }
    }
};

const channelFor = (id, sessionId = null) => {
    let channel = uploadChannels.get(id);
    if (!channel) {
        channel = {
            sessionId,
            clients: new Set(),
            latest: null,
            cleanupTimer: null
        };
        uploadChannels.set(id, channel);
    }
    if (sessionId && channel.sessionId && channel.sessionId !== sessionId) {
        throw new HttpError(404, 'Upload operation not found.', 'upload_not_found');
    }
    if (sessionId && !channel.sessionId) channel.sessionId = sessionId;
    return channel;
};

const UPLOAD_RESUME_ATTEMPTS = 4;
const UPLOAD_RESUME_DELAYS_MS = [5_000, 15_000, 30_000];

const isResumableUploadError = (error) => {
    if (error?.name === 'AbortError') return false;
    const status = typeof error?.status === 'number' ? error.status : null;
    if (status === null) return true;
    return status === 429 || status >= 500;
};

const sleepUnlessAborted = (ms, signal) => new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
});

const uploadWithResume = async (gp, uploadables, opts) => {
    for (let attempt = 0; ; attempt++) {
        try {
            return await gp.uploadDataset(uploadables, {
                label: opts.label,
                signal: opts.signal,
                onProgress: opts.onProgress,
                datasetId: opts.getResumeId() ?? undefined
            });
        } catch (error) {
            const last = attempt >= UPLOAD_RESUME_ATTEMPTS - 1;
            if (opts.signal?.aborted || last) throw error;
            if (error?.status === 404 && opts.getResumeId()) opts.clearResumeId();
            else if (!isResumableUploadError(error)) throw error;
            const delay = UPLOAD_RESUME_DELAYS_MS[attempt] ?? 30_000;
            logger.warn('upload.resuming', {
                operationId: opts.operationId,
                attempt: attempt + 1,
                resumeId: opts.getResumeId(),
                retryInMs: delay,
                summary: errorSummary(error),
                ...opts.stats()
            });
            await sleepUnlessAborted(delay, opts.signal);
        }
    }
};

const publishUploadEvent = (id, event, data) => {
    const channel = channelFor(id);
    channel.latest = { event, data };
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    channel.clients.forEach(client => client.write(frame));
    if (event === 'end' || event === 'failed') {
        channel.clients.forEach(client => client.end());
        channel.clients.clear();
        clearTimeout(channel.cleanupTimer);
        channel.cleanupTimer = setTimeout(() => uploadChannels.delete(id), 30_000);
    }
};

app.get('/api/reconstruction/session', asyncRoute(async (req, res) => {
    const session = requireSession(req);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ authenticated: true, account: session.account });
}));

app.post('/api/reconstruction/session/api-key', asyncRoute(async (req, res) => {
    const apiKey = String(req.body.apiKey || '').trim();
    if (!apiKey.startsWith('gp_live_')) {
        throw new HttpError(400, 'Enter a valid Genesis API key beginning with gp_live_.', 'invalid_api_key');
    }
    const gp = makeClient(apiKey);
    const credits = await gp.getCreditBalance();
    const session = establishSession(req, res, apiKey, {
        label: credits?.customer_id ? `Customer ${credits.customer_id}` : 'API key user',
        customerId: credits?.customer_id || ''
    });
    res.json({ authenticated: true, account: session.account });
}));

app.post('/api/reconstruction/session/login', asyncRoute(async (req, res) => {
    const email = String(req.body.email || '').trim();
    const password = String(req.body.password || '');
    validateLogin(email, password);
    const { session, apiKey } = await loginAndCreateSession(req, res, email, password);
    res.json({ authenticated: true, account: session.account, apiKey });
}));

app.post('/api/reconstruction/session/register', asyncRoute(async (req, res) => {
    const firstName = String(req.body.firstName || '').trim();
    const lastName = String(req.body.lastName || '').trim();
    const email = String(req.body.email || '').trim();
    const password = String(req.body.password || '');
    const confirmPassword = String(req.body.confirmPassword || '');
    validateRegistration({ firstName, lastName, email, password, confirmPassword });
    await gatewayJson('/v1/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            first_name: firstName,
            last_name: lastName,
            email,
            password
        })
    });
    const { session, apiKey } = await loginAndCreateSession(req, res, email, password);
    res.status(201).json({ authenticated: true, account: session.account, apiKey });
}));

app.delete('/api/reconstruction/session', (req, res) => {
    clearSession(req, res);
    res.status(204).end();
});

app.get('/api/reconstruction/health', asyncRoute(async (req, res) => {
    const gp = clientFor(req);
    const credits = await gp.getCreditBalance();
    res.json({ ok: true, baseUrl: gp.baseUrl, credits });
}));

app.get('/api/reconstruction/credits', asyncRoute(async (req, res) => {
    const gp = clientFor(req);
    res.json(await gp.getCreditBalance());
}));

app.get('/api/reconstruction/pricing', asyncRoute(async (req, res) => {
    const gp = clientFor(req);
    res.json(await gp.getPricingCatalog());
}));

app.post('/api/reconstruction/checkout', asyncRoute(async (req, res) => {
    const gp = clientFor(req);
    const packCredits = req.body.packCredits == null ? undefined : Number(req.body.packCredits);
    const customCredits = req.body.customCredits == null ? undefined : Number(req.body.customCredits);
    if ((packCredits == null) === (customCredits == null)) {
        res.status(400).json({ error: 'Hãy chọn đúng một gói hoặc nhập số credit tùy chỉnh.' });
        return;
    }
    const amount = packCredits != null ? { packCredits } : { customCredits };
    const checkout = await gp.createCheckout({ ...amount, client: 'web' });
    res.json(checkout);
}));

app.get('/api/reconstruction/checkouts/:checkoutId', asyncRoute(async (req, res) => {
    const gp = clientFor(req);
    res.json(await gp.getCheckout(req.params.checkoutId));
}));

app.get('/api/reconstruction/datasets/:datasetId/quote', asyncRoute(async (req, res) => {
    const gp = clientFor(req);
    const pipeline = pipelineFor(req.query.pipeline);
    res.json(await gp.quote(req.params.datasetId, pipeline));
}));

app.get('/api/reconstruction/runs', asyncRoute(async (req, res) => {
    const gp = clientFor(req);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 12));
    const envelope = await gp.listDatasets({ limit });
    const datasets = envelope.datasets || envelope.rows || [];
    const groups = await Promise.all(datasets.map(async dataset => ({
        dataset,
        runs: await gp.listRuns(dataset.dataset_id)
    })));
    res.json({
        datasets: groups.map(({ dataset, runs }) => ({
            dataset_id: dataset.dataset_id,
            label: dataset.label,
            image_count: dataset.image_count,
            bytes: dataset.bytes,
            created: dataset.created,
            models: runs
            .filter(run => run.status === 'done' && run.artifact_count > 0 && run.primary)
            .sort((a, b) => b.created - a.created)
            .map(run => ({
                ...run,
                dataset_id: dataset.dataset_id,
                dataset_label: dataset.label,
                image_count: dataset.image_count
            }))
        }))
    });
}));

app.delete('/api/reconstruction/datasets/:datasetId', asyncRoute(async (req, res) => {
    const gp = clientFor(req);
    const { datasetId } = req.params;
    const cachePaths = await datasetArtifactCachePaths(gp, datasetId);
    await gp.deleteDataset(datasetId);
    const cacheCleanup = await Promise.allSettled(
        cachePaths.map(cachePath => rm(cachePath, { force: true }))
    );
    const cleanupFailures = cacheCleanup.filter(result => result.status === 'rejected').length;
    if (cleanupFailures > 0) {
        logger.warn('dataset.cache_cleanup_incomplete', { datasetId, cleanupFailures });
    }
    for (const [jobId, context] of jobContexts) {
        if (context.datasetId === datasetId) jobContexts.delete(jobId);
    }
    res.status(204).end();
}));

app.get('/api/reconstruction/uploads/:operationId/events', (req, res) => {
    let session;
    try {
        session = requireSession(req);
    } catch (error) {
        res.status(error.status || 401).json({ error: error.message, code: error.code });
        return;
    }
    const operationId = req.params.operationId;
    const channel = channelFor(operationId, session.id);
    clearTimeout(channel.cleanupTimer);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    channel.clients.add(res);
    if (channel.latest) {
        res.write(`event: ${channel.latest.event}\ndata: ${JSON.stringify(channel.latest.data)}\n\n`);
    }
    req.on('close', () => channel.clients.delete(res));
});

app.post('/api/reconstruction/upload', upload.array('images', 2000), asyncRoute(async (req, res) => {
    const session = requireSession(req);
    const files = Array.isArray(req.files) ? req.files : [];
    const operationId = String(req.body.operationId || randomUUID());
    const gp = makeClient(session.apiKey, { operationId });
    const pipeline = pipelineFor(req.body.pipeline);
    channelFor(operationId, session.id);
    if (!files.length) {
        res.status(400).json({ error: 'Hãy chọn ít nhất một ảnh.' });
        return;
    }

    let relativePaths = [];
    try {
        relativePaths = JSON.parse(req.body.relativePaths || '[]');
    } catch {
        relativePaths = [];
    }

    const startedAt = Date.now();
    const totalBytes = files.reduce((sum, file) => sum + (file.size || 0), 0);
    let lastProgress = null;
    let lastLoggedAt = 0;
    let lastPhase = null;
    let resumeId = null;
    const uploadStats = () => ({
        phase: lastProgress?.phase ?? 'presign',
        loaded: lastProgress?.loaded ?? 0,
        total: lastProgress?.total ?? totalBytes,
        percent: lastProgress?.total ? Math.round((lastProgress.loaded / lastProgress.total) * 100) : 0,
        lastFile: lastProgress?.file ?? null,
        elapsedMs: Date.now() - startedAt
    });

    const abortController = new AbortController();
    res.on('close', () => {
        if (!res.writableEnded) {
            logger.warn('upload.client_disconnected', { operationId, ...uploadStats() });
            abortController.abort();
        }
    });

    logger.info('upload.start', {
        operationId, pipeline, files: files.length, totalBytes
    });

    try {
        const uploadables = await Promise.all(files.map(async (file, index) => ({
            name: normalizeName(relativePaths[index] || file.originalname, index),
            data: await openAsBlob(file.path, { type: file.mimetype || 'application/octet-stream' })
        })));
        const label = String(req.body.label || `SuperSplat ${new Date().toISOString()}`).slice(0, 120);
        const onProgress = (progress) => {
            lastProgress = progress;
            if (progress.datasetId) resumeId = progress.datasetId;
            const now = Date.now();
            if (progress.phase !== lastPhase || now - lastLoggedAt > 10_000) {
                lastPhase = progress.phase;
                lastLoggedAt = now;
                logger.info('upload.progress', { operationId, ...uploadStats() });
            }
            publishUploadEvent(operationId, 'progress', progress);
        };
        const datasetId = await uploadWithResume(gp, uploadables, {
            label, operationId, onProgress, signal: abortController.signal,
            stats: uploadStats,
            getResumeId: () => resumeId,
            clearResumeId: () => { resumeId = null; }
        });
        logger.info('upload.stored', { operationId, datasetId, ...uploadStats() });
        const quote = await gp.quote(datasetId, pipeline);

        if (quote.balance < quote.required) {
            const creditsNeeded = Math.max(0, Math.ceil(quote.required - quote.balance));
            publishUploadEvent(operationId, 'end', { datasetId });
            logger.info('upload.checkout_required', { operationId, datasetId, creditsNeeded });
            res.json({ state: 'checkout_required', datasetId, quote, creditsNeeded });
            return;
        }

        publishUploadEvent(operationId, 'end', { datasetId });
        logger.info('upload.ok', { operationId, datasetId, ...uploadStats() });
        res.json({ state: 'ready', datasetId, quote });
    } catch (error) {
        logger.fail('upload.failed', error, {
            operationId, pipeline, files: files.length, aborted: abortController.signal.aborted, ...uploadStats()
        });
        publishUploadEvent(operationId, 'failed', {
            message: errorSummary(error)
        });
        throw error;
    } finally {
        await Promise.all(files.map(file => rm(file.path, { force: true }).catch(() => undefined)));
    }
}));

app.post('/api/reconstruction/jobs', asyncRoute(async (req, res) => {
    const gp = clientFor(req);
    const datasetId = String(req.body.datasetId || '');
    if (!datasetId) {
        res.status(400).json({ error: 'Thiếu datasetId.' });
        return;
    }
    const pipeline = pipelineFor(req.body.pipeline);
    const preset = String(req.body.preset || 'standard');
    const config = {
        ...await gp.getPreset(pipeline, preset),
        ...(pipeline === 'photogrammetry' ? photogrammetryUploadOverrides : {}),
        data_dir: datasetId
    };
    const idempotencyKey = String(req.body.idempotencyKey || randomUUID());
    const jobId = await gp.submitJob(pipeline, config, { idempotencyKey });
    jobContexts.set(jobId, {
        datasetId,
        pipeline,
        runName: preset,
        submittedAt: Date.now() / 1000,
        created: null
    });
    res.status(202).json({ jobId, idempotencyKey });
}));

app.get('/api/reconstruction/jobs/:jobId', asyncRoute(async (req, res) => {
    const gp = clientFor(req);
    const job = await gp.getJob(req.params.jobId);
    const delivering = job.current_stage?.step === 'publish_results';
    const artifacts = job.terminal || delivering
        ? await gp.listArtifacts(req.params.jobId).catch(() => [])
        : [];
    const scope = await resolveJobCacheScope(gp, req.params.jobId, job);
    res.json({
        job,
        artifacts: await artifactsWithCacheStatus(scope, artifacts)
    });
}));

app.get('/api/reconstruction/datasets/:datasetId/runs/:pipeline/:runName/artifacts',
    asyncRoute(async (req, res) => {
        const gp = clientFor(req);
        const { datasetId, pipeline, runName } = req.params;
        const artifacts = await gp.listRunArtifacts(datasetId, pipeline, runName);
        const scope = runCacheScope(datasetId, pipeline, runName, req.query.created || 'unknown');
        res.json({ artifacts: await artifactsWithCacheStatus(scope, artifacts) });
    }));

app.post('/api/reconstruction/jobs/:jobId/cancel', asyncRoute(async (req, res) => {
    const gp = clientFor(req);
    await gp.cancelJob(req.params.jobId);
    res.status(204).end();
}));

app.get('/api/reconstruction/jobs/:jobId/events', async (req, res) => {
    let gp;
    try {
        gp = clientFor(req);
    } catch (error) {
        res.status(error.status || 401).json({ error: error.message, code: error.code });
        return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const abortController = new AbortController();
    const lastEventId = typeof req.headers['last-event-id'] === 'string'
        ? req.headers['last-event-id']
        : '0';
    req.on('close', () => abortController.abort());
    try {
        for await (const event of gp.streamEvents(req.params.jobId, {
            lastEventId,
            signal: abortController.signal
        })) {
            // Logs remain available in the backend for diagnostics. The reconstruction UI
            // consumes the structured progress, liveness, artifact, and terminal frames.
            if (event.type === 'log') continue;
            if (event.id) res.write(`id: ${event.id}\n`);
            if (event.type === 'end') {
                res.write('event: end\ndata: {}\n\n');
                break;
            }
            const data = event.type === 'stage' ? event.stage :
                event.type === 'progress' ? event.progress :
                    event.type === 'heartbeat' ? event.heartbeat :
                        event.type === 'dataset' ? event.dataset :
                            event.artifact;
            res.write(`event: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`);
        }
    } catch (error) {
        if (!abortController.signal.aborted) {
            logger.fail('job.stream_failed', error, { jobId: req.params.jobId, lastEventId });
            res.write(`event: failed\ndata: ${JSON.stringify({ message: errorSummary(error) })}\n\n`);
        }
    } finally {
        res.end();
    }
});

app.get('/api/reconstruction/jobs/:jobId/model', asyncRoute(async (req, res) => {
    const gp = clientFor(req);
    const artifacts = await gp.listArtifacts(req.params.jobId);
    const requestedName = String(req.query.name || '');
    const artifact = requestedName
        ? artifacts.find(item => item.name === requestedName)
        : artifacts.find(item => item.primary)
            || artifacts.find(item => item.kind === 'splat_ply')
            || artifacts.find(item => item.name.toLowerCase().endsWith('.ply'));
    if (!artifact) {
        res.status(404).json({
            error: requestedName
                ? `Artifact "${requestedName}" does not exist for this job.`
                : 'The job completed without a primary model artifact.'
        });
        return;
    }

    const scope = await resolveJobCacheScope(gp, req.params.jobId);
    await sendArtifact(
        res,
        scope,
        artifact,
        () => gp.downloadArtifactStream(req.params.jobId, artifact.name)
    );
}));

app.get('/api/reconstruction/datasets/:datasetId/runs/:pipeline/:runName/model',
    asyncRoute(async (req, res) => {
        const gp = clientFor(req);
        const { datasetId, pipeline, runName } = req.params;
        const artifacts = await gp.listRunArtifacts(datasetId, pipeline, runName);
        const requestedName = String(req.query.name || '');
        const artifact = requestedName
            ? artifacts.find(item => item.name === requestedName)
            : artifacts.find(item => item.primary)
                || artifacts.find(item => item.kind === 'splat_ply')
                || artifacts.find(item => item.name.toLowerCase().endsWith('.ply'));
        if (!artifact) {
            res.status(404).json({
                error: requestedName
                    ? `Artifact "${requestedName}" does not exist for this run.`
                : 'The run has no primary model artifact.'
            });
            return;
        }
        const scope = runCacheScope(datasetId, pipeline, runName, req.query.created || 'unknown');
        await sendArtifact(res, scope, artifact, async () => {
            const url = await gp.getRunArtifactUrl(datasetId, pipeline, runName, artifact.name);
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Artifact storage returned ${response.status}`);
            if (!response.body) throw new Error(`Artifact storage returned no body for "${artifact.name}".`);
            return response.body;
        });
    }));

app.use(express.static(path.join(rootDir, 'dist'), { etag: false, maxAge: 0 }));
app.use((_req, res) => res.sendFile(path.join(rootDir, 'dist', 'index.html')));

app.use((error, req, res, _next) => {
    const status = error instanceof ApiError || error instanceof HttpError ? error.status : 500;
    const detail = error instanceof ApiError ? error.detail : errorSummary(error);
    const record = { method: req.method, route: req.path, status };
    if (status >= 500) logger.fail('request.failed', error, record);
    else logger.warn('request.rejected', { ...record, summary: errorSummary(error) });
    if (!res.headersSent) res.status(status).json({ error: detail, code: error?.code || 'local_error' });
});

app.listen(port, '127.0.0.1', () => {
    logger.info('server.started', { port, baseUrl, log: currentLogPath() });
    console.log(`SuperSplat Reconstruction running at http://localhost:${port}`);
    console.log(`Genesis API: ${baseUrl}`);
    console.log(`Logs: ${currentLogPath()}`);
});
