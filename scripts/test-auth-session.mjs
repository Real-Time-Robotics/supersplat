import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';

const listenOnRandomPort = async (server) => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server.address().port;
};

const sendJson = (res, status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
};

const waitForServer = async (url, child) => {
    for (let attempt = 0; attempt < 50; attempt++) {
        if (child.exitCode != null) throw new Error(`SuperSplat server exited with ${child.exitCode}`);
        try {
            const response = await fetch(url);
            if (response.status === 401) return;
        } catch {
            // The listener may not be ready yet.
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Timed out waiting for SuperSplat server.');
};

test('login, registration, direct key, and logout use isolated cookie sessions', async (context) => {
    const registrations = [];
    const revoked = [];
    let issuer = '';
    const gateway = createServer(async (req, res) => {
        const url = new URL(req.url, issuer);
        if (req.method === 'GET' && url.pathname === '/v1/config') {
            sendJson(res, 200, { oidc_issuer: issuer, oidc_client_id: 'supersplat-test' });
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
        } else {
            sendJson(res, 404, { detail: `Unexpected mock route ${req.method} ${url.pathname}` });
        }
    });
    const gatewayPort = await listenOnRandomPort(gateway);
    issuer = `http://127.0.0.1:${gatewayPort}`;

    const portProbe = createServer();
    const appPort = await listenOnRandomPort(portProbe);
    await new Promise(resolve => portProbe.close(resolve));
    const child = spawn(process.execPath, ['server.mjs'], {
        cwd: new URL('..', import.meta.url),
        env: { ...process.env, GENESIS_BASE_URL: issuer, PORT: String(appPort) },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    context.after(async () => {
        child.kill();
        gateway.close();
        await Promise.allSettled([once(child, 'exit'), once(gateway, 'close')]);
    });

    const app = `http://127.0.0.1:${appPort}`;
    await waitForServer(`${app}/api/reconstruction/session`, child);

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
});
