import { runKey, type Run, type RunState } from './reconstruction-run';

/** Everything about a run except where it is in its lifecycle. */
type RunPatch = Partial<Omit<Run, 'id' | 'state'>>;

/**
 * The run list and which of them the panel is showing. Nothing here decides when a run
 * moves -- that is RunCoordinator's, so the schedule has one owner.
 */
class RunStore {
    private runs: Run[] = [];
    private selectedId: string | null = null;
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
        this.fold(merged.id);
        this.emit();
        return merged;
    }

    remove(id: string) {
        this.runs = this.runs.filter(run => run.id !== id);
        if (this.selectedId === id) this.selectedId = this.runs[0]?.id ?? null;
        this.emit();
    }

    /**
     * Everything but the state. Refusing `state` here is what keeps the lifecycle to one
     * owner: a caller that writes it directly has skipped the transition table, and that
     * is a bug however reasonable the move looks from where it stands.
     */
    update(id: string, patch: RunPatch) {
        if ('state' in patch) {
            throw new Error('run state belongs to RunCoordinator; use transition()');
        }
        this.write(id, patch);
    }

    /** The coordinator's own writer: the one path a run's state changes through. */
    place(id: string, state: RunState, patch: RunPatch = {}) {
        this.write(id, { ...patch, state });
    }

    /**
     * Retire a run whose job the server has called terminal.
     */
    settle(id: string, state: RunState, patch: RunPatch = {}) {
        const run = this.runs.find(other => other.id === id);
        if (!run) return;
        this.place(id, state, { ...patch, runName: run.preset, submitKey: null });
    }

    private write(id: string, patch: Partial<Run>) {
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
     * Drop any other row that has become the same run as `id`.
     */
    private fold(id: string) {
        const kept = this.runs.find(run => run.id === id);
        if (!kept) return;
        const key = runKey(kept);
        this.runs = this.runs.filter(run => run.id === id || runKey(run) !== key);
        if (this.selectedId !== null && !this.runs.some(run => run.id === this.selectedId)) {
            this.selectedId = id;   // the selected row was absorbed; follow it
        }
    }
}

export { RunStore, type RunPatch };
