import { newRunName } from './reconstruction-names';
import { runKey, type Run } from './reconstruction-run';

const isQuotaRefusal = (error: unknown): boolean => (
    (error as { status?: number })?.status === 409 &&
    (error as { code?: string })?.code === 'concurrent_job_quota_exceeded'
);

class RunStore {
    private runs: Run[] = [];
    private selectedId: string | null = null;
    private cap: number | null = null;
    private submitting = false;
    private listeners: (() => void)[] = [];

    onChange(fn: () => void) {
        this.listeners.push(fn);
    }

    private emit() {
        for (const fn of this.listeners) fn();
    }

    list(): Run[] {
        return this.runs;
    }

    selected(): Run | null {
        return this.runs.find(run => run.id === this.selectedId) ?? null;
    }

    select(id: string | null) {
        this.selectedId = id;
        this.emit();
    }

    /**
     * Add a run, or fold it into the one that already covers the same session or job.
     * Returns the row that now holds it, whose id may not be the one passed in.
     */
    upsert(run: Run): Run {
        const key = runKey(run);
        const existing = this.runs.find(other => runKey(other) === key);
        const merged = existing ? { ...existing, ...run, id: existing.id } : run;
        this.runs = existing ?
            this.runs.map(other => (other.id === existing.id ? merged : other)) :
            [...this.runs, merged];
        if (this.selectedId === null) this.selectedId = merged.id;
        this.fold(merged.id);
        this.emit();
        return merged;
    }

    remove(id: string) {
        this.runs = this.runs.filter(run => run.id !== id);
        if (this.selectedId === id) this.selectedId = this.runs[0]?.id ?? null;
        this.emit();
    }

    update(id: string, patch: Partial<Run>) {
        const before = this.runs.find(run => run.id === id);
        if (!before) return;
        if (Object.entries(patch).every(([key, value]) => before[key as keyof Run] === value)) {
            return;   // a poll tick that learned nothing must not rebuild the list
        }
        this.runs = this.runs.map(run => (run.id === id ? { ...run, ...patch } : run));
        this.fold(id);
        this.emit();
    }

    /**
     * Retire a run whose job the server has called terminal.
     */
    settle(id: string, patch: Partial<Run>) {
        const run = this.runs.find(other => other.id === id);
        if (!run) return;
        this.update(id, { ...patch, runName: run.preset, submitKey: null });
    }

    /**
     * Drop any other row that has become the same run as `id`.
     */
    private fold(id: string) {
        const kept = this.runs.find(run => run.id === id);
        if (!kept) return;
        const key = runKey(kept);
        this.runs = this.runs.filter(run => run.id === id || runKey(run) !== key);
        if (!this.runs.some(run => run.id === this.selectedId)) this.selectedId = id;
    }

    slotCap(): number | null {
        return this.cap;
    }

    /**
     * The account's published cap.
     */
    seedSlotCap(cap: number) {
        if (this.cap === null && Number.isFinite(cap) && cap >= 1) this.cap = cap;
    }

    private activeCount(): number {
        return this.runs.filter(run => run.state === 'running').length;
    }

    /**
     * Submit every run that is ready, oldest first, stopping at the learned cap.
     */
    async submitReady(submit: (run: Run) => Promise<string>): Promise<void> {
        if (this.submitting) return;
        this.submitting = true;
        try {
            await this.submitReadyOnce(submit);
        } finally {
            this.submitting = false;
        }
    }

    private async submitReadyOnce(submit: (run: Run) => Promise<string>): Promise<void> {
        const ready = this.runs.filter(run => (
            run.state === 'quoting' || run.state === 'waiting-slot'));
        for (const run of ready) {
            if (this.cap !== null && this.activeCount() >= this.cap) {
                if (run.state !== 'waiting-slot') this.update(run.id, { state: 'waiting-slot' });
                continue;
            }
            // Minted once, then reused by every later attempt: a fresh name and key per
            // attempt is what turned a lost 502 reply into a second job on a second box.
            const minted = run.submitKey ? null :
                { runName: newRunName(run.preset), submitKey: crypto.randomUUID() };
            if (minted) this.update(run.id, minted);
            try {
                const jobId = await submit({ ...run, ...minted });
                this.update(run.id, { state: 'running', jobId });
            } catch (error) {
                if (!isQuotaRefusal(error)) {
                    this.update(run.id, { state: 'failed', detail: String((error as Error).message) });
                    continue;
                }
                this.cap = Math.max(1, this.activeCount());
                this.update(run.id, { state: 'waiting-slot' });
            }
        }
    }
}

export { RunStore };
