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

export type { Run, RunState };
