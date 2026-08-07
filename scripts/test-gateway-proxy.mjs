import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { call, envFor, listenOnRandomPort, signInWithApiKey } from './test-support.mjs';

test('the /api/gp proxy authenticates, fences and streams', async (context) => {
    const seen = [];
    let released = null;
    const gateway = createServer(async (req, res) => {
        seen.push({
            method: req.method,
            url: req.url,
            auth: req.headers.authorization,
            cookie: req.headers.cookie ?? null,
            idempotency: req.headers['idempotency-key'] ?? null,
            lastEventId: req.headers['last-event-id'] ?? null
        });
        if (req.url === '/v1/datasets/sessions' && req.method === 'POST') {
            const body = await new Response(req, { duplex: 'half' }).text();
            seen[seen.length - 1].body = body;
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ dataset_id: 'ds12ab34' }));
            return;
        }
        if (req.url === '/v1/jobs/j1/stream') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('id: 1\nevent: stage\ndata: {"step":"sfm"}\n\n');
            released = () => {
                res.write('event: end\ndata: {}\n\n');
                res.end();
            };
            return;
        }
        if (req.url === '/billing/credits') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ customer_id: 'c1', balance: 10, billable: true }));
            return;
        }
        res.writeHead(404).end();
    });
    const gatewayPort = await listenOnRandomPort(gateway);
    context.after(() => gateway.close());
    const env = envFor(gatewayPort);

    const anonymous = await call(env, '/api/gp/v1/datasets/sessions', { method: 'POST' });
    assert.equal(anonymous.status, 401);
    assert.equal(seen.length, 0);

    const cookie = await signInWithApiKey(env);
    seen.length = 0;

    const created = await call(env, '/api/gp/v1/datasets/sessions', {
        method: 'POST',
        headers: { cookie, 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-1' },
        body: JSON.stringify({ hello: 'world' })
    });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { dataset_id: 'ds12ab34' });
    const write = seen.at(-1);
    assert.equal(write.auth, 'Bearer gp_live_test');
    assert.equal(write.cookie, null);
    assert.equal(write.idempotency, 'idem-1');
    assert.equal(write.body, JSON.stringify({ hello: 'world' }));

    seen.length = 0;
    const denied = await call(env, '/api/gp/billing/credits', { headers: { cookie } });
    assert.equal(denied.status, 404);
    assert.equal((await denied.json()).code, 'proxy_path_denied');
    assert.equal(seen.length, 0);

    const offsite = createServer((req, res) => {
        offsite.leaked = req.headers.authorization ?? 'no-auth';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
    });
    const offsitePort = await listenOnRandomPort(offsite);
    context.after(() => offsite.close());
    for (const path of [`//127.0.0.1:${offsitePort}/v1/steal`, `/\\127.0.0.1:${offsitePort}/v1/steal`]) {
        const attack = await call(env, `/api/gp${path}`, { headers: { cookie } });
        assert.equal(attack.status, 404, `${path} must not be proxied`);
        assert.equal((await attack.json()).code, 'proxy_path_denied');
    }
    assert.equal(offsite.leaked, undefined, 'the API key must never reach another host');
    assert.equal(seen.length, 0);

    // SSE: the first frame arrives before the upstream response ends.
    const stream = await call(env, '/api/gp/v1/jobs/j1/stream', {
        headers: { cookie, Accept: 'text/event-stream', 'Last-Event-ID': '7' }
    });
    assert.equal(stream.status, 200);
    assert.equal(seen.at(-1).lastEventId, '7');
    const reader = stream.body.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /event: stage/);
    released();
    await reader.cancel();
});
