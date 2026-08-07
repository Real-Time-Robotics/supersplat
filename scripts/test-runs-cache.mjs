import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { listenOnRandomPort, sendJson, signInWithApiKey, startApp } from './test-support.mjs';

test('the runs aggregate is lazy and cached, and the upload route is gone', async (context) => {
    const runCalls = [];
    const gateway = createServer((req, res) => {
        const send = (status, payload) => sendJson(res, status, payload);
        if (req.url.startsWith('/v1/datasets?') || req.url === '/v1/datasets') {
            send(200, {
                total: 1,
                datasets: [{
                    dataset_id: 'ds1', label: 'set', image_count: 3, bytes: 30,
                    created: 1, runs: { splat: 1, photogrammetry: 0 }
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

    const appOrigin = await startApp(context, gatewayPort);
    const cookie = await signInWithApiKey(appOrigin);

    const listed = await fetch(`${appOrigin}/api/reconstruction/runs`, { headers: { cookie } });
    assert.equal(listed.status, 200);
    const body = await listed.json();
    assert.equal(body.datasets[0].dataset_id, 'ds1');
    assert.deepEqual(body.datasets[0].run_counts, { splat: 1, photogrammetry: 0 });
    assert.equal(runCalls.length, 0, 'listing datasets must not list runs');

    const first = await fetch(`${appOrigin}/api/reconstruction/datasets/ds1/runs`, { headers: { cookie } });
    const firstBody = await first.json();
    assert.equal(firstBody.runs.length, 1);
    await fetch(`${appOrigin}/api/reconstruction/datasets/ds1/runs`, { headers: { cookie } });
    assert.equal(runCalls.length, 1, 'the second open must be served from cache');

    const upload = await fetch(`${appOrigin}/api/reconstruction/upload`, {
        method: 'POST', headers: { cookie }
    });
    assert.match(upload.headers.get('content-type') ?? '', /text\/html/);
    await assert.rejects(() => upload.clone().json());
});
