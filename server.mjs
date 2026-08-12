import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { handle } from './src/backend/router.ts';
import { ReconstructionSession } from './src/backend/session-object.ts';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(rootDir, 'dist');

const parseEnv = text => Object.fromEntries(
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
    localEnv = parseEnv(await readFile(path.join(rootDir, '.env.local'), 'utf8'));
} catch {
}

const sessionNamespace = (env) => {
    const objects = new Map();
    const sql = () => {
        const db = new DatabaseSync(':memory:');
        return {
            exec: (query, ...bindings) => {
                const statement = db.prepare(query);
                const reads = /^\s*SELECT/i.test(query);
                const rows = reads ?
                    statement.all(...bindings) : (statement.run(...bindings), []);
                return { toArray: () => rows };
            }
        };
    };
    return {
        idFromName: name => name,
        get: (id) => {
            if (!objects.has(id)) {
                objects.set(id, new ReconstructionSession(
                    { storage: { sql: sql(), deleteAll: async () => {} } }, env));
            }
            return objects.get(id);
        }
    };
};

const env = {
    GENESIS_BASE_URL: process.env.GENESIS_BASE_URL || localEnv.GENESIS_BASE_URL ||
        'https://recons.rtrobotics.com'
};
env.RECON_SESSIONS = sessionNamespace(env);
const port = Number(process.env.PORT || localEnv.PORT || 3000);

const CONTENT_TYPES = {
    '.css': 'text/css',
    '.html': 'text/html; charset=utf-8',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.map': 'application/json',
    '.mjs': 'text/javascript',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.wasm': 'application/wasm',
    '.webp': 'image/webp'
};

const toRequest = (req) => {
    const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    return new Request(url, {
        method: req.method,
        headers: req.headers,
        ...(hasBody ? { body: Readable.toWeb(req), duplex: 'half' } : {})
    });
};

const send = async (res, response) => {
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) {
        res.end();
        return;
    }
    for await (const chunk of Readable.fromWeb(response.body)) res.write(chunk);
    res.end();
};

const serveAsset = async (res, pathname) => {
    const candidate = path.resolve(distDir, `.${pathname}`);
    const target = candidate.startsWith(distDir + path.sep) || candidate === distDir ?
        candidate :
        distDir;
    for (const file of [target, path.join(distDir, 'index.html')]) {
        try {
            const body = await readFile(file);
            res.writeHead(200, {
                'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] ||
                    'application/octet-stream'
            });
            res.end(body);
            return;
        } catch {
        }
    }
    res.writeHead(404).end();
};

createServer(async (req, res) => {
    try {
        const response = await handle(toRequest(req), env);
        if (response) {
            await send(res, response);
            return;
        }
        await serveAsset(res, new URL(req.url, 'http://localhost').pathname);
    } catch (error) {
        console.error(JSON.stringify({
            event: 'request.failed',
            method: req.method,
            url: req.url,
            message: String(error?.message ?? error)
        }));
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal error', code: 'local_error' }));
    }
}).listen(port, '127.0.0.1', () => {
    console.log(`SuperSplat Reconstruction running at http://localhost:${port}`);
    console.log(`Genesis API: ${env.GENESIS_BASE_URL}`);
});
