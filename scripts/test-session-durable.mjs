import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { call, envFor, listenOnRandomPort, sendJson, signInWithApiKey } from './test-support.mjs';

const deferred = () => {
    let resolve = () => {};
    const promise = new Promise(done => {
        resolve = done;
    });
    return { promise, resolve };
};

const gatewayFor = (state) => createServer(async (req, res) => {
    const url = new URL(req.url, state.issuer);
    if (req.method === 'GET' && url.pathname === '/v1/config') {
        sendJson(res, 200, { oidc_issuer: state.issuer, oidc_client_id: 'supersplat-test' });
    } else if (req.method === 'POST' && url.pathname === '/protocol/openid-connect/token') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const grant = new URLSearchParams(body).get('grant_type');
        state.grants.push(grant);
        if (grant === 'refresh_token' && state.refreshGate) {
            state.refreshGate.started.resolve();
            await state.refreshGate.release.promise;
        }
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
    } else if (req.method === 'POST' && url.pathname === '/v1/replay') {
        const presented = String(req.headers.authorization || '').replace('Bearer ', '');
        let body = '';
        for await (const chunk of req) body += chunk;
        state.replayBodies.push(body);
        if (state.rejectUntil && presented !== state.rejectUntil) {
            sendJson(res, 401, { detail: 'expired', code: 'unauthorized' });
            return;
        }
        sendJson(res, 200, { ok: true });
    } else {
        sendJson(res, 404, { detail: `Unexpected ${req.method} ${url.pathname}` });
    }
});

const worldFor = async (context, overrides = {}) => {
    const state = {
        grants: [], keyCalls: [], presented: [], replayBodies: [], issued: 0, issuer: '',
        ...overrides
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
    const { state, env } = await worldFor(context, { rejectUntil: 'access-2' });
    const cookie = await signIn(env);

    const answer = await call(env, '/api/reconstruction/credits', { headers: { Cookie: cookie } });

    assert.equal(answer.status, 200);
    assert.deepEqual(state.grants, ['password', 'refresh_token']);
    assert.deepEqual(state.presented, ['access-1', 'access-1', 'access-2']);
});

test('an unbounded request body is not buffered for credential replay', async (context) => {
    const { state, env } = await worldFor(context, { rejectUntil: 'access-2' });
    const cookie = await signIn(env);
    const body = new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode('streamed-body'));
            controller.close();
        }
    });

    const answer = await call(env, '/api/gp/v1/replay', {
        method: 'POST', headers: { Cookie: cookie }, body, duplex: 'half'
    });

    assert.equal(answer.status, 409);
    assert.equal((await answer.json()).code, 'credential_refreshed_retry_required');
    assert.deepEqual(state.replayBodies, ['streamed-body']);
    assert.deepEqual(state.grants, ['password', 'refresh_token']);
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
    const before = env.RECON_SESSIONS.count();
    const answer = await call(env, '/api/reconstruction/session', {
        headers: { Cookie: 'genesis_reconstruction_session=made-up-id' }
    });
    assert.equal(answer.status, 401);
    assert.equal(env.RECON_SESSIONS.count(), before);
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
    const { env } = await worldFor(context);
    const cookie = await signIn(env);

    const out = await call(env, '/api/reconstruction/session', {
        method: 'DELETE', headers: { Cookie: cookie }
    });
    assert.equal(out.status, 204);
    assert.deepEqual(env.RECON_SESSIONS.storageOf(
        decodeURIComponent(cookie.split('=').slice(1).join('='))).tableNames(), []);

    const replay = await call(env, '/api/reconstruction/session', { headers: { Cookie: cookie } });
    assert.equal(replay.status, 401, 'refused, not crashed');
    assert.equal((await replay.json()).code, 'session_expired');

    const again = await signIn(env);
    const answer = await call(env, '/api/reconstruction/session', { headers: { Cookie: again } });
    assert.equal(answer.status, 200);
});

