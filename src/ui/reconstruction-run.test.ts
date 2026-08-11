import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runControls, type Run, type RunState } from './reconstruction-run.ts';

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
