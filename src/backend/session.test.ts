import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openSession, readCookie, sealSession, sessionCookieHeader } from './session';

const SECRET = 'test-secret-value';
const NOW = 1_770_000_000_000;
const DATA = { apiKey: 'gp_live_test', label: 'a@b.c', customerId: 'c1' };

test('a sealed session opens back to the same data', async () => {
    const token = await sealSession(DATA, SECRET, NOW);
    assert.deepEqual(await openSession(token, SECRET, NOW), DATA);
});

test('a token sealed under another secret does not open', async () => {
    const token = await sealSession(DATA, SECRET, NOW);
    assert.equal(await openSession(token, 'other-secret', NOW), null);
});

test('a tampered token does not open', async () => {
    const token = await sealSession(DATA, SECRET, NOW);
    const at = token.length - 2;
    const tampered =
        `${token.slice(0, at)}${token[at] === 'A' ? 'B' : 'A'}${token.slice(at + 1)}`;
    assert.equal(await openSession(tampered, SECRET, NOW), null);
});

test('an expired token does not open', async () => {
    const token = await sealSession(DATA, SECRET, NOW);
    assert.equal(await openSession(token, SECRET, NOW + 604800001), null);
});

test('garbage does not open and does not throw', async () => {
    assert.equal(await openSession('not-a-token', SECRET, NOW), null);
    assert.equal(await openSession('', SECRET, NOW), null);
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
