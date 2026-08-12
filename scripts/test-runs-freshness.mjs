import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { call, envFor, listenOnRandomPort, sendJson, signInWithApiKey } from './test-support.mjs';

test('the runs aggregate is lazy and always fresh, and the upload route is gone', async (context) => {
    const runCalls = [];
    const gateway = createServer((req, res) => {
        const send = (status, payload) => sendJson(res, status, payload);
        if (req.url.startsWith('/v1/datasets?') || req.url === '/v1/datasets') {
            send(200, {
                total: 1,
                datasets: [{
                    dataset_id: 'ds1', label: 'set', image_count: 3, bytes: 30,
                    created: 1, runs: { splat: 2, photogrammetry: 0 },
                    models: { splat: 1, photogrammetry: 0 }
                }]
            });
            return;
        }
        if (req.url === '/v1/datasets/ds1/runs') {
            runCalls.push(req.url);
            send(200, {
                dataset_id: 'ds1',
                runs: [{
                    pipeline: 'splat', run_name: 'standard', status: 'done', created: 2,
                    artifact_count: 1, bytes: 10, primary: 'point_cloud.ply', node: null
                }]
            });
            return;
        }
        if (req.url === '/billing/credits') {
            send(200, { customer_id: 'c1', balance: 10, billable: true });
            return;
        }
        res.writeHead(404).end();
    });
    const gatewayPort = await listenOnRandomPort(gateway);
    context.after(() => gateway.close());

    const env = envFor(gatewayPort);
    const cookie = await signInWithApiKey(env);

    const listed = await call(env, '/api/reconstruction/runs', { headers: { cookie } });
    assert.equal(listed.status, 200);
    const body = await listed.json();
    assert.equal(body.datasets[0].dataset_id, 'ds1');
    assert.deepEqual(body.datasets[0].run_counts, { splat: 2, photogrammetry: 0 });
    assert.deepEqual(body.datasets[0].model_counts, { splat: 1, photogrammetry: 0 });
    assert.equal(runCalls.length, 0, 'listing datasets must not list runs');

    const first = await call(env, '/api/reconstruction/datasets/ds1/runs', { headers: { cookie } });
    const firstBody = await first.json();
    assert.equal(firstBody.runs.length, 1);
    assert.equal(first.headers.get('cache-control'), 'no-store');

    // An isolate-local Map was only ever right for whichever isolate happened to answer,
    // so a run finishing on one left the others serving a stale list for up to a minute.
    await call(env, '/api/reconstruction/datasets/ds1/runs', { headers: { cookie } });
    assert.equal(runCalls.length, 2, 'every open asks upstream');

    const upload = await call(env, '/api/reconstruction/upload', {
        method: 'POST', headers: { cookie }
    });
    assert.equal(upload.status, 404);
    assert.equal((await upload.json()).code, 'not_found');
});
