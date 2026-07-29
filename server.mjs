import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, openAsBlob } from 'node:fs';
import { mkdir, open as openFile, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import express from 'express';
import multer from 'multer';
import { ApiError, Client } from 'genesis-recon';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(rootDir, '.server-uploads');
const artifactCacheDir = path.join(rootDir, '.artifact-cache');
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

const apiKey = process.env.GENESIS_API_KEY || localEnv.GENESIS_API_KEY;
const baseUrl = process.env.GENESIS_BASE_URL || localEnv.GENESIS_BASE_URL || 'https://recons.rtrobotics.com';
const port = Number(process.env.PORT || localEnv.PORT || 3000);

if (!apiKey) {
    console.error('Missing GENESIS_API_KEY. Add it to .env.local before starting the app.');
    process.exit(1);
}

await Promise.all([
    mkdir(uploadDir, { recursive: true }),
    mkdir(artifactCacheDir, { recursive: true })
]);

const gp = new Client(baseUrl, apiKey);
const app = express();
const jobContexts = new Map();
const uploadChannels = new Map();
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

const datasetArtifactCachePaths = async (datasetId) => {
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

const resolveJobCacheScope = async (jobId, job) => {
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
        '.ksplat': 'application/x-gaussian-splat',
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

const channelFor = (id) => {
    let channel = uploadChannels.get(id);
    if (!channel) {
        channel = {
            clients: new Set(),
            latest: null,
            cleanupTimer: null
        };
        uploadChannels.set(id, channel);
    }
    return channel;
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

app.get('/api/reconstruction/health', asyncRoute(async (_req, res) => {
    const credits = await gp.getCreditBalance();
    res.json({ ok: true, baseUrl: gp.baseUrl, credits });
}));

app.get('/api/reconstruction/credits', asyncRoute(async (_req, res) => {
    res.json(await gp.getCreditBalance());
}));

app.get('/api/reconstruction/pricing', asyncRoute(async (_req, res) => {
    res.json(await gp.getPricingCatalog());
}));

app.post('/api/reconstruction/checkout', asyncRoute(async (req, res) => {
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
    res.json(await gp.getCheckout(req.params.checkoutId));
}));

app.get('/api/reconstruction/datasets/:datasetId/quote', asyncRoute(async (req, res) => {
    res.json(await gp.quote(req.params.datasetId, 'splat'));
}));

app.get('/api/reconstruction/runs', asyncRoute(async (req, res) => {
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
    const { datasetId } = req.params;
    const cachePaths = await datasetArtifactCachePaths(datasetId);
    await gp.deleteDataset(datasetId);
    const cacheCleanup = await Promise.allSettled(
        cachePaths.map(cachePath => rm(cachePath, { force: true }))
    );
    const cleanupFailures = cacheCleanup.filter(result => result.status === 'rejected').length;
    if (cleanupFailures > 0) {
        console.warn(`[reconstruction] deleted dataset ${datasetId}, but could not remove ${cleanupFailures} cached artifact(s)`);
    }
    for (const [jobId, context] of jobContexts) {
        if (context.datasetId === datasetId) jobContexts.delete(jobId);
    }
    res.status(204).end();
}));

app.get('/api/reconstruction/uploads/:operationId/events', (req, res) => {
    const operationId = req.params.operationId;
    const channel = channelFor(operationId);
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
    const files = Array.isArray(req.files) ? req.files : [];
    const operationId = String(req.body.operationId || randomUUID());
    if (!files.length) {
        res.status(400).json({ error: 'Hãy chọn ít nhất một ảnh.' });
        return;
    }

    let relativePaths = [];
    const abortController = new AbortController();
    res.on('close', () => {
        if (!res.writableEnded) abortController.abort();
    });

    try {
        relativePaths = JSON.parse(req.body.relativePaths || '[]');
    } catch {
        relativePaths = [];
    }

    try {
        const uploadables = await Promise.all(files.map(async (file, index) => ({
            name: normalizeName(relativePaths[index] || file.originalname, index),
            data: await openAsBlob(file.path, { type: file.mimetype || 'application/octet-stream' })
        })));
        const label = String(req.body.label || `SuperSplat ${new Date().toISOString()}`).slice(0, 120);
        const datasetId = await gp.uploadDataset(uploadables, {
            label,
            signal: abortController.signal,
            onProgress: progress => publishUploadEvent(operationId, 'progress', progress)
        });
        const quote = await gp.quote(datasetId, 'splat');

        if (quote.balance < quote.required) {
            const creditsNeeded = Math.max(0, Math.ceil(quote.required - quote.balance));
            publishUploadEvent(operationId, 'end', { datasetId });
            res.json({ state: 'checkout_required', datasetId, quote, creditsNeeded });
            return;
        }

        publishUploadEvent(operationId, 'end', { datasetId });
        res.json({ state: 'ready', datasetId, quote });
    } catch (error) {
        publishUploadEvent(operationId, 'failed', {
            message: error?.message || String(error)
        });
        throw error;
    } finally {
        await Promise.all(files.map(file => rm(file.path, { force: true }).catch(() => undefined)));
    }
}));

app.post('/api/reconstruction/jobs', asyncRoute(async (req, res) => {
    const datasetId = String(req.body.datasetId || '');
    if (!datasetId) {
        res.status(400).json({ error: 'Thiếu datasetId.' });
        return;
    }
    const preset = String(req.body.preset || 'standard');
    const config = { ...await gp.getPreset('splat', preset), data_dir: datasetId };
    const idempotencyKey = String(req.body.idempotencyKey || randomUUID());
    const jobId = await gp.submitJob('splat', config, { idempotencyKey });
    jobContexts.set(jobId, {
        datasetId,
        pipeline: 'splat',
        runName: preset,
        submittedAt: Date.now() / 1000,
        created: null
    });
    res.status(202).json({ jobId, idempotencyKey });
}));

app.get('/api/reconstruction/jobs/:jobId', asyncRoute(async (req, res) => {
    const job = await gp.getJob(req.params.jobId);
    const artifacts = job.terminal ? await gp.listArtifacts(req.params.jobId).catch(() => []) : [];
    const scope = await resolveJobCacheScope(req.params.jobId, job);
    res.json({
        job,
        artifacts: await artifactsWithCacheStatus(scope, artifacts)
    });
}));

app.get('/api/reconstruction/datasets/:datasetId/runs/:pipeline/:runName/artifacts',
    asyncRoute(async (req, res) => {
        const { datasetId, pipeline, runName } = req.params;
        const artifacts = await gp.listRunArtifacts(datasetId, pipeline, runName);
        const scope = runCacheScope(datasetId, pipeline, runName, req.query.created || 'unknown');
        res.json({ artifacts: await artifactsWithCacheStatus(scope, artifacts) });
    }));

app.post('/api/reconstruction/jobs/:jobId/cancel', asyncRoute(async (req, res) => {
    await gp.cancelJob(req.params.jobId);
    res.status(204).end();
}));

app.get('/api/reconstruction/jobs/:jobId/events', async (req, res) => {
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
            // consumes structured stage/artifact/end frames only.
            if (event.type === 'log') continue;
            if (event.id) res.write(`id: ${event.id}\n`);
            if (event.type === 'end') {
                res.write('event: end\ndata: {}\n\n');
                break;
            }
            const data = event.type === 'stage' ? event.stage : event.artifact;
            res.write(`event: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`);
        }
    } catch (error) {
        if (!abortController.signal.aborted) {
            res.write(`event: failed\ndata: ${JSON.stringify({ message: error?.message || String(error) })}\n\n`);
        }
    } finally {
        res.end();
    }
});

app.get('/api/reconstruction/jobs/:jobId/model', asyncRoute(async (req, res) => {
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
                : 'Job đã hoàn tất nhưng không có Gaussian Splat PLY artifact.'
        });
        return;
    }

    const scope = await resolveJobCacheScope(req.params.jobId);
    await sendArtifact(
        res,
        scope,
        artifact,
        () => gp.downloadArtifactStream(req.params.jobId, artifact.name)
    );
}));

app.get('/api/reconstruction/datasets/:datasetId/runs/:pipeline/:runName/model',
    asyncRoute(async (req, res) => {
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
                : 'Run has no Gaussian Splat PLY artifact.'
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

app.use((error, _req, res, _next) => {
    const status = error instanceof ApiError ? error.status : 500;
    const detail = error instanceof ApiError ? error.detail : (error?.message || String(error));
    console.error(`[reconstruction] ${status}: ${detail}`);
    if (!res.headersSent) res.status(status).json({ error: detail, code: error?.code || 'local_error' });
});

app.listen(port, '127.0.0.1', () => {
    console.log(`SuperSplat Reconstruction running at http://localhost:${port}`);
    console.log(`Genesis API: ${baseUrl}`);
});
