import { newRunName } from './names';
import type { Run, RunState } from './run';
import type { RunPatch, RunStore } from './run-store';
import type { JobStatus } from './types';

const RUN_POLL_MS = 15_000;
const WAIT_MIN_MS = 5_000;
const WAIT_MAX_MS = 60_000;

/** Invariant: every state change follows this table. */
const ALLOWED: Record<RunState, readonly RunState[]> = {
    'queued': ['uploading', 'quoting', 'cancelled', 'failed'],
    'uploading': ['queued', 'paused', 'quoting', 'cancelled', 'failed'],
    'paused': ['uploading', 'queued', 'quoting', 'cancelled', 'failed'],
    'quoting': ['queued', 'waiting-slot', 'running', 'cancelled', 'failed'],
    'waiting-slot': ['quoting', 'running', 'cancelled', 'failed'],
    'running': ['done', 'cancelled', 'failed'],
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

class RunCoordinator {
    readonly #runs: RunStore;
    readonly #deps: Deps;
    readonly #timers: Timers;
    #cap: number | null = null;
    #submitting: number | null = null;
    #tick: number | null = null;
    #waitDelay = WAIT_MIN_MS;
    #stopped = false;
    #generation = 0;

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

    setSlotCap(cap: number | null): void {
        this.#cap = cap !== null && Number.isFinite(cap) && cap >= 1 ? cap : null;
    }

    beginSession(cap: number | null): void {
        this.#generation++;
        this.setSlotCap(cap);
        this.resume();
    }

    transition(id: string, to: RunState, patch: RunPatch = {}): boolean {
        const run = this.#runs.list().find(other => other.id === id);
        if (!run || !canTransition(run.state, to)) return false;
        this.#runs.place(id, to, patch);
        this.sync();
        return true;
    }

    settle(id: string, to: RunState, patch: RunPatch = {}): boolean {
        const run = this.#runs.list().find(other => other.id === id);
        if (!run || run.state !== 'running') return false;
        this.#runs.settle(id, to, patch);
        this.#deps.onSettled?.(run, to);
        this.#waitDelay = WAIT_MIN_MS;
        this.sync();
        return true;
    }

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

    async submitReady(): Promise<void> {
        const generation = this.#generation;
        if (this.#stopped || this.#submitting === generation) return;
        this.#submitting = generation;
        try {
            await this.#submitReadyOnce(generation);
        } finally {
            if (this.#submitting === generation) this.#submitting = null;
            if (this.#generation === generation) this.sync();
        }
    }

    async #submitReadyOnce(generation: number): Promise<void> {
        const ready = this.#runs.list()
        .filter(run => run.state === 'quoting' || run.state === 'waiting-slot');
        let full = false;
        for (const run of ready) {
            if (this.#stopped || this.#generation !== generation) return;
            if (full || (this.#cap !== null && this.#activeCount() >= this.#cap)) {
                this.transition(run.id, 'waiting-slot');
                continue;
            }
            // Invariant: reuse name/key after an ambiguous submit.
            const minted = run.submitKey ? null :
                { runName: newRunName(run.preset), submitKey: crypto.randomUUID() };
            if (minted) this.#runs.update(run.id, minted);
            try {
                const jobId = await this.#deps.submit({ ...run, ...minted });
                if (this.#stopped || this.#generation !== generation) return;
                this.transition(run.id, 'running', { jobId });
            } catch (error) {
                if (this.#stopped || this.#generation !== generation) return;
                if (!isQuotaRefusal(error)) {
                    this.transition(run.id, 'failed',
                        { detail: String((error as Error).message) });
                    continue;
                }
                // A 409 is account-wide; it must not lower the published plan cap.
                full = true;
                this.transition(run.id, 'waiting-slot');
            }
        }
    }

    async pass(): Promise<void> {
        const generation = this.#generation;
        if (this.#stopped) return;
        const watched = this.#runs.list()
        .filter(run => run.state === 'running' && run.jobId !== null);
        const snapshots = await Promise.all(watched.map(async run => ({
            run,
            job: await this.#deps.fetchJob(run.jobId as string).catch((): null => null)
        })));
        if (this.#stopped || this.#generation !== generation) return;
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
            this.#waitDelay = this.#waiting() ?
                Math.min(this.#waitDelay * 2, WAIT_MAX_MS) : WAIT_MIN_MS;
            this.sync();
        }
    }

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
            this.pass().catch((): void => undefined);
        }, wanted);
    }

    stop(): void {
        this.#generation++;
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

export { RunCoordinator, canTransition };
