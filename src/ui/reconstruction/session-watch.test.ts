import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SessionWatch } from './session-watch';

const MINUTE = 60_000;

/** A watch on a clock and a timer we drive by hand, so no test waits on real time. */
const harness = () => {
    let now = 1_770_000_000_000;
    let armed: { fn: () => unknown; delay: number; id: number } | null = null;
    let id = 0;
    const expiries: number[] = [];

    const watch = new SessionWatch(() => expiries.push(now), {
        now: () => now,
        setTimer: (fn, delay) => {
            id += 1;
            armed = { fn, delay, id };
            return id;
        },
        clearTimer: (handle) => {
            if (armed?.id === handle) armed = null;
        }
    });

    return {
        watch,
        expiries,
        at: () => now,
        armed: () => armed,
        advance: (ms: number) => {
            now += ms;
        },
        /** Run the armed timer the way the browser would once its delay has elapsed. */
        fire: async () => {
            const due = armed;
            assert.ok(due, 'no timer was armed');
            now += due.delay;
            armed = null;
            await due.fn();
        }
    };
};

const soon = (h: ReturnType<typeof harness>, ms: number) => h.at() + ms;

test('a live session sleeps until its exact deadline without periodic probes', () => {
    const h = harness();
    h.watch.arm(soon(h, 7 * 24 * 60 * MINUTE));
    assert.equal(h.armed()?.delay, 7 * 24 * 60 * MINUTE);
});

test('the session ends when its deadline arrives', async () => {
    const h = harness();
    h.watch.arm(soon(h, MINUTE));
    await h.fire();
    assert.equal(h.expiries.length, 1);
    assert.equal(h.armed(), null, 'an ended session is not watched further');
});

test('a deadline that passed while the tab slept is caught on the next wake-up', async () => {
    const h = harness();
    h.watch.arm(soon(h, MINUTE));
    h.advance(60 * MINUTE);          // laptop shut: the timer never ran
    await h.watch.wake();
    assert.equal(h.expiries.length, 1);
});

test('a wake-up inside the deadline only re-arms the remaining exact delay', async () => {
    const h = harness();
    h.watch.arm(soon(h, 10 * MINUTE));
    h.advance(MINUTE);
    await h.watch.wake();
    assert.deepEqual(h.expiries, []);
    assert.equal(h.armed()?.delay, 9 * MINUTE);
});

test('disarming stops the watch outright', async () => {
    const h = harness();
    h.watch.arm(soon(h, MINUTE));
    h.watch.disarm();
    assert.equal(h.armed(), null);

    h.advance(10 * MINUTE);
    await h.watch.wake();
    assert.deepEqual(h.expiries, [], 'a signed-out session is nobody to expire');
});

test('a server that reports no deadline is watched by nothing at all', async () => {
    const h = harness();
    h.watch.arm(null);
    assert.equal(h.armed(), null);
    await h.watch.wake();
    assert.deepEqual(h.expiries, []);
});

test('re-arming replaces the previous deadline rather than stacking on it', () => {
    const h = harness();
    h.watch.arm(soon(h, 7 * 24 * 60 * MINUTE));
    const first = h.armed()?.id;
    h.watch.arm(soon(h, MINUTE));
    assert.notEqual(h.armed()?.id, first);
    assert.equal(h.armed()?.delay, MINUTE);
});
