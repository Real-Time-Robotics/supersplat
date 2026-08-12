import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { call, envFor, listenOnRandomPort, sendJson, signInWithApiKey } from './test-support.mjs';

/** A gateway that counts what the session layer asks of it. */
const gatewayFor = (state) => createServer(async (req, res) => {
    const url = new URL(req.url, state.issuer);
    if (req.method === 'GET' && url.pathname === '/v1/config') {
        sendJson(res, 200, { oidc_issuer: state.issuer, oidc_client_id: 'supersplat-test' });
    } else if (req.method === 'POST' && url.pathname === '/protocol/openid-connect/token') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const grant = new URLSearchParams(body).get('grant_type');
        state.grants.push(grant);
        if (grant === 'refresh_token' && state.refuseRefresh) {
            sendJson(res, 400, { error: 'invalid_grant' });
            return;
        }
        state.issued += 1;
        sendJson(res, 200, {
            access_token: `access-${state.issued}`,
            refresh_token: `refresh-${state.issued}`,
            expires_in: state.expiresIn ?? 300
        });
    } else if (url.pathname.startsWith('/v1/api-keys')) {
        state.keyCalls.push(`${req.method} ${url.pathname}`);
        sendJson(res, 200, { keys: [] });
    } else if (req.method === 'GET' && url.pathname === '/billing/credits') {
        const presented = String(req.headers.authorization || '').replace('Bearer ', '');
        state.presented.push(presented);
        if (state.rejectUntil && presented !== state.rejectUntil) {
            sendJson(res, 401, { detail: 'expired', code: 'unauthorized' });
            return;
        }
        sendJson(res, 200, { customer_id: 'c1', balance: 10, billable: true });
    } else {
        sendJson(res, 404, { detail: `Unexpected ${req.method} ${url.pathname}` });
    }
});

const worldFor = async (context, overrides = {}) => {
    const state = {
        grants: [], keyCalls: [], presented: [], issued: 0, issuer: '', ...overrides
    };
    const gateway = gatewayFor(state);
    const port = await listenOnRandomPort(gateway);
    state.issuer = `http://127.0.0.1:${port}`;
    context.after(() => gateway.close());
    return { state, env: envFor(port) };
};

const signIn = async (env) => {
    const response = await call(env, '/api/reconstruction/session/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user@example.com', password: 'secret' })
    });
    assert.equal(response.status, 200);
    return response.headers.getSetCookie()[0].split(';')[0];
};

test('signing in never touches the api-key endpoints', async (context) => {
    const { state, env } = await worldFor(context);
    await signIn(env);
    assert.deepEqual(state.keyCalls, []);
});

test('a second login leaves the first device signed in', async (context) => {
    const { env } = await worldFor(context);
    const first = await signIn(env);
    const second = await signIn(env);

    assert.notEqual(first, second, 'a new login is always a new session id');
    for (const cookie of [first, second]) {
        const answer = await call(env, '/api/reconstruction/session', { headers: { Cookie: cookie } });
        assert.equal(answer.status, 200);
    }
});

test('an upstream rejection is retried once against a renewed token', async (context) => {
    // The first access token is refused; the session renews and replays, and the second
    // attempt is the one the browser sees.
    const { state, env } = await worldFor(context, { rejectUntil: 'access-2' });
    const cookie = await signIn(env);

    const answer = await call(env, '/api/reconstruction/credits', { headers: { Cookie: cookie } });

    assert.equal(answer.status, 200);
    assert.deepEqual(state.grants, ['password', 'refresh_token']);
    // The first entry is the login's own credits lookup; the route then presents
    // access-1 once, is refused, and replays exactly once with the renewed token.
    assert.deepEqual(state.presented, ['access-1', 'access-1', 'access-2']);
});

test('a refusal that survives the renewal ends the session', async (context) => {
    const { state, env } = await worldFor(context, { rejectUntil: 'never-valid' });
    const cookie = await signIn(env);

    const answer = await call(env, '/api/reconstruction/credits', { headers: { Cookie: cookie } });

    assert.equal(answer.status, 401);
    assert.equal((await answer.json()).code, 'session_expired');
    assert.equal(state.grants.filter(grant => grant === 'refresh_token').length, 1,
        'one renewal, not a retry loop');

    const after = await call(env, '/api/reconstruction/session', { headers: { Cookie: cookie } });
    assert.equal(after.status, 401, 'the session is gone, not merely refused once');
});

