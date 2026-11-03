import assert from 'node:assert/strict';
import { test } from 'node:test';

import { limiterNamespace } from '../../scripts/session-namespace.mjs';

test('a limiter window reopens and clears itself once it has passed', async (context) => {
    context.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    const limiters = limiterNamespace();
    const limiter = limiters.get('sign-in:203.0.113.7');
    const storage = limiters.storageOf('sign-in:203.0.113.7');

    for (let i = 0; i < 2; i++) assert.equal((await limiter.hit(2, 60)).allowed, true);
    assert.equal(await storage.getAlarm(), 1_060_000);

    context.mock.timers.tick(45_500);
    assert.deepEqual(await limiter.hit(2, 60), { allowed: false, retryAfter: 15 });

    context.mock.timers.tick(14_500);
    await limiter.alarm();
    assert.equal(await storage.get('window'), undefined);
    assert.deepEqual(await limiter.hit(2, 60), { allowed: true, retryAfter: 0 });
    assert.equal(await storage.getAlarm(), 1_120_000);
});
