import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client, optionsFromPolicy } from './client.ts';
import { ApiError, AuthError, NotFoundError, UploadError } from './errors.ts';
import { createRetryingFetch } from './retry.ts';

type Handler = (url: URL, req: Request) => Response | Promise<Response>;
type Route = { method: string; match: (url: URL) => boolean; handler: Handler };

const BASE = 'https://recons.test';
const PROBLEM = 'application/problem+json; charset=utf-8';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
});

const problem = (status: number, code: string, members: Record<string, unknown> = {}) => new Response(
    JSON.stringify({ title: code, status, code, request_id: 'req-1', ...members }),
    { status, headers: { 'content-type': PROBLEM } }
);

const route = (method: string, match: (url: URL) => boolean, handler: Handler): Route => ({ method, match, handler });

const makeFetch = (routes: Route[]): typeof fetch => (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    const found = routes.find(r => r.method === req.method.toUpperCase() && r.match(url));
    return found ? found.handler(url, req) : problem(500, 'internal');
}) as typeof fetch;

const file = (name: string, text: string) => ({ name, data: new Blob([text]) });

const looseRoutes = (onPut: Handler, puts: string[] = []): Route[] => [
    route('GET', u => u.pathname === '/v1/datasets/sessions/ds9', () => json({
        dataset_id: 'ds9',
        count: 2,
        bytes: 4,
        images: [{ name: 'a.jpg', bytes: 3 }, { name: 'b.jpg', bytes: 1 }]
    })),
    route('POST', u => u.pathname === '/v1/datasets/sessions/ds9/presign', async (u, req) => {
        const { names } = await req.json() as { names: string[] };
        return json({ urls: names.map(n => ({ name: n, url: `https://s3.test/${n}` })) });
    }),
    route('PUT', u => u.host === 's3.test', (u, req) => {
        puts.push(u.pathname.slice(1));
        return onPut(u, req);
    }),
    route('POST', u => u.pathname === '/v1/datasets/sessions/ds9/finalize', () => json({ dataset_id: 'ds9' }))
];

test('the control-plane policy maps to client options', () => {
    const options = optionsFromPolicy({
        request_timeout_ms: 10,
        connect_timeout_ms: 20,
        retry_max_attempts: 3,
        retry_backoff_ms: 250,
        ingest_timeout_ms: 30,
        ingest_poll_ms: 40,
        upload_concurrency: 5,
        upload_stall_timeout_ms: 60
    } as never);
    assert.deepEqual(options, {
        requestTimeoutMs: 10,
        connectTimeoutMs: 20,
        retry: { maxAttempts: 3, backoff: 0.25 },
        ingestTimeoutMs: 30,
        ingestPollMs: 40,
        uploadConcurrency: 5,
        stallTimeoutMs: 60
    });
});

test('reads retry on 503 and 429, writes only on 429', async () => {
    const run = async (method: string, statuses: number[]) => {
        let calls = 0;
        const retrying = createRetryingFetch(async () => new Response(null, { status: statuses[calls++] }),
            {}, async () => {});
        return [(await retrying('https://x/a', { method })).status, calls];
    };
    assert.deepEqual(await run('GET', [503, 503, 200]), [200, 3]);
    assert.deepEqual(await run('POST', [503, 200]), [503, 1]);
    assert.deepEqual(await run('POST', [429, 200]), [200, 2]);
});

test('an hourly credit ceiling is not retried', async () => {
    let calls = 0;
    const fetch = makeFetch([route('POST', u => u.pathname === '/v1/jobs', () => {
        calls++;
        return problem(429, 'hourly_credit_ceiling');
    })]);
    const gp = new Client(BASE, 't', { retry: { backoff: 0 }, fetch });
    await assert.rejects(gp.submitJob('splat', {}), (e: ApiError) => e.status === 429);
    assert.equal(calls, 1);
});

test('a refusal becomes a typed ApiError with its problem members', async () => {
    const html = () => new Response('<html></html>', { status: 502, headers: { 'content-type': 'text/html' } });
    const fetch = makeFetch([
        route('GET', u => u.pathname === '/v1/jobs/missing', () => problem(404, 'not_found', { detail: 'no such job' })),
        route('GET', u => u.pathname === '/v1/jobs/held', () => problem(403, 'service_held', { hold_reason: 'billing' })),
        route('GET', u => u.pathname === '/v1/jobs/html', html)
    ]);
    const gp = new Client(BASE, 't', { retry: { maxAttempts: 1 }, fetch });
    await assert.rejects(gp.getJob('missing'), (e: ApiError) => e instanceof NotFoundError &&
        e.code === 'not_found' && e.detail === 'no such job' && e.requestId === 'req-1');
    await assert.rejects(gp.getJob('held'), (e: ApiError) => e instanceof AuthError &&
        e.failureClass === 'unauthenticated' && e.holdReason === 'billing');
    await assert.rejects(gp.getJob('html'), (e: ApiError) => e.constructor === ApiError &&
        e.code === 'error' && e.detail === 'Bad Gateway' && e.failureClass === 'peer-unavailable');
});

test('a resumed upload skips what the store already holds', async () => {
    const puts: string[] = [];
    const fetch = makeFetch(looseRoutes(() => new Response(null, { status: 200 }), puts));
    const gp = new Client(BASE, 't', { fetch });
    const seen: { phase: string; loaded: number; total: number }[] = [];
    const files = [file('a.jpg', 'aaa'), file('b.jpg', 'bb'), file('c.jpg', 'c')];
    assert.equal(await gp.uploadDataset(files, { datasetId: 'ds9', onProgress: p => seen.push(p) }), 'ds9');
    assert.deepEqual(puts.sort(), ['b.jpg', 'c.jpg']);
    const upload = seen.filter(p => p.phase === 'upload');
    assert.equal(upload[0].loaded, 3);
    assert.deepEqual([upload.at(-1).loaded, upload.at(-1).total], [6, 6]);
});

test('a failed image PUT is an UploadError with the store\'s class', async () => {
    const puts: string[] = [];
    const refused = makeFetch(looseRoutes(() => new Response(null, { status: 400 }), puts));
    const terminal = new Client(BASE, 't', { retry: { backoff: 0 }, fetch: refused });
    await assert.rejects(terminal.uploadDataset([file('c.jpg', 'c')], { datasetId: 'ds9' }),
        (e: UploadError) => e instanceof UploadError && e.status === 400 && e.failureClass === 'permanent');
    assert.equal(puts.length, 1);

    const dropped = makeFetch(looseRoutes(() => {
        const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
        throw new TypeError('fetch failed', { cause });
    }));
    const reset = new Client(BASE, 't', { retry: { maxAttempts: 2, backoff: 0 }, fetch: dropped });
    await assert.rejects(reset.uploadDataset([file('c.jpg', 'c')], { datasetId: 'ds9' }),
        (e: UploadError) => e instanceof UploadError && /ECONNRESET/.test(e.message) &&
            e.failureClass === 'network-interrupted');
});
