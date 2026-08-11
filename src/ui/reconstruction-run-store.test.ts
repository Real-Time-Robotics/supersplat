import assert from 'node:assert/strict';
import { test } from 'node:test';

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

/** A store with one job running and one run parked behind the 409 that taught it the cap. */
const cappedStore = async () => {
    const store = new RunStore();
    store.upsert(run('a', { state: 'running', jobId: 'j1' }));
    store.upsert(run('b'));
    await store.submitReady(refuse());
    return store;
};

test('a 409 parks the run and teaches the store the cap', async () => {
    const store = new RunStore();
    store.upsert(run('a', { state: 'running', jobId: 'j1' }));
    store.upsert(run('b'));
    let submits = 0;
    await store.submitReady(async () => {
        submits++;
        throw quotaError();
    });

    assert.equal(submits, 1);
    assert.equal(store.list().find(r => r.id === 'b').state, 'waiting-slot');
    assert.equal(store.slotCap(), 1);
});

test('a parked run is submitted once a slot frees', async () => {
    const store = await cappedStore();
    store.update('a', { state: 'done' });
    const submitted: string[] = [];
    await store.submitReady(async (r) => {
        submitted.push(r.id);
        return 'j2';
    });

    assert.deepEqual(submitted, ['b']);
    assert.equal(store.list().find(r => r.id === 'b').state, 'running');
    assert.equal(store.list().find(r => r.id === 'b').jobId, 'j2');
});

test('the store never exceeds a cap it already learned', async () => {
    const store = await cappedStore();
    store.upsert(run('c'));
    let submits = 0;
    await store.submitReady(async () => {
        submits++;
        return 'j3';
    });

    assert.equal(submits, 0, 'one job is active and the learned cap is 1');
});

test('a repeat run of one pipeline gets a fresh run name', async () => {
    const store = new RunStore();
    store.upsert(run('b', { preset: 'standard', runName: 'standard' }));
    const names: string[] = [];
    await store.submitReady(async (r) => {
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
    await store.submitReady(async (r) => {
        attempts.push({ runName: r.runName, submitKey: r.submitKey });
        throw new Error('502 Bad Gateway');
    });
    assert.equal(store.list()[0].state, 'failed');

    store.update('a', { state: 'quoting' });
    await store.submitReady(async (r) => {
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
    await store.submitReady(record);
    store.settle('a', { state: 'failed', detail: 'stage_failed' });

    store.update('a', { state: 'quoting' });
    await store.submitReady(record);

    assert.notEqual(attempts[0].submitKey, attempts[1].submitKey);
    assert.notEqual(attempts[0].runName, attempts[1].runName,
        'the finished job still owns its run directory');
});

test('two runs on one dataset never claim the same name', async () => {
    const store = new RunStore();
    store.upsert(run('a'));
    store.upsert(run('b'));
    const names: string[] = [];
    await store.submitReady(async (r) => {
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
    await store.submitReady(async () => {
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
    await store.submitReady(async (r) => {
        if (r.id === 'a') throw new Error('gateway exploded');
        return 'j2';
    });

    const [a, b] = store.list();
    assert.equal(a.state, 'failed');
    assert.match(a.detail, /gateway exploded/);
    assert.equal(b.state, 'running');
    assert.equal(b.jobId, 'j2');
});

test('a refusal with nothing running locally never latches the cap at zero', async () => {
    const store = new RunStore();
    store.upsert(run('a'));
    await store.submitReady(refuse());
    assert.equal(store.slotCap(), 1);

    store.upsert(run('b'));
    const submitted: string[] = [];
    await store.submitReady(async (r) => {
        submitted.push(r.id);
        return 'j1';
    });

    assert.deepEqual(submitted, ['a'], 'a freed slot must still be usable');
});

test('one upload session never shows up as two runs', () => {
    const store = new RunStore();
    store.upsert(run('a', { state: 'uploading' }));
    store.upsert(run('b', { state: 'paused', detail: 'Chọn lại thư mục để tiếp tục' }));

    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].id, 'a', 'the row already on screen keeps its identity');
    assert.equal(store.list()[0].detail, 'Chọn lại thư mục để tiếp tục');
});

test('an update that changes nothing does not notify', () => {
    const store = new RunStore();
    store.upsert(run('a', { state: 'running', jobId: 'j1', detail: 'queued' }));
    let notifications = 0;
    store.onChange(() => notifications++);

    store.update('a', { detail: 'queued' });
    assert.equal(notifications, 0, 'a poll tick that learned nothing must not rebuild the list');
    store.update('a', { detail: 'running' });
    assert.equal(notifications, 1);
});

test('a second run on the same dataset is its own row, and can be removed', () => {
    const store = new RunStore();
    store.upsert(run('a', { state: 'running', jobId: 'j1' }));
    store.upsert(run('b', { state: 'running', jobId: 'j2' }));
    assert.equal(store.list().length, 2);

    store.remove('a');
    assert.deepEqual(store.list().map(r => r.id), ['b']);
    assert.equal(store.selected()?.id, 'b', 'removing the selected run selects another');
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

    const first = store.submitReady(slow);
    const second = store.submitReady(slow);
    release();
    await Promise.all([first, second]);

    assert.deepEqual(submitted, ['a']);
});
