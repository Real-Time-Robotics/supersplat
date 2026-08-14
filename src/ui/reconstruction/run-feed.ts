import { jobDetail, type Run } from './run';
import type { JobGpu, JobProgressEvent, JobStatus, StageEvent } from './types';
import { eventData } from './utils';

/** The part of EventSource a feed uses; narrowed so a test can hand one in. */
type FeedSource = {
    addEventListener(type: string, listener: (event: Event) => void): void;
    close(): void;
    readonly readyState: number;
};

const CLOSED = 2;   // EventSource.CLOSED: it has stopped retrying on its own

type FeedDeps = {
    /** Opens the job's SSE stream. The browser's EventSource in production. */
    open(jobId: string): FeedSource;
    /** One read at open, for the state the frames so far don't cover. */
    seed(jobId: string): Promise<JobStatus>;
    onDetail(runId: string, detail: string): void;
    /**
     * The stream is over. `settled` is false when only the stream ended -- the gateway gave
     * up on it, or the socket died -- and the job may well still be running.
     */
    onEnded(runId: string, jobId: string, settled: boolean): void;
};

class RunFeed {
    #status = 'running';
    #gpu: JobGpu | null = null;
    #stage: StageEvent | null = null;
    #progress: JobProgressEvent | null = null;
    #closed = false;
    readonly #source: FeedSource;

    constructor(
        private readonly runId: string,
        readonly jobId: string,
        private readonly deps: FeedDeps
    ) {
        this.#source = deps.open(jobId);
        this.#source.addEventListener('stage', (event) => {
            const stage = eventData<StageEvent>(event);
            if (stage) {
                this.#stage = stage;
                this.#emit();
            }
        });
        this.#source.addEventListener('progress', (event) => {
            const progress = eventData<JobProgressEvent>(event);
            if (progress) {
                this.#progress = progress;
                this.#emit();
            }
        });
        this.#source.addEventListener('gpu', (event) => {
            const gpu = eventData<JobGpu>(event);
            if (gpu) {
                this.#gpu = gpu;
                this.#emit();
            }
        });
        this.#source.addEventListener('end', (event) => {
            // A pre-`terminal` gateway sends `{}`; treat that as over, the way it always was.
            const said = eventData<{ terminal?: boolean }>(event);
            this.#finish(said?.terminal !== false);
        });
        this.#source.addEventListener('error', () => {
            // EventSource reconnects by itself unless it has given up for good.
            if (this.#source.readyState === CLOSED) this.#finish(false);
        });

        deps.seed(jobId).then((job) => {
            if (this.#closed) return;
            this.#status = job.status;
            // Only fill gaps: a frame that already arrived is newer than this read.
            this.#gpu = this.#gpu ?? job.gpu ?? null;
            this.#stage = this.#stage ?? job.current_stage ?? null;
            this.#progress = this.#progress ?? job.progress ?? null;
            if (job.terminal) {
                this.#finish(true);
                return;
            }
            this.#emit();
        }).catch((): void => undefined);   // the stream, not this read, is the source of truth
    }

    close() {
        if (this.#closed) return;
        this.#closed = true;
        this.#source.close();
    }

    #finish(settled: boolean) {
        if (this.#closed) return;
        this.close();
        this.deps.onEnded(this.runId, this.jobId, settled);
    }

    #emit() {
        if (this.#closed) return;
        this.deps.onDetail(this.runId, jobDetail({
            status: this.#status,
            gpu: this.#gpu,
            current_stage: this.#stage,
            progress: this.#progress
        }));
    }
}

/**
 * A feed per running run, minus the one the shared card is already streaming. Call
 * {@link sync} whenever the run list changes; it opens what is missing and closes the rest.
 */
class RunFeeds {
    readonly #feeds = new Map<string, RunFeed>();

    constructor(private readonly deps: FeedDeps) {}

    sync(runs: Run[], watchedJobId: string | null) {
        const wanted = new Map(runs
        .filter(run => run.state === 'running' && run.jobId !== null &&
            run.jobId !== watchedJobId)
        .map(run => [run.id, run.jobId as string]));

        for (const [runId, feed] of this.#feeds) {
            // A retried run keeps its id and gets a new job; that is a different stream.
            if (wanted.get(runId) === feed.jobId) continue;
            feed.close();
            this.#feeds.delete(runId);
        }
        for (const [runId, jobId] of wanted) {
            if (!this.#feeds.has(runId)) {
                this.#feeds.set(runId, new RunFeed(runId, jobId, this.deps));
            }
        }
    }

    /** Forget one run's feed so the next {@link sync} opens a fresh stream for it. */
    drop(runId: string) {
        this.#feeds.get(runId)?.close();
        this.#feeds.delete(runId);
    }

    stop() {
        for (const feed of this.#feeds.values()) feed.close();
        this.#feeds.clear();
    }
}

export { RunFeed, RunFeeds };
export type { FeedDeps, FeedSource };
