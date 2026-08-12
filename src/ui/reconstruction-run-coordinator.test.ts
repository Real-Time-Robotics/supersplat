import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { RunCoordinator, canTransition } from './reconstruction-run-coordinator.ts';
import { RunStore } from './reconstruction-run-store.ts';

const run = (id: string, patch = {}) => ({
    id,
    state: 'quoting' as const,
    datasetId: 'ds1',
    pipeline: 'splat',
    preset: 'standard',
    runName: 'standard',
    submitKey: null,
    label: id,
    jobId: null,
    percent: 0,
    detail: '',
    ...patch
});

const quotaError = () => {
    const error = new Error('concurrent job quota exceeded') as Error & { status?: number; code?: string };
    error.status = 409;
    error.code = 'concurrent_job_quota_exceeded';
    return error;
};

const refuse = () => async () => {
    throw quotaError();
};

const jobDone = { terminal: true, status: 'done' };
const jobRunning = { terminal: false, status: 'running' };

/** Timers the test drives by hand: nothing here waits on the wall clock. */
const fakeTimers = () => {
    const pending = new Map<number, { fn:() => void; ms: number }>();
    let next = 1;
    return {
        pending,
        timers: {
            set: (fn: () => void, ms: number) => {
                pending.set(next, { fn, ms });
                return next++;
            },
            clear: (handle: number) => pending.delete(handle)
        },
        fire: () => [...pending.values()].forEach(entry => entry.fn()),
        interval: () => [...pending.values()][0]?.ms ?? 0
    };
};

let coordinator: RunCoordinator;
let clock: ReturnType<typeof fakeTimers>;
let submitFn: (r: any) => Promise<string>;

// One coordinator per test, with a swappable submit so a later pass can behave
// differently without discarding the cap the first pass taught it.
const coordinate = (store: RunStore, submit: (r: any) => Promise<string>,
    fetchJob: (id: string) => Promise<any> = async () => ({ terminal: false, status: 'running' })) => {
    clock = fakeTimers();
    submitFn = submit;
    coordinator = new RunCoordinator(store, {
        submit: r => submitFn(r), fetchJob, timers: clock.timers
    });
    return coordinator;
};

const coordinatorFor = (store: RunStore, submit: (r: any) => Promise<string>) => coordinate(store, submit).submitReady();

/** Another pass through the SAME coordinator, so what it learned still applies. */
const resubmit = (submit: (r: any) => Promise<string>) => {
    submitFn = submit;
    return coordinator.submitReady();
};

/** A store with one job running and one run parked behind a 409. */
const cappedStore = async () => {
    const store = new RunStore();
    store.upsert(run('a', { state: 'running', jobId: 'j1' }));
    store.upsert(run('b'));
    await coordinatorFor(store, refuse());
    return store;
};

test('a 409 parks the run without rewriting the account cap', async () => {
    const store = new RunStore();
    store.upsert(run('a', { state: 'running', jobId: 'j1' }));
    store.upsert(run('b'));
    let submits = 0;
    coordinate(store, async () => {
        submits++;
        throw quotaError();
    });
    coordinator.setSlotCap(3);
    await coordinator.submitReady();

    assert.equal(submits, 1);
    assert.equal(store.list().find(r => r.id === 'b').state, 'waiting-slot');
    assert.equal(coordinator.slotCap(), 3, 'the plan says 3; a busy moment does not say 1');
    assert.equal(coordinator.quotaBlocked(), true);
});

test('a parked run is submitted once a slot frees', async () => {
    const store = await cappedStore();
    store.place('a', 'done');
    const submitted: string[] = [];
    await resubmit(async (r) => {
        submitted.push(r.id);
        return 'j2';
    });

    assert.deepEqual(submitted, ['b']);
    assert.equal(store.list().find(r => r.id === 'b').state, 'running');
    assert.equal(store.list().find(r => r.id === 'b').jobId, 'j2');
    assert.equal(coordinator.quotaBlocked(), false);
});

test('the coordinator never exceeds the cap the plan publishes', async () => {
    const store = new RunStore();
    store.upsert(run('a', { state: 'running', jobId: 'j1' }));
    store.upsert(run('b'));
    let submits = 0;
    coordinate(store, async () => {
        submits++;
        return 'j3';
    });
    coordinator.setSlotCap(1);
    await coordinator.submitReady();

    assert.equal(submits, 0, 'one job is active and the published cap is 1');
});

