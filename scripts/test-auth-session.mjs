import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { listenOnRandomPort, sendJson, signInWithApiKey, startApp } from './test-support.mjs';

test('auth sessions and photogrammetry proxy flow remain isolated and typed', async (context) => {
    const registrations = [];
    const revoked = [];
    const quotes = [];
    const submissions = [];
    let uploadSessions = 0;
    let issuer = '';
    const gateway = createServer(async (req, res) => {
        const url = new URL(req.url, issuer);
        if (req.method === 'GET' && url.pathname === '/v1/config') {
            sendJson(res, 200, { oidc_issuer: issuer, oidc_client_id: 'supersplat-test' });
        } else if (req.method === 'GET' && url.pathname === '/v1/datasets') {
            sendJson(res, 200, {
                datasets: [{
                    dataset_id: 'dataset-1',
                    label: 'Existing capture',
                    image_count: 42,
                    bytes: 123456,
                    created: 1700000000,
                    runs: {}
                }],
                total: 1
            });
        } else if (req.method === 'GET' && url.pathname === '/v1/datasets/dataset-1/runs') {
            sendJson(res, 200, { runs: [] });
        } else if (req.method === 'POST' && url.pathname === '/v1/datasets/sessions') {
            uploadSessions += 1;
            sendJson(res, 201, { dataset_id: 'unexpected-upload' });
        } else if (req.method === 'POST' && url.pathname === '/protocol/openid-connect/token') {
            sendJson(res, 200, { access_token: 'human-token' });
        } else if (req.method === 'GET' && url.pathname === '/v1/api-keys') {
            sendJson(res, 200, { keys: [{ id: 'old-key', name: 'SuperSplat Reconstruction' }] });
        } else if (req.method === 'DELETE' && url.pathname === '/v1/api-keys/old-key') {
            revoked.push('old-key');
            res.writeHead(204).end();
        } else if (req.method === 'POST' && url.pathname === '/v1/api-keys') {
            sendJson(res, 201, { id: 'new-key', key: 'gp_live_created_for_test' });
        } else if (req.method === 'POST' && url.pathname === '/v1/auth/register') {
            let body = '';
            for await (const chunk of req) body += chunk;
            registrations.push(JSON.parse(body));
            sendJson(res, 201, { sub: 'registered-user' });
        } else if (req.method === 'GET' && url.pathname === '/billing/credits') {
            sendJson(res, 200, { customer_id: 'direct-user', balance: 123, billable: true });
        } else if (req.method === 'GET' && url.pathname === '/billing/quote') {
            quotes.push(Object.fromEntries(url.searchParams));
            sendJson(res, 200, { required: 40, balance: 123, billable_gpx: 1.5 });
        } else if (req.method === 'GET' && url.pathname === '/v1/pipelines') {
            sendJson(res, 200, [
                { name: 'photogrammetry', label: 'Photogrammetry', supports_viewer: false,
                    run_name_field: 'run_name' },
                { name: 'splat', label: 'Splat', supports_viewer: true,
                    run_name_field: 'train.result_name' }
            ]);
        } else if (req.method === 'GET' &&
            url.pathname === '/v1/pipelines/photogrammetry/presets/standard') {
            sendJson(res, 200, {
                name: 'standard',
                config: { sparse_subdir: 'sparse/0_geo', image_subdir: 'images_4' }
            });
        } else if (req.method === 'POST' && url.pathname === '/v1/jobs') {
            let body = '';
            for await (const chunk of req) body += chunk;
            submissions.push(JSON.parse(body));
            sendJson(res, 202, { job_id: 'photo-job' });
        } else {
            sendJson(res, 404, { detail: `Unexpected mock route ${req.method} ${url.pathname}` });
        }
    });
    const gatewayPort = await listenOnRandomPort(gateway);
    issuer = `http://127.0.0.1:${gatewayPort}`;

    context.after(() => gateway.close());
    const app = await startApp(context, gatewayPort);

    const login = await fetch(`${app}/api/reconstruction/session/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user@example.com', password: 'secret' })
    });
    assert.equal(login.status, 200);
    assert.equal((await login.json()).apiKey, 'gp_live_created_for_test');
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.deepEqual(revoked, ['old-key']);

    const session = await fetch(`${app}/api/reconstruction/session`, { headers: { Cookie: cookie } });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).account.label, 'user@example.com');

    const logout = await fetch(`${app}/api/reconstruction/session`, {
        method: 'DELETE',
        headers: { Cookie: cookie }
    });
    assert.equal(logout.status, 204);
    const expired = await fetch(`${app}/api/reconstruction/session`, { headers: { Cookie: cookie } });
    assert.equal(expired.status, 401);

    const mismatch = await fetch(`${app}/api/reconstruction/session/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            firstName: 'Ada',
            lastName: 'Lovelace',
            email: 'ada@example.com',
            password: 'secret',
            confirmPassword: 'different'
        })
    });
    assert.equal(mismatch.status, 400);
    assert.equal((await mismatch.json()).code, 'password_mismatch');
    assert.deepEqual(registrations, []);

    const registration = await fetch(`${app}/api/reconstruction/session/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            firstName: 'Ada',
            lastName: 'Lovelace',
            email: 'ada@example.com',
            password: 'secret',
            confirmPassword: 'secret'
        })
    });
    assert.equal(registration.status, 201);
    assert.deepEqual(registrations, [{
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'ada@example.com',
        password: 'secret'
    }]);

    const direct = await fetch(`${app}/api/reconstruction/session/api-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: 'gp_live_direct_for_test' })
    });
    assert.equal(direct.status, 200);
    assert.equal((await direct.json()).account.customerId, 'direct-user');
    const directCookie = direct.headers.get('set-cookie');

    const recent = await fetch(`${app}/api/reconstruction/runs`, {
        headers: { Cookie: directCookie }
    });
    assert.equal(recent.status, 200);
    assert.deepEqual((await recent.json()).datasets, [{
        dataset_id: 'dataset-1',
        label: 'Existing capture',
        image_count: 42,
        bytes: 123456,
        created: 1700000000,
        run_counts: {}
    }]);

    const quote = await fetch(`${app}/api/reconstruction/datasets/dataset-1/quote?pipeline=photogrammetry`, {
        headers: { Cookie: directCookie }
    });
    assert.equal(quote.status, 200);
    assert.deepEqual(quotes, [{ dataset: 'dataset-1', pipeline: 'photogrammetry' }]);

    const invalidQuote = await fetch(`${app}/api/reconstruction/datasets/dataset-1/quote?pipeline=unknown`, {
        headers: { Cookie: directCookie }
    });
    assert.equal(invalidQuote.status, 400);

    const job = await fetch(`${app}/api/reconstruction/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: directCookie },
        body: JSON.stringify({
            datasetId: 'dataset-1',
            pipeline: 'photogrammetry',
            preset: 'standard',
            idempotencyKey: 'photo-idempotency-key'
        })
    });
    assert.equal(job.status, 202);
    assert.equal((await job.json()).jobId, 'photo-job');
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].pipeline_name, 'photogrammetry');
    assert.deepEqual(submissions[0].config, {
        sparse_subdir: 'sparse/0_geo',
        image_subdir: 'images_4',
        run_downscale: true,
        run_feature: true,
        run_matching: true,
        run_mapper: true,
        run_sor: true,
        downscale_factor: 4,
        geo_register: true,
        run_georef: true,
        run_ortho: true,
        run_name: 'standard',
        data_dir: 'dataset-1'
    });
    assert.equal(uploadSessions, 0, 'reusing an existing dataset must not create an upload session');
});

test('a splat run name is placed at the published nested path, merging not replacing', async (context) => {
    const submissions = [];
    const gateway = createServer(async (req, res) => {
        const url = new URL(req.url, 'http://x');
        if (req.method === 'GET' && url.pathname === '/v1/pipelines') {
            sendJson(res, 200, [{ name: 'splat', label: 'Splat', supports_viewer: true,
                run_name_field: 'train.result_name' }]);
        } else if (req.method === 'GET' &&
            url.pathname === '/v1/pipelines/splat/presets/standard') {
            sendJson(res, 200, {
                name: 'standard',
                config: { train: { iterations: 30000, sh_degree: 3 }, other: 1 }
            });
        } else if (req.method === 'GET' && url.pathname === '/billing/credits') {
            sendJson(res, 200, { customer_id: 'c1', balance: 10, billable: true });
        } else if (req.method === 'POST' && url.pathname === '/v1/jobs') {
            let body = '';
            for await (const chunk of req) body += chunk;
            submissions.push(JSON.parse(body));
            sendJson(res, 202, { job_id: 'splat-job' });
        } else {
            sendJson(res, 404, { detail: `Unexpected ${req.method} ${url.pathname}` });
        }
    });
    const gatewayPort = await listenOnRandomPort(gateway);
    context.after(() => gateway.close());
    const app = await startApp(context, gatewayPort);
    const cookie = await signInWithApiKey(app);

    const job = await fetch(`${app}/api/reconstruction/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ datasetId: 'ds1', pipeline: 'splat', runName: 'standard-2' })
    });

    assert.equal(job.status, 202);
    assert.deepEqual(submissions[0].config.train,
        { iterations: 30000, sh_degree: 3, result_name: 'standard-2' });
    assert.equal(submissions[0].config.other, 1);
    assert.equal(submissions[0].config.run_name, undefined);
});
