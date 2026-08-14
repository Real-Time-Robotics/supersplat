import type { JobDatasetEvent, JobGpuEvent, JobPullProgress } from 'genesis-recon';

type ReconstructionPipeline = 'splat' | 'photogrammetry';

type UploadResponse = {
    state: 'ready' | 'checkout_required';
    datasetId: string;
    quote: { required: number; balance: number; billable_gpx: number };
    creditsNeeded?: number;
};

type PricingPack = {
    credits: number;
    credits_label?: string;
    price_cents?: number;
    price_label?: string;
};

type PricingCatalog = {
    credit_unit_usd: number;
    note: string;
    packs: PricingPack[];
    custom_min_credits: number;
    custom_max_credits: number;
};

type CheckoutStatus = {
    id: string;
    status: 'pending' | 'paid' | 'expired' | 'failed';
};

type UploadProgress = {
    phase: 'presign' | 'upload' | 'finalize' | 'ingest';
    loaded: number;
    total: number;
    file?: string;
    /** The session these bytes belong to; keys the rate window per transfer. */
    datasetId: string;
};

type StageEvent = {
    phase: 'start' | 'end';
    step: string;
    index: number;
    total: number;
    returncode: number | null;
    seconds?: number | null;
};

type JobProgressEvent = {
    stage: string;
    phase?: string | null;
    mode: 'determinate' | 'indeterminate';
    current: number | null;
    total: number | null;
    unit: string | null;
    message?: string | null;
    rate?: number | null;
    eta_seconds?: number | null;
    file?: string | null;
    file_index?: number | null;
    file_total?: number | null;
    file_loaded?: number | null;
    file_size?: number | null;
    observed_at: string;
};

type JobHeartbeatEvent = {
    worker_alive: boolean;
    heartbeat_at: string | null;
};

type JobFailure = {
    code: string;
    message: string;
    stage?: string | null;
    retryable: boolean;
};

type JobGpu = JobGpuEvent;

type JobStatus = {
    terminal: boolean;
    status: string;
    gpu?: JobGpu | null;
    worker_alive?: boolean | null;
    heartbeat_at?: string | null;
    current_stage?: StageEvent | null;
    progress?: JobProgressEvent | null;
    failure?: JobFailure | null;
};

type RecentDataset = {
    dataset_id: string;
    label: string;
    image_count: number;
    bytes: number;
    created: number;
    /** Attempts per pipeline, failed and live ones included. */
    run_counts: Record<string, number>;
    /** Attempts that produced something openable */
    model_counts: Record<string, number>;
};

type RecentRun = {
    dataset_id: string;
    dataset_label: string;
    image_count: number;
    pipeline: string;
    /** The run's directory on the store. Stable; not what the user sees. */
    run_name: string;
    /** What the user calls it; '' means show run_name. */
    label: string;
    /** The job that wrote it, for renaming. Null once its row is gone. */
    job_id: string | null;
    status: string;
    created: number;
    artifact_count: number;
    bytes: number;
    primary: string;
};

type Artifact = {
    name: string;
    kind: string;
    format: string;
    size: number;
    primary: boolean;
    local?: boolean;
};

type JobArtifactAvailableEvent = Artifact & {
    state: 'available';
    available_at: string;
};

type JobDatasetAvailableEvent = JobDatasetEvent;

type ArtifactSource =
    | { type: 'job'; jobId: string; label: string }
    | { type: 'run'; run: RecentRun; label: string };

export type {
    Artifact,
    ArtifactSource,
    CheckoutStatus,
    JobArtifactAvailableEvent,
    JobDatasetAvailableEvent,
    JobFailure,
    JobGpu,
    JobHeartbeatEvent,
    JobProgressEvent,
    JobPullProgress,
    JobStatus,
    PricingCatalog,
    PricingPack,
    RecentDataset,
    RecentRun,
    ReconstructionPipeline,
    StageEvent,
    UploadProgress,
    UploadResponse
};
