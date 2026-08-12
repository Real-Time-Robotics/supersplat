import { newRunName } from './reconstruction-names';
import type { Run, RunState } from './reconstruction-run';
import type { RunPatch, RunStore } from './reconstruction-run-store';
import type { JobStatus } from './reconstruction-types';

/** How often a running run re-checks its job. */
const RUN_POLL_MS = 15_000;
/** How often a run that only lacks a slot tries again. Backs off, then holds. */
const WAIT_MIN_MS = 5_000;
const WAIT_MAX_MS = 60_000;

/**
 * The transitions a run may make. Everything else is a bug in whoever asked, so it is
 * refused rather than written -- a run that goes `done -> running` because two settlers
 * raced is worse than one that stays put.
 */
const ALLOWED: Record<RunState, readonly RunState[]> = {
    'queued': ['uploading', 'quoting', 'cancelled', 'failed'],
    // -> queued: the single uploader is busy, so this run gives up its turn and waits.
    'uploading': ['queued', 'paused', 'quoting', 'cancelled', 'failed'],
    // -> quoting: resumed with its images already complete on R2, so there is nothing
    // left to transfer.
    'paused': ['uploading', 'queued', 'quoting', 'cancelled', 'failed'],
    'quoting': ['queued', 'waiting-slot', 'running', 'cancelled', 'failed'],
    'waiting-slot': ['quoting', 'running', 'cancelled', 'failed'],
    'running': ['done', 'cancelled', 'failed'],
    // A terminal run is re-entered by retrying it, never resumed in place.
    'done': ['queued', 'uploading', 'quoting'],
    'cancelled': ['queued', 'uploading', 'quoting'],
    'failed': ['queued', 'uploading', 'quoting']
};

const canTransition = (from: RunState, to: RunState): boolean => (
    from === to || ALLOWED[from].includes(to)
);

const isQuotaRefusal = (error: unknown): boolean => (
    (error as { status?: number })?.status === 409 &&
    (error as { code?: string })?.code === 'concurrent_job_quota_exceeded'
);

type Timers = {
    set: (fn: () => void, ms: number) => number;
    clear: (handle: number) => void;
};

type Deps = {
    submit: (run: Run) => Promise<string>;
    fetchJob: (jobId: string) => Promise<JobStatus>;
    onSettled?: (run: Run, state: RunState) => void;
    timers?: Timers;
};

/**
 * The single owner of a run's lifecycle. The workflow gathers input and paints, the job
 * transport moves bytes and events, the store holds the snapshot -- but transitions,
 * submission, the waiting-slot retry, polling and terminal settlement all happen here, so
 * two of them can never decide differently about the same run.
 */
class RunCoordinator {
    readonly #runs: RunStore;
    readonly #deps: Deps;
    readonly #timers: Timers;
    /** The account's published cap, or null when we have not been told one. */
    #cap: number | null = null;
    #quotaBlocked = false;
    #submitting = false;
    #tick: number | null = null;
    #waitDelay = WAIT_MIN_MS;
    #stopped = false;