test('a slot held by another tab does not strand the run forever', async () => {
    // Cap 2, one job here, one on another device. The 409 must not be read as "the cap
    // is 1": when the other device finishes, this run has to be tried again even though
    // nothing changed in this page's own list.
    const store = new RunStore();
    store.upsert(run('a', { state: 'running', jobId: 'j1' }));
    store.upsert(run('b'));
    let elsewhere = true;
    coordinate(store, async () => {
        if (elsewhere) throw quotaError();
        return 'j2';
    }, async () => jobRunning);
    coordinator.setSlotCap(2);

    await coordinator.submitReady();
    assert.equal(store.list().find(r => r.id === 'b').state, 'waiting-slot');
    assert.equal(coordinator.slotCap(), 2);

    elsewhere = false;                       // the other device's job ended
    await coordinator.pass();

    assert.equal(store.list().find(r => r.id === 'b').state, 'running');
});

test('one refusal parks the rest of the queue instead of earning its own', async () => {
    const store = new RunStore();
    store.upsert(run('a'));
    store.upsert(run('b', { datasetId: 'ds2' }));
    store.upsert(run('c', { datasetId: 'ds3' }));
    let asks = 0;
    await coordinatorFor(store, async () => {
        asks += 1;
        throw quotaError();
    });

    assert.equal(asks, 1, 'the account is full; asking twice more only makes noise');
    assert.deepEqual(store.list().map(r => r.state),
        ['waiting-slot', 'waiting-slot', 'waiting-slot']);
});

test('a new session replaces the cap and restarts a stopped scheduler', async () => {
    const store = new RunStore();
    store.upsert(run('a', { state: 'waiting-slot', submitKey: 'k1' }));
    coordinate(store, refuse(), async () => jobRunning);
    coordinator.setSlotCap(1);
    await coordinator.submitReady();
    coordinator.stop();
    assert.equal(clock.pending.size, 0);

    coordinator.beginSession(4);

    assert.equal(coordinator.slotCap(), 4, 'the new account\'s plan, not the old one\'s');
    assert.equal(coordinator.quotaBlocked(), false);
    assert.ok(clock.pending.size > 0, 'the scheduler runs again after a re-login');
});

test('a session with no published cap leaves the server to decide', () => {
    const store = new RunStore();
    coordinate(store, async () => 'j1');
    coordinator.beginSession(null);
    assert.equal(coordinator.slotCap(), null);
});

test('a repeat run of one pipeline gets a fresh run name', async () => {
    const store = new RunStore();
    store.upsert(run('b', { preset: 'standard', runName: 'standard' }));
    const names: string[] = [];
    await coordinatorFor(store, async (r) => {
        names.push(r.runName);
        return 'j1';
    });

    assert.equal(names.length, 1);
    assert.notEqual(names[0], 'standard');
    assert.ok(names[0].startsWith('standard-'), names[0]);
});

test('a retry after a lost reply resubmits under the same name and key', async () => {
    const store = new RunStore();
    store.upsert(run('a'));
    const attempts: { runName: string; submitKey: string }[] = [];
    await coordinatorFor(store, async (r) => {
        attempts.push({ runName: r.runName, submitKey: r.submitKey });
        throw new Error('502 Bad Gateway');
    });
    assert.equal(store.list()[0].state, 'failed');

    store.place('a', 'quoting');
    await coordinatorFor(store, async (r) => {
        attempts.push({ runName: r.runName, submitKey: r.submitKey });
        return 'j1';
    });

    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0], attempts[1], 'the retry must replay, not duplicate');
    assert.ok(attempts[0].submitKey);
});

test('a retry after the job ended carries a new name and key', async () => {
    const store = new RunStore();
    store.upsert(run('a'));
    const attempts: { runName: string; submitKey: string }[] = [];
    const record = async (r) => {
        attempts.push({ runName: r.runName, submitKey: r.submitKey });
        return 'j1';
    };
    await coordinatorFor(store, record);
    store.settle('a', 'failed', { detail: 'stage_failed' });

    store.place('a', 'quoting');
    await coordinatorFor(store, record);

    assert.notEqual(attempts[0].submitKey, attempts[1].submitKey);
    assert.notEqual(attempts[0].runName, attempts[1].runName,
        'the finished job still owns its run directory');
});

test('two runs on one dataset never claim the same name', async () => {
    const store = new RunStore();
    store.upsert(run('a'));
    store.upsert(run('b'));
    const names: string[] = [];
    await coordinatorFor(store, async (r) => {
        names.push(r.runName);
        return `j-${r.id}`;
    });

    assert.equal(new Set(names).size, 2);
    assert.ok(names.every(name => name.startsWith('standard-')), names.join(' '));
});

test('a run still uploading or paused is never submitted', async () => {
    const store = new RunStore();
    store.upsert(run('b', { state: 'uploading' }));
    store.upsert(run('c', { state: 'paused', datasetId: 'ds2' }));
    let submits = 0;
    await coordinatorFor(store, async () => {
        submits++;
        return 'j1';
    });

    assert.equal(submits, 0);
    assert.deepEqual(store.list().map(r => r.state), ['uploading', 'paused']);
});