test('a refresh Keycloak refuses logs the session out', async (context) => {
    const { env, state } = await worldFor(context, { expiresIn: 1 });
    const cookie = await signIn(env);
    state.refuseRefresh = true;

    const answer = await call(env, '/api/reconstruction/session', { headers: { Cookie: cookie } });

    assert.equal(answer.status, 401);
    assert.equal((await answer.json()).code, 'session_expired');
});

test('a session id nobody minted buys nothing', async (context) => {
    const { env } = await worldFor(context);
    const answer = await call(env, '/api/reconstruction/session', {
        headers: { Cookie: 'genesis_reconstruction_session=made-up-id' }
    });
    assert.equal(answer.status, 401);
});

test('an api-key login works, and the key is never readable afterwards', async (context) => {
    const { env } = await worldFor(context);
    const cookie = await signInWithApiKey(env, 'gp_live_direct');

    const session = await call(env, '/api/reconstruction/session', { headers: { Cookie: cookie } });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).account.customerId, 'c1');
    assert.ok(!cookie.includes('gp_live_'), 'the cookie is an id, not the key');

    const reveal = await call(env, '/api/reconstruction/session/api-key', {
        headers: { Cookie: cookie }
    });
    assert.equal(reveal.status, 404, 'there is no endpoint that reads a credential back');
});

test('the object still answers after a logout wiped its database', async (context) => {
    // deleteAll() on a SQLite-backed object drops the tables, and the object stays in
    // memory: the request right after a logout used to meet "no such table: session".
    const { env } = await worldFor(context);
    const cookie = await signIn(env);

    const out = await call(env, '/api/reconstruction/session', {
        method: 'DELETE', headers: { Cookie: cookie }
    });
    assert.equal(out.status, 204);

    const replay = await call(env, '/api/reconstruction/session', { headers: { Cookie: cookie } });
    assert.equal(replay.status, 401, 'refused, not crashed');
    assert.equal((await replay.json()).code, 'session_expired');

    // And the id is reusable as a fresh object rather than poisoned for good.
    const again = await signIn(env);
    const answer = await call(env, '/api/reconstruction/session', { headers: { Cookie: again } });
    assert.equal(answer.status, 200);
});

test('a session gets an alarm to clear itself out even if nobody returns', async (context) => {
    const { env } = await worldFor(context);
    const cookie = await signIn(env);
    const id = decodeURIComponent(cookie.split('=').slice(1).join('='));
    const storage = env.RECON_SESSIONS.storageOf(id);

    const at = await storage.getAlarm();
    assert.ok(at > Date.now(), 'the cleanup is scheduled, not left to chance');

    await env.RECON_SESSIONS.get(id).alarm();

    assert.equal(await storage.getAlarm(), null);
    const replay = await call(env, '/api/reconstruction/session', { headers: { Cookie: cookie } });
    assert.equal(replay.status, 401, 'the refresh token did not outlive the session');
});

test('logout leaves no alarm behind for an object that no longer exists', async (context) => {
    const { env } = await worldFor(context);
    const cookie = await signIn(env);
    const id = decodeURIComponent(cookie.split('=').slice(1).join('='));

    await call(env, '/api/reconstruction/session', { method: 'DELETE', headers: { Cookie: cookie } });

    assert.equal(await env.RECON_SESSIONS.storageOf(id).getAlarm(), null);
});

test('a missing Durable Object binding fails closed', async (context) => {
    const { env } = await worldFor(context);
    const cookie = await signIn(env);
    const crippled = { ...env, RECON_SESSIONS: undefined };

    const answer = await call(crippled, '/api/reconstruction/session', {
        headers: { Cookie: cookie }
    });

    // 503, never 200: with no session storage nothing can be authenticated, and a 401
    // would be indistinguishable from a working app that is merely logged out.
    assert.equal(answer.status, 503);
    assert.equal((await answer.json()).code, 'sessions_unavailable');
});