    constructor(runs: RunStore, deps: Deps) {
        this.#runs = runs;
        this.#deps = deps;
        this.#timers = deps.timers ?? {
            set: (fn, ms) => window.setInterval(fn, ms) as unknown as number,
            clear: handle => window.clearInterval(handle)
        };
    }

    slotCap(): number | null {
        return this.#cap;
    }

    /** Whether the last submission was turned away by the account's concurrency quota. */
    quotaBlocked(): boolean {
        return this.#quotaBlocked;
    }

    /**
     * What the plan says, from billing. It is never narrowed by what happens at submit
     * time: the cap counts jobs on every tab and device, and only the server knows it.
     */
    setSlotCap(cap: number | null): void {
        this.#cap = cap !== null && Number.isFinite(cap) && cap >= 1 ? cap : null;
    }

    /**
     * A fresh sign-in: this account's cap replaces the last one's, nothing is presumed
     * about the quota, and the scheduler runs again after the old session stopped it.
     */
    beginSession(cap: number | null): void {
        this.setSlotCap(cap);
        this.#quotaBlocked = false;
        this.resume();
    }

    /** A guarded write. Returns whether the run moved. */
    transition(id: string, to: RunState, patch: RunPatch = {}): boolean {
        const run = this.#runs.list().find(other => other.id === id);
        if (!run || !canTransition(run.state, to)) return false;
        this.#runs.place(id, to, patch);
        this.sync();
        return true;
    }

    /**
     * Retire a run its job has finished with. Idempotent: whichever of the poll and the
     * event stream arrives second finds the run already out of `running` and does nothing,
     * so nothing settles twice and no successor is submitted twice.
     */
    settle(id: string, to: RunState, patch: RunPatch = {}): boolean {
        const run = this.#runs.list().find(other => other.id === id);
        if (!run || run.state !== 'running') return false;
        this.#runs.settle(id, to, patch);
        this.#deps.onSettled?.(run, to);
        this.#waitDelay = WAIT_MIN_MS;   // a slot just freed; try the queue promptly
        this.sync();
        return true;
    }

    /** Read a finished job's terminal state the one way, wherever it was noticed. */
    static terminalOf(job: JobStatus): { state: RunState; patch: RunPatch } | null {
        if (!job.terminal) return null;
        if (job.status === 'done') return { state: 'done', patch: { percent: 100, detail: '' } };
        if (job.failure?.code === 'cancelled_by_user') {
            return { state: 'cancelled', patch: { percent: 0, detail: '' } };
        }
        return {
            state: 'failed',
            patch: { detail: job.failure?.message ?? job.status }
        };
    }

    /**
     * Submit everything ready, oldest first, stopping at the learned cap. One caller at a
     * time: overlapping passes are how the same run was submitted twice.
     */
    async submitReady(): Promise<void> {
        if (this.#submitting) return;
        this.#submitting = true;
        try {
            await this.#submitReadyOnce();
        } finally {
            this.#submitting = false;
            this.sync();
        }
    }

    async #submitReadyOnce(): Promise<void> {
        const ready = this.#runs.list()
        .filter(run => run.state === 'quoting' || run.state === 'waiting-slot');
        // Set by a 409 in this pass: the account is full right now, so the runs behind
        // this one wait instead of each earning their own refusal.
        let full = false;
        for (const run of ready) {
            if (full || (this.#cap !== null && this.#activeCount() >= this.#cap)) {
                this.transition(run.id, 'waiting-slot');
                continue;
            }
            // Minted once, then reused by every later attempt: a fresh name and key per
            // attempt is what turned a lost 502 reply into a second job on a second box.
            const minted = run.submitKey ? null :
                { runName: newRunName(run.preset), submitKey: crypto.randomUUID() };
            if (minted) this.#runs.update(run.id, minted);
            try {
                const jobId = await this.#deps.submit({ ...run, ...minted });
                this.#quotaBlocked = false;
                this.transition(run.id, 'running', { jobId });
            } catch (error) {
                if (!isQuotaRefusal(error)) {
                    this.transition(run.id, 'failed',
                        { detail: String((error as Error).message) });
                    continue;
                }
                // The quota counts every tab, device and API client on the account; this
                // list sees only what happens in this page. Reading the 409 as "the cap
                // is what I can see" left a run waiting for a slot that would never look
                // free from here -- the retry, not the cap, is what a 409 changes.
                this.#quotaBlocked = true;
                full = true;
                this.transition(run.id, 'waiting-slot');
            }
        }
    }

    /**
     * One pass: read every running run's job, settle the finished ones, then give the
     * waiting queue its turn. Runs whether or not any of them is on screen.
     */
    async pass(): Promise<void> {
        const watched = this.#runs.list()
        .filter(run => run.state === 'running' && run.jobId !== null);
        const snapshots = await Promise.all(watched.map(async run => ({
            run,
            // A run whose status call fails stays running: a dropped connection is not a
            // job outcome, and the next pass asks again.
            job: await this.#deps.fetchJob(run.jobId as string).catch((): null => null)
        })));
        for (const { run, job } of snapshots) {
            if (!job) continue;
            const terminal = RunCoordinator.terminalOf(job);
            if (terminal) {
                this.settle(run.id, terminal.state, terminal.patch);
            } else {
                this.#runs.update(run.id, { detail: job.status });
            }
        }
        if (this.#waiting()) {
            await this.submitReady();
            // Still waiting means the slot is somebody else's; ask less often, but never
            // stop -- the run that frees it may belong to another tab entirely.
            this.#waitDelay = this.#waiting() ?
                Math.min(this.#waitDelay * 2, WAIT_MAX_MS) : WAIT_MIN_MS;
        }
    }

    /**
     * Match the timer to the work: poll while anything runs, keep asking while anything
     * waits, and stop when neither is true.
     */
    sync(): void {
        if (this.#stopped) return;
        const running = this.#runs.list().some(run => run.state === 'running');
        const waiting = this.#waiting();
        const wanted = running ? RUN_POLL_MS : waiting ? this.#waitDelay : 0;
        if (wanted === this.#interval) return;
        this.#clear();
        if (wanted === 0) return;
        this.#interval = wanted;
        this.#tick = this.#timers.set(() => {
            // A pass that fails (offline, a 502) is skipped; the next one retries.
            this.pass().catch((): void => undefined);
        }, wanted);
    }

    /** No further passes, whatever the run list says. Used when the session ends. */
    stop(): void {
        this.#stopped = true;
        this.#clear();
    }

    resume(): void {
        this.#stopped = false;
        this.#waitDelay = WAIT_MIN_MS;
        this.sync();
    }

    #interval = 0;

    #clear(): void {
        if (this.#tick !== null) this.#timers.clear(this.#tick);
        this.#tick = null;
        this.#interval = 0;
    }

    #waiting(): boolean {
        return this.#runs.list().some(run => run.state === 'waiting-slot');
    }

    #activeCount(): number {
        return this.#runs.list().filter(run => run.state === 'running').length;
    }
}

export {
    ALLOWED,
    RUN_POLL_MS,
    RunCoordinator,
    WAIT_MAX_MS,
    WAIT_MIN_MS,
    canTransition
};
