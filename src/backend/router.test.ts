import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type BackendEnv, handle } from './router';

const limiterFor = (success: boolean) => {
    const keys: string[] = [];
    return {
        keys,
        limit: async ({ key }: { key: string }) => {
            keys.push(key);
            return { success };
        }
    };
};

test('sign-in routes are rate limited per client IP', async () => {
    const cases = [
        { path: '/api/reconstruction/auth/start', method: 'GET', success: true, status: 503, limited: true },
        { path: '/api/reconstruction/auth/start', method: 'GET', success: false, status: 429, limited: true },
        { path: '/api/reconstruction/session/api-key', method: 'POST', success: true, status: 400, limited: true },
        { path: '/api/reconstruction/session/api-key', method: 'POST', success: false, status: 429, limited: true },
        { path: '/api/reconstruction/session/register', method: 'GET', success: false, status: 200, limited: false }
    ];
    for (const { path, method, success, status, limited } of cases) {
        const limiter = limiterFor(success);
        const env = {
            EYRIE_ACCOUNTS_URL: 'https://accounts.invalid',
            SIGN_IN_LIMITER: limiter
        } as unknown as BackendEnv;
        const response = await handle(new Request(`https://editor.test${path}`, {
            method,
            headers: { 'CF-Connecting-IP': '203.0.113.7', 'Content-Type': 'application/json' },
            ...(method === 'POST' ? { body: '{}' } : {})
        }), env);
        const label = `${method} ${path} success=${success}`;
        assert.equal(response.status, status, label);
        assert.deepEqual(limiter.keys, limited ? ['203.0.113.7'] : [], label);
        if (status === 429) {
            assert.equal(response.headers.get('Retry-After'), '60', label);
            assert.equal((await response.json()).code, 'rate_limited', label);
        }
    }
});
