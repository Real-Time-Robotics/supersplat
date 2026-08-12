import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    SESSION_LIFETIME_MS,
    SessionState,
    type SessionRecord,
    type SessionStorage,
    newSessionId,
    readCookie,
    sessionCookieHeader
} from './session';

const memory = (): SessionStorage & { record: SessionRecord | null } => ({
    record: null,
    read() {
        return this.record;
    },
    write(record: SessionRecord) {
        this.record = record;
    },
    clear() {
        this.record = null;
    }
});

const clock = (start = 1_770_000_000_000) => {
    const state = { now: start };
    return {
        at: () => state.now,
        advance: (ms: number) => {
            state.now += ms;
        }
    };
};

const stateFor = (deps: {
    refreshTokens?: (token: string) => Promise<any>;
    now?: () => number;
} = {}) => {
    const storage = memory();
    return {
        storage,
        session: new SessionState(storage, {
            refreshTokens: deps.refreshTokens ??
                (async () => ({ accessToken: 'a2', refreshToken: 'r2', expiresIn: 300 })),
            now: deps.now
        })
    };
};

test('a session id is opaque and does not repeat', () => {
    const ids = new Set(Array.from({ length: 64 }, newSessionId));
    assert.equal(ids.size, 64);
    for (const id of ids) assert.ok(id.length >= 40, 'at least 32 bytes of entropy');
});

test('an api-key session hands back the key without ever touching a token endpoint', async () => {
    const { session } = stateFor({
        refreshTokens: async () => assert.fail('an api key never refreshes')
    });
    session.create({ kind: 'api-key', apiKey: 'gp_live_x', label: 'me', customerId: 'c1' });

    const credential = await session.credential();
    assert.equal(credential?.token, 'gp_live_x');
    assert.equal(credential?.kind, 'api-key');
});

test('an oidc session serves its access token until the margin, then renews once', async () => {
    const time = clock();
    let refreshes = 0;
    const { session } = stateFor({
        now: time.at,
        refreshTokens: async () => {
            refreshes += 1;
            return { accessToken: 'a2', refreshToken: 'r2', expiresIn: 300 };
        }
    });
    session.create({
        kind: 'oidc',
        accessToken: 'a1',
        refreshToken: 'r1',
        expiresIn: 300,
        label: 'me',
        customerId: 'c1'
    });

    assert.equal((await session.credential())?.token, 'a1');
    assert.equal(refreshes, 0);

    time.advance(299_000);
    assert.equal((await session.credential())?.token, 'a2');
    assert.equal(refreshes, 1);
    assert.equal((await session.credential())?.token, 'a2', 'the renewal is durable');
    assert.equal(refreshes, 1);
});

test('concurrent requests through an expiring token refresh exactly once', async () => {
    const time = clock();
    let refreshes = 0;
    let release: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    const { session } = stateFor({
        now: time.at,
        refreshTokens: async () => {
            refreshes += 1;
            await gate;
            return { accessToken: 'a2', refreshToken: 'r2', expiresIn: 300 };
        }
    });
    session.create({
        kind: 'oidc',
        accessToken: 'a1',
        refreshToken: 'r1',
        expiresIn: 1,
        label: 'me',
        customerId: 'c1'
    });

    const inFlight = [session.credential(), session.credential(), session.credential()];
    release(null);
    const answers = await Promise.all(inFlight);

    assert.equal(refreshes, 1, 'a refresh storm is what the coalescing is for');
    assert.deepEqual(answers.map(answer => answer?.token), ['a2', 'a2', 'a2']);
});

test('a refresh that fails ends the session rather than falling back', async () => {
    const { session, storage } = stateFor({
        refreshTokens: async () => {
            throw new Error('keycloak said no');
        }
    });
    session.create({
        kind: 'oidc',
        accessToken: 'a1',
        refreshToken: 'r1',
        expiresIn: 0,
        label: 'me',
        customerId: 'c1'
    });

    assert.equal(await session.credential(), null);
    assert.equal(storage.record, null, 'nothing usable may survive a failed refresh');
});

test('an oidc session with no refresh token dies with its access token', async () => {
    const time = clock();
    const { session } = stateFor({
        now: time.at,
        refreshTokens: async () => assert.fail('there is no refresh token to present')
    });
    session.create({
        kind: 'oidc',
        accessToken: 'a1',
        refreshToken: '',
        expiresIn: 300,
        label: 'me',
        customerId: 'c1'
    });

    assert.equal((await session.credential())?.token, 'a1');
    time.advance(300_000);
    assert.equal(await session.credential(), null);
});

test('the absolute lifetime is not extended by activity', async () => {
    const time = clock();
    const { session } = stateFor({ now: time.at });
    session.create({ kind: 'api-key', apiKey: 'gp_live_x', label: 'me', customerId: 'c1' });

    time.advance(SESSION_LIFETIME_MS - 1000);
    assert.ok(await session.credential());
    time.advance(2000);
    assert.equal(await session.credential(), null);
});

test('an expired session is cleaned out, not merely refused', async () => {
    const time = clock();
    const { session, storage } = stateFor({ now: time.at });
    session.create({ kind: 'api-key', apiKey: 'gp_live_x', label: 'me', customerId: 'c1' });

    time.advance(SESSION_LIFETIME_MS + 1);
    assert.equal(await session.credential(), null);
    assert.equal(storage.record, null);
});

test('destroy leaves nothing to serve', async () => {
    const { session } = stateFor();
    session.create({ kind: 'api-key', apiKey: 'gp_live_x', label: 'me', customerId: 'c1' });
    session.destroy();
    assert.equal(await session.credential(), null);
});

test('an api-key session cannot be reauthenticated, only ended', async () => {
    const { session, storage } = stateFor();
    session.create({ kind: 'api-key', apiKey: 'gp_live_x', label: 'me', customerId: 'c1' });

    assert.equal(await session.reauthenticate(), null);
    assert.equal(storage.record, null, 'a revoked key has no renewal path');
});

test('readCookie finds one value among several', () => {
    const request = new Request('https://e.example/api/x', {
        headers: { cookie: 'a=1; genesis_reconstruction_session=abc%3Ddef; b=2' }
    });
    assert.equal(readCookie(request, 'genesis_reconstruction_session'), 'abc=def');
    assert.equal(readCookie(request, 'missing'), null);
});

test('the cookie header carries the fixed attributes', () => {
    const header = sessionCookieHeader('tok', { secure: true, maxAgeSeconds: 100 });
    assert.match(header, /^genesis_reconstruction_session=tok;/);
    for (const part of ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=100', 'Secure']) {
        assert.ok(header.includes(part), `missing ${part}`);
    }
    assert.ok(!sessionCookieHeader('tok', { secure: false, maxAgeSeconds: 0 }).includes('Secure'));
});
