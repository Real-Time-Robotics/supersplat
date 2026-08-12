import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { onSessionEnded, reconFetch, sessionIsOver, sessionRestored } from './reconstruction-http';

const answer = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' }
});

const install = (responder: (path: string) => Response) => {
    const calls: string[] = [];
    (globalThis as any).fetch = async (path: string) => {
        calls.push(path);
        return responder(path);
    };
    return calls;
};

beforeEach(() => sessionRestored());

test('a successful call passes the response through untouched', async () => {
    install(() => answer(200, { ok: true }));
    const response = await reconFetch('/api/reconstruction/credits');
    assert.equal(response.status, 200);
    assert.equal(sessionIsOver(), false);
});

test('a 401 ends the session for every listener', async () => {
    install(() => answer(401, { code: 'session_expired' }));
    const told: string[] = [];
    onSessionEnded(() => told.push('account'));
    onSessionEnded(() => told.push('watchers'));

    await reconFetch('/api/reconstruction/credits');

    assert.deepEqual(told, ['account', 'watchers']);
    assert.equal(sessionIsOver(), true);
});

test('several calls racing into the same expiry announce it once', async () => {
    install(() => answer(401, { code: 'session_expired' }));
    let announcements = 0;
    onSessionEnded(() => {
        announcements += 1;
    });

    await Promise.all([
        reconFetch('/api/reconstruction/credits'),
        reconFetch('/api/reconstruction/runs'),
        reconFetch('/api/reconstruction/session')
    ]);

    assert.equal(announcements, 1, 'one expiry, one trip back to the login screen');
});

test('a rejected api key at the login form is not a session ending', async () => {
    // Nothing was signed in yet; the form reports it and the user tries again.
    install(() => answer(401, { code: 'invalid_api_key' }));
    let announcements = 0;
    onSessionEnded(() => {
        announcements += 1;
    });

    await reconFetch('/api/reconstruction/session/api-key', { method: 'POST' });

    assert.equal(announcements, 0);
});

test('a 401 with no JSON body still ends the session', async () => {
    install(() => new Response('gateway said no', { status: 401 }));
    let announcements = 0;
    onSessionEnded(() => {
        announcements += 1;
    });

    await reconFetch('/api/reconstruction/credits');

    assert.equal(announcements, 1);
});

test('the body is still readable after the expiry check', async () => {
    install(() => answer(401, { code: 'session_expired', error: 'gone' }));
    const response = await reconFetch('/api/reconstruction/credits');
    assert.deepEqual(await response.json(), { code: 'session_expired', error: 'gone' });
});

test('signing in again re-arms the guard', async () => {
    install(() => answer(401, { code: 'session_expired' }));
    await reconFetch('/api/reconstruction/credits');
    assert.equal(sessionIsOver(), true);

    sessionRestored();

    let announcements = 0;
    onSessionEnded(() => {
        announcements += 1;
    });
    await reconFetch('/api/reconstruction/credits');
    assert.equal(announcements, 1, 'the next expiry is announced too');
});

test('a server error is not mistaken for an expiry', async () => {
    install(() => answer(500, { error: 'boom' }));
    let announcements = 0;
    onSessionEnded(() => {
        announcements += 1;
    });

    await reconFetch('/api/reconstruction/credits');

    assert.equal(announcements, 0);
    assert.equal(sessionIsOver(), false);
});
