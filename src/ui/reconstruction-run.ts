type RunState =
    | 'uploading'
    | 'paused'
    | 'quoting'
    | 'waiting-slot'
    | 'running'
    | 'done'
    | 'failed';

type Run = {
    id: string;
    state: RunState;
    /** null until a session is opened; set before the first byte moves. */
    datasetId: string | null;
    pipeline: string;
    preset: string;
    /** Chosen at submit time from the names the dataset already uses. */
    runName: string;
    label: string;
    jobId: string | null;
    percent: number;
    detail: string;
};

type RunAction = 'pause' | 'resume' | 'repick' | 'cancel' | 'dismiss' | 'open' | 'retry';

const runKey = (run: Run): string => {
    if (run.jobId) return run.jobId;
    if ((run.state === 'uploading' || run.state === 'paused') && run.datasetId) {
        return `session:${run.datasetId}`;
    }
    return run.id;
};

const runControls = (run: Run, hasFolder: boolean): RunAction[] => {
    switch (run.state) {
        case 'uploading': return ['pause', 'cancel'];
        case 'paused': return [hasFolder ? 'resume' : 'repick', 'cancel'];
        case 'quoting': return ['dismiss'];
        case 'waiting-slot': return ['dismiss'];
        case 'running': return [];
        case 'done': return ['open', 'dismiss'];
        case 'failed': return ['retry', 'dismiss'];
    }
};

export { runControls, runKey };
export type { Run, RunAction, RunState };
