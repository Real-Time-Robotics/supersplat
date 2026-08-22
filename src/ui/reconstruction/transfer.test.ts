import assert from 'node:assert/strict';
import { test } from 'node:test';

import { UploadError } from 'genesis-recon';

import { Transfer } from './transfer.ts';

const target = { datasetId: 'ds1', label: 'set' };
const retryDelays = [5_000, 15_000, 30_000];

const deps = (uploadDataset) => {
    const waits: number[] = [];
    return {
        waits,
        deps: {
            uploadDataset,
            sleep: async (ms: number) => {
                waits.push(ms);
            }
        }
    };
};

test('a retryable failure is re-entered with the stored datasetId', async () => {
    const seen: (string | undefined)[] = [];
    let attempt = 0;
    const { deps: d, waits } = deps(async (_files, opts) => {
        seen.push(opts.datasetId);
        if (attempt++ < 2) throw new UploadError('reset', undefined, 'network-interrupted');
        return 'ds1';
    });
    const outcome = await new Transfer([], target, d, retryDelays).run();

    assert.deepEqual(outcome, { state: 'done' });
    assert.equal(seen.length, 3);
    assert.deepEqual(seen, ['ds1', 'ds1', 'ds1']);
    assert.deepEqual(waits, [5000, 15000]);
});

test('a pause is not retried and reports paused', async () => {
    let calls = 0;
    const { deps: d, waits } = deps(async () => {
        calls++;
        throw new UploadError('stopped', undefined, 'cancelled');
    });
    const outcome = await new Transfer([], target, d, retryDelays).run();

    assert.deepEqual(outcome, { state: 'paused' });
    assert.equal(calls, 1);
    assert.deepEqual(waits, []);
});

test('a permanent failure is not retried', async () => {
    let calls = 0;
    const { deps: d } = deps(async () => {
        calls++;
        throw new UploadError('malformed', 400, 'permanent');
    });
    const outcome = await new Transfer([], target, d, retryDelays).run();

    assert.equal(outcome.state, 'failed');
    assert.equal(calls, 1);
});

test('retries are bounded and the last failure is surfaced', async () => {
    let calls = 0;
    const { deps: d, waits } = deps(async () => {
        calls++;
        throw new UploadError('reset', undefined, 'network-interrupted');
    });
    const outcome = await new Transfer([], target, d, retryDelays).run();

    assert.equal(outcome.state, 'failed');
    assert.equal(calls, 4);
    assert.deepEqual(waits, [5000, 15000, 30000]);
});

test('pause() aborts the in-flight transfer through the signal it passed in', async () => {
    let observed: AbortSignal | undefined;
    const { deps: d } = deps((_files, opts) => new Promise((_resolve, reject) => {
        observed = opts.signal;
        opts.signal.addEventListener('abort', () => {
            reject(new UploadError('stopped', undefined, 'cancelled'));
        });
    }));
    const transfer = new Transfer([], target, d, retryDelays);
    const running = transfer.run();
    await Promise.resolve();
    transfer.pause();
    assert.deepEqual(await running, { state: 'paused' });
    assert.equal(observed?.aborted, true);
});
