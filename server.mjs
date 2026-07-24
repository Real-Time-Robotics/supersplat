import { randomUUID } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import express from 'express';
import multer from 'multer';
import { ApiError, Client } from 'genesis-recon';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(rootDir, '.server-uploads');
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

await mkdir(uploadDir, { recursive: true });

const gp = new Client(baseUrl, apiKey);
const app = express();
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

app.delete('/api/reconstruction/datasets/:datasetId', asyncRoute(async (req, res) => {
    await gp.deleteDataset(req.params.datasetId);
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
            const creditsNeeded = Math.max(100, Math.ceil(quote.required - quote.balance));
            const checkout = await gp.createCheckout({ customCredits: creditsNeeded, client: 'web' });
            publishUploadEvent(operationId, 'end', { datasetId });
            res.json({ state: 'checkout_required', datasetId, quote, creditsNeeded, checkout });
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
    res.status(202).json({ jobId, idempotencyKey });
}));

app.get('/api/reconstruction/jobs/:jobId', asyncRoute(async (req, res) => {
    const job = await gp.getJob(req.params.jobId);
    const artifacts = job.terminal ? await gp.listArtifacts(req.params.jobId).catch(() => []) : [];
    res.json({ job, artifacts });
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
    try {
        for await (const event of gp.streamEvents(req.params.jobId)) {
            if (event.type === 'end') {
                res.write('event: end\ndata: {}\n\n');
                break;
            }
            const data = event.type === 'log' ? event.line :
                event.type === 'stage' ? event.stage : event.artifact;
            res.write(`event: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`);
        }
    } catch (error) {
        res.write(`event: failed\ndata: ${JSON.stringify({ message: error?.message || String(error) })}\n\n`);
    } finally {
        res.end();
    }
});

app.get('/api/reconstruction/jobs/:jobId/model', asyncRoute(async (req, res) => {
    const artifacts = await gp.listArtifacts(req.params.jobId);
    const artifact = artifacts.find(item => item.primary)
        || artifacts.find(item => item.kind === 'splat_ply')
        || artifacts.find(item => item.name.toLowerCase().endsWith('.ply'));
    if (!artifact) {
        res.status(404).json({ error: 'Job đã hoàn tất nhưng không có Gaussian Splat PLY artifact.' });
        return;
    }

    const stream = await gp.downloadArtifactStream(req.params.jobId, artifact.name);
    const filename = path.basename(artifact.name).replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/ply');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    Readable.fromWeb(stream).pipe(res);
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
