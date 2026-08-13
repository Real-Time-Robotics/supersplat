import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TransferRate } from './upload-rate.ts';
import type { UploadRecord } from './upload-records.ts';
import type { Named, UploadDeps } from './upload.ts';

(globalThis as { location?: unknown }).location = { origin: 'http://localhost' };
const { ReconstructionUpload, UploadPaused } = await import('./upload.ts');

// resume() reaches drive() without touching UploadRecords, which is IndexedDB-backed and
// absent here; only the done path persists, and these tests end in paused or failed.
const recordFor = (datasetId: string): UploadRecord => ({
    datasetId,
    label: `label-${datasetId}`,
    pipeline: 'splat',
    preset: 'standard',
    fingerprint: `fp-${datasetId}`,
    names: ['a.jpg'],
    totalBytes: 1000
});

const namedFiles = (): Named[] => [{ name: 'a.jpg', data: {} as File }];

/**
 * An upload that reports one tick of progress and then hangs until its own signal aborts,
 * so a test can hold several transfers open at once and release them one at a time.
 */
const hangingDeps = (): UploadDeps & { tick: (id: string, loaded: number) => void } => {
    type Reporter = (loaded: number) => void;
    const reporters = new Map<string, Reporter>();
    return {
        createDatasetSession: () => Promise.resolve('unused'),
        uploadDataset: (_files, opts) => {
            const id = opts.datasetId as string;
            reporters.set(id, (loaded) => {
                opts.onProgress?.({ phase: 'upload', loaded, total: 1000, datasetId: id });
            });
            return new Promise<string>((_resolve, reject) => {
                opts.signal?.addEventListener('abort',
                    () => reject(new Error(`aborted ${id}`)));
            });
        },
        tick: (id, loaded) => reporters.get(id)?.(loaded)
    };
};

const after = (ms: number) => new Promise((resolve) => {
    setTimeout(resolve, ms);
});

/** Let the microtask queue drain so an awaited transfer has reached its hang. */
const settle = () => after(0);

describe('ReconstructionUpload keyed transfers', () => {
    it('streams several runs at once and counts each one', async () => {
        const deps = hangingDeps();
        const upload = new ReconstructionUpload(deps);

        const a = upload.resume('run-a', recordFor('ds-a'), namedFiles()).catch(e => e);
        const b = upload.resume('run-b', recordFor('ds-b'), namedFiles()).catch(e => e);
        await settle();

        assert.equal(upload.active, 2);
        assert.ok(upload.isTransferring('run-a'));
        assert.ok(upload.isTransferring('run-b'));

        upload.pauseAll();
        await Promise.all([a, b]);
    });

    it('pauses only the run asked for', async () => {
        const deps = hangingDeps();
        const upload = new ReconstructionUpload(deps);

        const a = upload.resume('run-a', recordFor('ds-a'), namedFiles()).catch(e => e);
        const b = upload.resume('run-b', recordFor('ds-b'), namedFiles()).catch(e => e);
        await settle();

        upload.pause('run-a');
        const outcome = await a;

        assert.ok(outcome instanceof UploadPaused, 'run-a should report itself paused');
        assert.equal(outcome.datasetId, 'ds-a');
        assert.equal(upload.isTransferring('run-a'), false);
        assert.ok(upload.isTransferring('run-b'), 'run-b must keep streaming');
        assert.equal(upload.active, 1);

        upload.pauseAll();
        await b;
    });

    it('releases the slot once a run stops, so the queue cannot wedge', async () => {
        const deps = hangingDeps();
        const upload = new ReconstructionUpload(deps);

        const a = upload.resume('run-a', recordFor('ds-a'), namedFiles()).catch(e => e);
        const b = upload.resume('run-b', recordFor('ds-b'), namedFiles()).catch(e => e);
        await settle();

        upload.pauseAll();
        await Promise.all([a, b]);

        assert.equal(upload.active, 0);
    });

    it('meters each run from its own bytes, not from whatever ticked before it', async () => {
        const deps = hangingDeps();
        const upload = new ReconstructionUpload(deps);
        const seen = new Map<string, TransferRate[]>();
        const collect = (key: string) => ({
            onRate: (rate: TransferRate) => {
                if (!seen.has(key)) seen.set(key, []);
                seen.get(key).push(rate);
            }
        });

        const a = upload.resume('run-a', recordFor('ds-a'), namedFiles(), collect('run-a'))
        .catch(e => e);
        const b = upload.resume('run-b', recordFor('ds-b'), namedFiles(), collect('run-b'))
        .catch(e => e);
        await settle();

        deps.tick('ds-a', 100);
        deps.tick('ds-b', 5000);
        await after(500);
        deps.tick('ds-a', 600);
        deps.tick('ds-b', 5500);

        const rateA = seen.get('run-a').at(-1);
        const rateB = seen.get('run-b').at(-1);

        for (const [key, rate] of [['run-a', rateA], ['run-b', rateB]] as const) {
            assert.ok(rate.bytesPerSecond > 0, `${key} should have a rate at all`);
            assert.ok(rate.bytesPerSecond <= 1000,
                `${key} moved 500 B in >=500 ms, so <=1000 B/s, got ${rate.bytesPerSecond}`);
        }

        upload.pauseAll();
        await Promise.all([a, b]);
    });
});