test('a failed submit records the reason and leaves the others alone', async () => {
    const store = new RunStore();
    store.upsert(run('a'));
    store.upsert(run('b'));
    await coordinatorFor(store, async (r) => {
        if (r.id === 'a') throw new Error('gateway exploded');
        return 'j2';
    });

    const [a, b] = store.list();
    assert.equal(a.state, 'failed');
    assert.match(a.detail, /gateway exploded/);
    assert.equal(b.state, 'running');
    assert.equal(b.jobId, 'j2');
});

test('a refusal with nothing running locally is not a permanent verdict', async () => {
    // Everything holding the quota is on another tab, so this page's list stays empty --
    // the old code latched the cap at 1 here and the run never asked again.
    const store = new RunStore();
    store.upsert(run('a'));
    await coordinatorFor(store, refuse());

    assert.equal(coordinator.slotCap(), null, 'nothing was published, so nothing is known');
    assert.equal(store.list()[0].state, 'waiting-slot');

    const submitted: string[] = [];
    await resubmit(async (r) => {
        submitted.push(r.id);
        return 'j1';
    });

    assert.deepEqual(submitted, ['a'], 'a freed slot must still be usable');
    assert.equal(store.list()[0].state, 'running');
});

test('overlapping submitReady passes never submit one run twice', async () => {
    const store = new RunStore();
    store.upsert(run('a'));
    const submitted: string[] = [];
    let release: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const slow = async (r) => {
        submitted.push(r.id);
        await gate;
        return 'j1';
    };

    coordinate(store, slow);
    const first = coordinator.submitReady();
    const second = coordinator.submitReady();
    release();
    await Promise.all([first, second]);

    assert.deepEqual(submitted, ['a']);
});

test('a run waiting on a slot retries even when nothing is running locally', async () => {
    // The slot belongs to another tab or another device: no local run will ever finish to
    // prompt a retry, so the coordinator has to keep asking on its own.
    const store = new RunStore();
    store.upsert(run('a', { state: 'waiting-slot', submitKey: 'k1' }));
    let attempts = 0;
    coordinate(store, async () => {
        attempts += 1;
        if (attempts < 2) throw quotaError();   // the first ask is refused
        return 'j9';
    }, async () => jobRunning);
    coordinator.sync();

    assert.ok(clock.interval() > 0, 'a waiting run keeps a timer alive');
    await coordinator.pass();
    await coordinator.pass();

    assert.equal(store.list()[0].state, 'running');
    assert.equal(store.list()[0].jobId, 'j9');
});

test('the waiting retry backs off but never gives up', async () => {
    const store = new RunStore();
    store.upsert(run('a', { state: 'waiting-slot', submitKey: 'k1' }));
    coordinate(store, refuse(), async () => jobRunning);
    coordinator.sync();

    const first = clock.interval();
    await coordinator.pass();
    coordinator.sync();
    const second = clock.interval();

    assert.ok(second > first, 'a slot that is not coming back is asked for less often');
    assert.ok(clock.interval() > 0, 'but it is still asked for');
});

test('an external job releasing the quota lets the waiting run start', async () => {
    const store = new RunStore();
    store.upsert(run('a', { state: 'waiting-slot', submitKey: 'k1' }));
    let free = false;
    coordinate(store, async () => {
        if (!free) throw quotaError();
        return 'j9';
    }, async () => jobRunning);

    await coordinator.pass();
    assert.equal(store.list()[0].state, 'waiting-slot');

    free = true;                       // somebody else's job ended
    await coordinator.pass();
    assert.equal(store.list()[0].state, 'running');
});

test('every running run is polled, selected or not', async () => {
    const store = new RunStore();
    store.upsert(run('a', { state: 'running', jobId: 'j1' }));
    store.upsert(run('b', { state: 'running', jobId: 'j2' }));
    store.select('a');
    const asked: string[] = [];
    coordinate(store, async () => 'x', async (id) => {
        asked.push(id);
        return jobRunning;
    });

    await coordinator.pass();

    assert.deepEqual(asked.sort(), ['j1', 'j2'],
        'the run on screen is watched too -- a dead stream must not hide it');
});

test('an unselected run that finishes is settled', async () => {
    const store = new RunStore();
    store.upsert(run('a', { state: 'running', jobId: 'j1' }));
    store.upsert(run('b', { state: 'running', jobId: 'j2' }));
    store.select('a');
    coordinate(store, async () => 'x', async id => (id === 'j2' ? jobDone : jobRunning));

    await coordinator.pass();

    assert.equal(store.list().find(r => r.id === 'b').state, 'done');
    assert.equal(store.list().find(r => r.id === 'a').state, 'running');
});

