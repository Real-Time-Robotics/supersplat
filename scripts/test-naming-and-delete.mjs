import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { call, envFor, listenOnRandomPort, sendJson, signInWithApiKey } from './test-support.mjs';

/** Records every upstream call so a test can assert the shape the gateway actually saw. */
const recordingGateway = (seen) => createServer((req, res) => {
    const send = (status, payload) => sendJson(res, status, payload);
    if (req.url === '/billing/credits') {
        send(200, { customer_id: 'c1', balance: 10, billable: true });
        return;
    }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
        seen.push({ method: req.method, url: req.url, body });
        if (req.method === 'PUT') {
            send(200, { dataset_id: 'ds1', job_id: 'j1', label: body.label });
            return;
        }
        send(200, { ok: true });
    });
});

const harness = async (context) => {
    const seen = [];
    const gateway = recordingGateway(seen);
    const port = await listenOnRandomPort(gateway);
    context.after(() => gateway.close());
    const env = envFor(port);
    const cookie = await signInWithApiKey(env);
    return { seen, env, cookie };
};

const rename = (label) => ({
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label })
});

test('a dataset is renamed without its id or its objects moving', async (context) => {
    const { seen, env, cookie } = await harness(context);

    const response = await call(env, '/api/reconstruction/datasets/ds1',
        { ...rename('Kho A'), headers: { ...rename('Kho A').headers, cookie } });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { label: 'Kho A' });
    assert.deepEqual(seen.at(-1), {
        method: 'PUT', url: '/v1/datasets/ds1', body: { label: 'Kho A' }
    });
});

test('a run is renamed through the job that made it', async (context) => {
    const { seen, env, cookie } = await harness(context);

    const response = await call(env, '/api/reconstruction/jobs/j1/label',
        { ...rename('Mái nhà'), headers: { ...rename('x').headers, cookie } });

    assert.equal(response.status, 200);
    assert.deepEqual(seen.at(-1), {
        method: 'PUT', url: '/v1/jobs/j1/label', body: { label: 'Mái nhà' }
    });
});

test('deleting a job reaches the job route, not the dataset one', async (context) => {
    const { seen, env, cookie } = await harness(context);

    const response = await call(env, '/api/reconstruction/jobs/j1',
        { method: 'DELETE', headers: { cookie } });

    assert.equal(response.status, 204);
    assert.equal(seen.at(-1).url, '/v1/jobs/j1');
    assert.equal(seen.at(-1).method, 'DELETE');
});

test('deleting one artifact names it, and leaves the rest of the run addressed', async (context) => {
    const { seen, env, cookie } = await harness(context);

    await call(env, '/api/reconstruction/jobs/j1/artifacts/textured.glb',
        { method: 'DELETE', headers: { cookie } });
    assert.equal(seen.at(-1).url, '/v1/jobs/j1/artifacts/textured.glb');

    await call(env, '/api/reconstruction/datasets/ds1/runs/splat/standard/artifacts/model.ply',
        { method: 'DELETE', headers: { cookie } });
    assert.equal(seen.at(-1).url,
        '/v1/datasets/ds1/runs/splat/standard/artifacts/model.ply');
});

test('deleting a whole run is not mistaken for deleting one of its files', async (context) => {
    const { seen, env, cookie } = await harness(context);

    const response = await call(env, '/api/reconstruction/datasets/ds1/runs/splat/standard',
        { method: 'DELETE', headers: { cookie } });

    assert.equal(response.status, 204);
    assert.equal(seen.at(-1).url, '/v1/datasets/ds1/runs/splat/standard');
});

test('a run submitted with a name carries it upstream as a label', async (context) => {
    const seen = [];
    const gateway = createServer((req, res) => {
        const send = (status, payload) => sendJson(res, status, payload);
        if (req.url === '/billing/credits') {
            send(200, { customer_id: 'c1', balance: 10, billable: true });
            return;
        }
        if (req.url === '/v1/pipelines') {
            send(200, [{ name: 'splat', run_name_field: 'result_name' }]);
            return;
        }
        if (req.url.startsWith('/v1/pipelines/splat/presets/')) {
            send(200, { name: 'standard', config: {} });
            return;
        }
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            seen.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
            send(200, { job_id: 'j9' });
        });
    });
    const port = await listenOnRandomPort(gateway);
    context.after(() => gateway.close());
    const env = envFor(port);
    const cookie = await signInWithApiKey(env);

    const response = await call(env, '/api/reconstruction/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({
            datasetId: 'ds1', pipeline: 'splat', runName: 'standard-abc', label: 'Kho A'
        })
    });

    assert.equal(response.status, 202);
    const submitted = seen.find(entry => entry.url === '/v1/jobs');
    assert.equal(submitted.body.label, 'Kho A');
    assert.equal(submitted.body.config.result_name, 'standard-abc',
        'the name on screen must not become the directory on the store');
});
