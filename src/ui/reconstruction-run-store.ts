import { runKey, type Run, type RunState } from './reconstruction-run';

type RunPatch = Partial<Omit<Run, 'id' | 'state'>>;

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

    clear() {
        if (this.runs.length === 0 && this.selectedId === null) return;
        this.runs = [];
        this.selectedId = null;
        this.emit();
    }

    upsert(run: Run): Run {
        const key = runKey(run);
        const existing = this.runs.find(other => runKey(other) === key);
        // Existing states change only through RunCoordinator.
        const merged = existing ?
            { ...existing, ...run, id: existing.id, state: existing.state } : run;
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

    update(id: string, patch: RunPatch) {
        if ('state' in patch) {
            throw new Error('run state belongs to RunCoordinator; use transition()');
        }
        this.write(id, patch);
    }

    place(id: string, state: RunState, patch: RunPatch = {}) {
        this.write(id, { ...patch, state });
    }

    settle(id: string, state: RunState, patch: RunPatch = {}) {
        const run = this.runs.find(other => other.id === id);
        if (!run) return;
        this.place(id, state, { ...patch, runName: run.preset, submitKey: null });
    }

    private write(id: string, patch: Partial<Run>) {
        const before = this.runs.find(run => run.id === id);
        if (!before) return;
        if (Object.entries(patch).every(([key, value]) => before[key as keyof Run] === value)) {
            return;
        }
        this.runs = this.runs.map(run => (run.id === id ? { ...run, ...patch } : run));
        this.fold(id);
        this.emit();
    }

    private fold(id: string) {
        const kept = this.runs.find(run => run.id === id);
        if (!kept) return;
        const key = runKey(kept);
        this.runs = this.runs.filter(run => run.id === id || runKey(run) !== key);
        if (this.selectedId !== null && !this.runs.some(run => run.id === this.selectedId)) {
            this.selectedId = id;
        }
    }
}

export { RunStore, type RunPatch };