test('a poll and a stream reaching the same terminal settle it once', async () => {
    const store = new RunStore();
    store.upsert(run('a', { state: 'running', jobId: 'j1' }));
    const settled: string[] = [];
    coordinate(store, async () => 'next', async () => jobDone);
    coordinator = new RunCoordinator(store, {
        submit: async () => 'next',
        fetchJob: async () => jobDone,
        onSettled: (r, state) => settled.push(`${r.id}:${state}`),
        timers: clock.timers
    });

    await coordinator.pass();                                   // the poll notices
    coordinator.settle('a', 'done', { percent: 100 });          // the stream notices too

    assert.deepEqual(settled, ['a:done'], 'one settlement, one successor submitted');
});

test('a run whose status call fails is not declared failed', async () => {
    const store = new RunStore();
    store.upsert(run('a', { state: 'running', jobId: 'j1' }));
    coordinate(store, async () => 'x', async () => {
        throw new Error('offline');
    });

    await coordinator.pass();

    assert.equal(store.list()[0].state, 'running', 'a dropped connection is not an outcome');
});

test('a dismissed run is not resubmitted', async () => {
    const store = new RunStore();
    store.upsert(run('a', { state: 'waiting-slot', submitKey: 'k1' }));
    let submits = 0;
    coordinate(store, async () => {
        submits += 1;
        return 'j1';
    }, async () => jobRunning);

    store.remove('a');
    await coordinator.pass();

    assert.equal(submits, 0);
});

test('a cancelled run is not resubmitted', async () => {
    const store = new RunStore();
    store.upsert(run('a', { state: 'running', jobId: 'j1' }));
    let submits = 0;
    coordinate(store, async () => {
        submits += 1;
        return 'j2';
    }, async () => ({ terminal: true,
        status: 'cancelled',
        failure: { code: 'cancelled_by_user' } }));

    await coordinator.pass();

    assert.equal(store.list()[0].state, 'cancelled');
    assert.equal(submits, 0);
});

test('stopping the coordinator ends every timer', () => {
    const store = new RunStore();
    store.upsert(run('a', { state: 'running', jobId: 'j1' }));
    coordinate(store, async () => 'x');
    coordinator.sync();
    assert.ok(clock.pending.size > 0);

    coordinator.stop();

    assert.equal(clock.pending.size, 0);
    coordinator.sync();
    assert.equal(clock.pending.size, 0, 'a stopped coordinator stays stopped');
});

test('the allowed transitions are the ones the table names', () => {
    assert.equal(canTransition('quoting', 'running'), true);
    assert.equal(canTransition('waiting-slot', 'running'), true);
    assert.equal(canTransition('running', 'done'), true);
    assert.equal(canTransition('failed', 'uploading'), true, 'a retry re-enters');

    assert.equal(canTransition('done', 'running'), false);
    assert.equal(canTransition('cancelled', 'running'), false);
    assert.equal(canTransition('running', 'waiting-slot'), false);
    assert.equal(canTransition('done', 'failed'), false);
});

test('an invalid transition is refused rather than written', () => {
    const store = new RunStore();
    store.upsert(run('a', { state: 'done', jobId: 'j1' }));
    coordinate(store, async () => 'x');

    assert.equal(coordinator.transition('a', 'running'), false);
    assert.equal(store.list()[0].state, 'done');
});

test('settling something that already settled changes nothing', () => {
    const store = new RunStore();
    store.upsert(run('a', { state: 'running', jobId: 'j1' }));
    coordinate(store, async () => 'x');

    assert.equal(coordinator.settle('a', 'done', { percent: 100 }), true);
    assert.equal(coordinator.settle('a', 'failed', { detail: 'late' }), false);
    assert.equal(store.list()[0].state, 'done');
});

test('each run is submitted under the pipeline it was created with', async () => {
    const store = new RunStore();
    store.upsert(run('a', { pipeline: 'splat' }));
    store.upsert(run('b', { pipeline: 'photogrammetry', datasetId: 'ds2' }));
    const sent: string[] = [];
    await coordinatorFor(store, async (r) => {
        sent.push(`${r.id}:${r.pipeline}`);
        return `job-${r.id}`;
    });

    assert.deepEqual(sent, ['a:splat', 'b:photogrammetry']);
});

test('the run is quoted and submitted under its own pipeline, never the picker\'s', () => {
    // Invariant, guarded at the source: reading the global here priced a run as one
    // pipeline and submitted it as whichever the toggle happened to be on by then.
    const source = readFileSync(
        new URL('./reconstruction-workflow.ts', import.meta.url), 'utf8');
    assert.match(source, /quoteDataset\(datasetId, run\.pipeline/);
    assert.match(source, /run\.pipeline as ReconstructionPipeline/);

    const startRun = source.slice(source.indexOf('private async startRun'),
        source.indexOf('private async watchRun'));
    assert.equal(startRun.includes('this.pipeline'), false,
        'nothing in a run\'s own path may consult the picker');
});
