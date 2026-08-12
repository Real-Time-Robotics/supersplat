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

test('one upload session never shows up as two runs', () => {
    const store = new RunStore();
    store.upsert(run('a', { state: 'uploading' }));
    store.upsert(run('b', { state: 'paused', detail: 'Chọn lại thư mục để tiếp tục' }));

    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].id, 'a', 'the row already on screen keeps its identity');
    assert.equal(store.list()[0].detail, 'Chọn lại thư mục để tiếp tục');
});

test('upsert merges into an existing row without moving its state', () => {
    const store = new RunStore();
    store.upsert(run('a', { state: 'uploading' }));

    store.upsert(run('b', { state: 'paused', label: 'renamed' }));

    assert.equal(store.list()[0].state, 'uploading',
        'a state jump has to go through RunCoordinator.transition()');
    assert.equal(store.list()[0].label, 'renamed', 'everything else still merges');
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
    store.select('a');
    assert.equal(store.list().length, 2);

    store.remove('a');
    assert.deepEqual(store.list().map(r => r.id), ['b']);
    assert.equal(store.selected()?.id, 'b', 'removing the selected run selects another');
});

test('composing a new run outlives another run reporting progress', () => {
    const store = new RunStore();
    store.upsert(run('a', { state: 'uploading' }));
    store.select(null);            // the user pressed "Luồng mới"

    store.update('a', { percent: 12 });

    assert.equal(store.selected(), null,
        'an upload tick must not pull the panel back to the run doing the uploading');
});

test('a row folded away hands its selection to the row that absorbed it', () => {
    const store = new RunStore();
    store.upsert(run('a', { state: 'uploading', datasetId: 'ds1' }));
    store.upsert(run('b', { state: 'quoting', datasetId: 'ds2' }));
    store.select('a');

    store.place('b', 'uploading', { datasetId: 'ds1' });

    assert.deepEqual(store.list().map(r => r.id), ['b']);
    assert.equal(store.selected()?.id, 'b');
});

test('the store refuses to write a run state on anybody else\'s behalf', () => {
    const store = new RunStore();
    store.upsert(run('a', { state: 'running', jobId: 'j1' }));

    assert.throws(() => store.update('a', { state: 'done' } as any), /RunCoordinator/);
    assert.equal(store.list()[0].state, 'running');
});
