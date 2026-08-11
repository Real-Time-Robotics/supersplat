import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runCard, runControls, type Run, type RunState } from './reconstruction-run.ts';

const STATES: RunState[] = [
    'uploading', 'paused', 'quoting', 'waiting-slot', 'running', 'done', 'cancelled', 'failed'
];

const run = (state: RunState): Run => ({
    id: 'r1',
    state,
    datasetId: 'ds1',
    pipeline: 'splat',
    preset: 'standard',
    runName: 'standard',
    submitKey: null,
    label: 'r1',
    jobId: null,
    percent: 0,
    detail: ''
});

test('every state but running offers a way out', () => {
    for (const state of STATES) {
        const controls = runControls(run(state), true);
        assert.equal(controls.length > 0, state !== 'running',
            `${state} offered ${JSON.stringify(controls)}`);
    }
});

test('a cancelled run can be retried or dismissed, never reopened', () => {
    // It has no artifacts: `open` would send the user to an empty Recent tab.
    assert.deepEqual(runControls(run('cancelled'), true), ['retry', 'dismiss']);
});

test('a paused run with no folder in hand asks for one instead of offering resume', () => {
    assert.deepEqual(runControls(run('paused'), false), ['repick', 'cancel']);
    assert.deepEqual(runControls(run('paused'), true), ['resume', 'cancel']);
});

test('every state paints the shared card, so selecting one never leaves another up', () => {
    for (const state of STATES) {
        const [title, detail, visual] = runCard(run(state));
        assert.ok(title, `${state} had no title`);
        assert.ok(detail, `${state} had no detail`);
        assert.ok(visual.mode, `${state} had no visual`);
    }
});

test('a finished run reads as finished rather than as in-flight work', () => {
    const [title, , visual] = runCard({ ...run('done'), percent: 100 });
    assert.equal(visual.mode, 'done');
    assert.equal(visual.center, '100%');
    assert.equal(title, 'Hoàn tất');
    for (const state of ['cancelled', 'failed'] as RunState[]) {
        assert.equal(runCard(run(state))[2].mode, 'failed');
    }
});

test('an upload in flight shows how far it got, not a spinner', () => {
    const [, detail, visual] = runCard({ ...run('uploading'), percent: 42 });
    assert.deepEqual(visual, { mode: 'determinate', value: 42 });
    assert.match(detail, /42%/);
});
