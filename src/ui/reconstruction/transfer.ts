import { isRetryable, type UploadOptions, type Uploadable } from 'genesis-recon';

import { classOf } from './failure';

type TransferDeps = {
    uploadDataset(files: Uploadable[], opts: UploadOptions): Promise<string>;
    sleep(ms: number): Promise<void>;
};

/** The two fields of the resume record a transfer actually needs. */
type TransferTarget = { datasetId: string; label: string };

type TransferOutcome =
    | { state: 'done' }
    | { state: 'paused' }
    | { state: 'failed'; error: unknown };

const RETRY_DELAYS_MS = [5_000, 15_000, 30_000];

class Transfer {
    private readonly files: Uploadable[];
    private readonly target: TransferTarget;
    private readonly deps: TransferDeps;
    private controller: AbortController | null = null;
    private paused = false;

    constructor(files: Uploadable[], target: TransferTarget, deps: TransferDeps) {
        this.files = files;
        this.target = target;
        this.deps = deps;
    }

    /** Stop the bytes and keep everything the store already accepted. */
    pause() {
        this.paused = true;
        this.controller?.abort();
    }

    async run(onProgress?: UploadOptions['onProgress']): Promise<TransferOutcome> {
        for (let attempt = 0; ; attempt++) {
            if (this.paused) return { state: 'paused' };
            this.controller = new AbortController();
            try {
                await this.deps.uploadDataset(this.files, {
                    label: this.target.label,
                    datasetId: this.target.datasetId,
                    signal: this.controller.signal,
                    onProgress
                });
                return { state: 'done' };
            } catch (error) {
                const failureClass = classOf(error);
                if (this.paused || failureClass === 'cancelled') return { state: 'paused' };
                const delay = RETRY_DELAYS_MS[attempt];
                if (delay === undefined || !isRetryable(failureClass)) {
                    return { state: 'failed', error };
                }
                await this.deps.sleep(delay);
            }
        }
    }
}

export { Transfer };
export type { TransferDeps, TransferOutcome, TransferTarget };
