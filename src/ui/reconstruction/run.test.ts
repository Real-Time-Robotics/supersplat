import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runCard, runControls, runPollDetail, type Run, type RunState } from './run.ts';
import type { JobStatus } from './types.ts';

const STATES: RunState[] = [
    'queued', 'uploading', 'paused', 'quoting', 'waiting-slot', 'running', 'done', 'cancelled',
    'failed'
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

const job = (patch: Partial<JobStatus> = {}): JobStatus => ({
    terminal: false, status: 'running', ...patch
});

const stage = (step: string, index: number, total: number) => ({
    phase: 'start' as const, step, index, total, returncode: null
});

test('an unwatched run reads its stage, not the bare status word', () => {
    const detail = runPollDetail(job({ current_stage: stage('feature_extraction', 2, 7) }));
    assert.match(detail, /2\/7/);
    assert.match(detail, /Finding image features/);
    assert.doesNotMatch(detail, /feature_extraction/);
});

test('a rented box in the queue is named while the job has no stage yet', () => {
    const detail = runPollDetail(job({
        status: 'queued',
        gpu: { state: 'loading', provider: 'vast', since: '2026-08-13T00:00:00Z' }
    }));
    assert.match(detail, /GPU/);
    assert.notEqual(detail, 'queued');
});

test('stage progress rides along with the stage', () => {
    const detail = runPollDetail(job({
        current_stage: stage('training', 1, 3),
        progress: {
            stage: 'training',
            mode: 'determinate',
            current: 4000,
            total: 30000,
            unit: 'iterations',
            observed_at: '2026-08-13T00:00:00Z'
        }
    }));
    assert.match(detail, /4,000 \/ 30,000 iterations/);
});

test('a status with nothing to unpack still says something', () => {
    assert.equal(runPollDetail(job({ status: 'assigning' })), 'assigning');
});