test('the schema is built once per object, and again only after a wipe', async (context) => {
    const { env } = await worldFor(context);
    const cookie = await signIn(env);
    const id = decodeURIComponent(cookie.split('=').slice(1).join('='));
    const storage = env.RECON_SESSIONS.storageOf(id);

    const created = [];
    const exec = storage.sql.exec.bind(storage.sql);
    storage.sql.exec = (query, ...bindings) => {
        if (/CREATE TABLE/i.test(query)) created.push(query);
        return exec(query, ...bindings);
    };

    for (let i = 0; i < 3; i++) {
        await call(env, '/api/reconstruction/session', { headers: { Cookie: cookie } });
    }
    assert.equal(created.length, 0, 'a live object re-runs no DDL on the read path');

    await call(env, '/api/reconstruction/session', {
        method: 'DELETE', headers: { Cookie: cookie }
    });
    await call(env, '/api/reconstruction/session', { headers: { Cookie: cookie } });
    assert.equal(created.length, 1, 'a wiped database is rebuilt exactly once');
});

test('an object created before lease versioning is migrated in place', async (context) => {
    const { env } = await worldFor(context);
    const id = 'legacy-session';
    const object = env.RECON_SESSIONS.get(id);
    const storage = env.RECON_SESSIONS.storageOf(id);
    const now = Date.now();
    storage.sql.exec(`CREATE TABLE session(
      id                INTEGER PRIMARY KEY CHECK (id = 1),
      kind              TEXT    NOT NULL,
      access_token      TEXT    NOT NULL DEFAULT '',
      refresh_token     TEXT    NOT NULL DEFAULT '',
      access_expires_at INTEGER NOT NULL DEFAULT 0,
      api_key           TEXT    NOT NULL DEFAULT '',
      label             TEXT    NOT NULL DEFAULT '',
      customer_id       TEXT    NOT NULL DEFAULT '',
      expires_at        INTEGER NOT NULL,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    )`);
    storage.sql.exec(
        `INSERT INTO session(id, kind, api_key, label, customer_id,
                             expires_at, created_at, updated_at)
         VALUES(1, 'api-key', 'gp_live_legacy', 'Legacy', 'c1', ?, ?, ?)`,
        now + 60_000, now, now
    );

    const answer = await object.fetch(new Request('https://session.invalid/credential', {
        method: 'POST'
    }));

    assert.equal(answer.status, 200);
    assert.equal((await answer.json()).token, 'gp_live_legacy');
    const columns = storage.sql.exec('PRAGMA table_info(session)').toArray();
    assert.ok(columns.some(column => column.name === 'version'));
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
    assert.deepEqual(storage.tableNames(), []);
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

test('logout wins when an access-token refresh is already in flight', async (context) => {
    const refreshGate = { started: deferred(), release: deferred() };
    const { env } = await worldFor(context, { expiresIn: 1, refreshGate });
    const cookie = await signIn(env);
    const id = decodeURIComponent(cookie.split('=').slice(1).join('='));

    const refreshing = call(env, '/api/reconstruction/session', { headers: { Cookie: cookie } });
    await refreshGate.started.promise;
    const logout = await call(env, '/api/reconstruction/session', {
        method: 'DELETE', headers: { Cookie: cookie }
    });
    assert.equal(logout.status, 204);
    assert.deepEqual(env.RECON_SESSIONS.storageOf(id).tableNames(), []);

    refreshGate.release.resolve();
    assert.equal((await refreshing).status, 401);
    const replay = await call(env, '/api/reconstruction/session', { headers: { Cookie: cookie } });
    assert.equal(replay.status, 401);
    assert.deepEqual(env.RECON_SESSIONS.storageOf(id).tableNames(), []);
});

test('a missing Durable Object binding fails closed', async (context) => {
    const { env } = await worldFor(context);
    const cookie = await signIn(env);
    const crippled = { ...env, RECON_SESSIONS: undefined };

    const answer = await call(crippled, '/api/reconstruction/session', {
        headers: { Cookie: cookie }
    });

    assert.equal(answer.status, 503);
    assert.equal((await answer.json()).code, 'sessions_unavailable');
});
