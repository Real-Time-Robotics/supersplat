import assert from 'node:assert/strict';
import { test } from 'node:test';

import { limiterNamespace } from '../../scripts/session-namespace.mjs';
import { type BackendEnv, handle } from './router';

test('sign-in routes allow ten attempts a minute per client IP', async () => {
    const cases = [
        { path: '/api/reconstruction/auth/start', method: 'GET', allowed: 503, refused: 303 },
        { path: '/api/reconstruction/session/api-key', method: 'POST', allowed: 400, refused: 429 },
        { path: '/api/reconstruction/session/register', method: 'GET', allowed: 200, refused: 200 }
    ];
    for (const { path, method, allowed, refused } of cases) {
        const env = {
            EYRIE_ACCOUNTS_URL: 'https://accounts.invalid',
            RATE_LIMITER: limiterNamespace()
        } as unknown as BackendEnv;
        const attempt = (ip: string) => handle(new Request(`https://editor.test${path}`, {
            method,
            headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' },
            ...(method === 'POST' ? { body: '{}' } : {})
        }), env);
        const label = `${method} ${path}`;

        const statuses = [];
        for (let i = 0; i < 10; i++) statuses.push((await attempt('203.0.113.7')).status);
        const eleventh = await attempt('203.0.113.7');
        const neighbour = await attempt('198.51.100.9');

        assert.deepEqual(statuses, Array(10).fill(allowed), label);
        assert.equal(eleventh.status, refused, label);
        assert.equal(neighbour.status, allowed, label);
        if (refused === allowed) continue;
        const retryAfter = Number(eleventh.headers.get('Retry-After'));
        assert.ok(retryAfter >= 1 && retryAfter <= 60, `${label} Retry-After ${retryAfter}`);
        if (refused === 303) {
            assert.equal(eleventh.headers.get('Location'), 'https://editor.test/?sign_in=rate_limited', label);
        } else {
            assert.equal((await eleventh.json()).code, 'rate_limited', label);
        }
    }
});
