import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RunFeeds, type FeedSource } from './run-feed.ts';
import type { Run } from './run.ts';
import type { JobStatus } from './types.ts';

type Listener = (event: Event) => void;

class StubSource implements FeedSource {
    readonly listeners: Map<string, Listener> = new Map();
    closed = false;
    readyState = 1;             // OPEN

    addEventListener(type: string, listener: Listener) {
        this.listeners.set(type, listener);
    }

    close() {
        this.closed = true;
    }

    emit(type: string, data: unknown) {
        this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(data) }));
    }

    /** What EventSource does on a fatal error: stop retrying, then fire `error`. */
    die() {
        this.readyState = 2;    // CLOSED
        this.listeners.get('error')?.(new Event('error'));
    }

    /** A blip EventSource will retry by itself. */
    blip() {
        this.listeners.get('error')?.(new Event('error'));
    }
}

const run = (id: string, patch: Partial<Run> = {}): Run => ({
    id,
    state: 'running',
    datasetId: 'ds1',
    pipeline: 'splat',
    preset: 'standard',
    runName: 'standard-abc',
    submitKey: 'k',
    datasetLabel: id,
    label: '',
    jobId: `job-${id}`,
    percent: 0,
    detail: '',
    ...patch
});

const harness = (job: Partial<JobStatus> = {}) => {
    const opened = new Map<string, StubSource>();
    const details: [string, string][] = [];
    const ended: [string, boolean][] = [];
    const feeds = new RunFeeds({
        open: (jobId) => {
            const source = new StubSource();
            opened.set(jobId, source);
            return source;
        },
        seed: async () => ({ terminal: false, status: 'running', ...job }),
        onDetail: (runId, detail) => details.push([runId, detail]),
        onEnded: (runId, _jobId, settled) => ended.push([runId, settled])
    });
    return { feeds, opened, details, ended };
};

/** Let the seed read settle; nothing here is timer-driven, so one turn is enough. */
const settled = () => new Promise((resolve) => {
    setImmediate(resolve);
});

test('every running run gets its own stream except the one the card is streaming', () => {
    const { feeds, opened } = harness();

    feeds.sync([run('a'), run('b'), run('c', { state: 'done' })], 'job-a');

    assert.deepEqual([...opened.keys()], ['job-b'],
        'a is on the card and c is finished; only b needs a feed of its own');
});

test('a stage event reaches the row with nothing polling for it', () => {
    const { feeds, opened, details } = harness();
    feeds.sync([run('a')], null);

    opened.get('job-a').emit('stage', {
        phase: 'start', step: 'feature_extraction', index: 5, total: 17, returncode: null
    });

    assert.deepEqual(details.at(-1), ['a', '5/17 Finding image features']);
});

test('a queued run reads its box state off the stream, not off a status call', () => {
    const { feeds, opened, details } = harness();
    feeds.sync([run('a')], null);

    opened.get('job-a').emit('gpu',
        { state: 'loading', provider: 'vast', since: '2026-08-14T00:00:00Z' });

    assert.deepEqual(details.at(-1), ['a', 'Đang khởi tạo GPU']);
});

test('the box coming up replaces the state before it, it does not stack', () => {
    const { feeds, opened, details } = harness();
    feeds.sync([run('a')], null);
    const source = opened.get('job-a');

    source.emit('gpu', { state: 'loading', provider: 'vast', since: 'x' });
    source.emit('gpu', { state: 'running', provider: 'vast', since: 'y' });

    assert.deepEqual(details.at(-1), ['a', 'GPU đã sẵn sàng']);
});

test('an end frame closes the stream and hands the outcome back to the caller', () => {
    const { feeds, opened, ended } = harness();
    feeds.sync([run('a')], null);

    opened.get('job-a').emit('end', {});

    assert.deepEqual(ended, [['a', true]]);
    assert.equal(opened.get('job-a').closed, true, 'a finished stream must not be reconnected');
});

test('a run that leaves the running state loses its feed', () => {
    const { feeds, opened } = harness();
    feeds.sync([run('a')], null);

    feeds.sync([run('a', { state: 'done' })], null);

    assert.equal(opened.get('job-a').closed, true);
});

test('a retry under a new job is a new stream, not the old one', () => {
    const { feeds, opened } = harness();
    feeds.sync([run('a')], null);

    feeds.sync([run('a', { jobId: 'job-a2' })], null);

    assert.equal(opened.get('job-a').closed, true);
    assert.equal(opened.get('job-a2').closed, false);
});

test('a run joined mid-flight starts from a status read, since the stream has no snapshot',
    async () => {
        const { feeds, details } = harness({
            gpu: { state: 'creating', provider: 'vast', since: '2026-08-14T00:00:00Z' }
        });
        feeds.sync([run('a')], null);

        await settled();

        assert.deepEqual(details.at(-1), ['a', 'Đang thuê GPU']);
    });

test('a frame that already arrived outranks the status read it raced', async () => {
    const { feeds, opened, details } = harness({
        gpu: { state: 'creating', provider: 'vast', since: '2026-08-14T00:00:00Z' }
    });
    feeds.sync([run('a')], null);
    opened.get('job-a').emit('gpu', { state: 'running', provider: 'vast', since: 'y' });

    await settled();

    assert.equal(details.at(-1)[1], 'GPU đã sẵn sàng',
        'the read was in flight before the frame; it must not walk the state backwards');
});

test('a job already finished when the feed opened is reported, not watched', async () => {
    const { feeds, opened, ended } = harness({ terminal: true, status: 'done' });
    feeds.sync([run('a')], null);

    await settled();

    assert.deepEqual(ended, [['a', true]]);
    assert.equal(opened.get('job-a').closed, true);
});

test('an end the gateway sends because it lost the worker is not a finished job', () => {
    const { feeds, opened, ended } = harness();
    feeds.sync([run('a')], null);

    opened.get('job-a').emit('end', { terminal: false, reason: 'worker_lost' });

    assert.deepEqual(ended, [['a', false]],
        'the row still says running; only the stream gave up, and re-reading it will not help');
});

test('a socket that gives up for good is reported, not left streaming into nothing', () => {
    const { feeds, opened, ended } = harness();
    feeds.sync([run('a')], null);

    opened.get('job-a').blip();
    assert.deepEqual(ended, [], 'EventSource retries this one itself');

    opened.get('job-a').die();
    assert.deepEqual(ended, [['a', false]]);
});

test('stopping closes every stream', () => {
    const { feeds, opened } = harness();
    feeds.sync([run('a'), run('b')], null);

    feeds.stop();

    assert.ok([...opened.values()].every(source => source.closed));
});
