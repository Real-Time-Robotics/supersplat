import { ReconstructionArtifacts } from './reconstruction-artifacts';
import { ReconstructionBilling } from './reconstruction-billing';
import {
    Artifact,
    ArtifactSource,
    JobFailure,
    JobHeartbeatEvent,
    JobProgressEvent,
    JobStatus,
    StageEvent
} from './reconstruction-types';
import { JOB_NOT_FOUND_GRACE, delay, readJson } from './reconstruction-utils';
import { ReconstructionView } from './reconstruction-view';

class ReconstructionJobError extends Error {
    constructor(
        readonly title: string,
        message: string,
        readonly retryable: boolean
    ) {
        super(message);
        this.name = 'ReconstructionJobError';
    }
}

const readableStage = (stage?: string | null) => (
    stage ?
        stage.replace(/[_-]+/g, ' ').replace(/\b\w/g, character => character.toUpperCase()) :
        'reconstruction'
);

const terminalError = (job: JobStatus) => {
    const failure: JobFailure | null | undefined = job.failure;
    if (!failure) {
        return new ReconstructionJobError(
            'Reconstruction did not complete',
            `The job ended with status “${job.status}”. The uploaded dataset is still available.`,
            false
        );
    }
    const stage = readableStage(failure.stage);
    const retryHint = failure.retryable ?
        'The uploaded photos are saved, so retrying will not upload them again.' :
        '';
    switch (failure.code) {
        case 'worker_lost':
            return new ReconstructionJobError(
                'GPU connection was lost',
                `The GPU worker stopped responding before the model was complete. ${retryHint}`,
                failure.retryable
            );
        case 'stage_failed':
            return new ReconstructionJobError(
                `${stage} failed`,
                `That reconstruction step stopped unexpectedly. ${retryHint}`,
                failure.retryable
            );
        case 'stage_killed':
            return new ReconstructionJobError(
                `${stage} ran out of resources`,
                'The GPU stopped this step, usually because it ran out of memory. Try fewer or lower-resolution photos.',
                failure.retryable
            );
        case 'budget_exceeded':
            return new ReconstructionJobError(
                'Processing limit reached',
                'The job reached its GPU-time limit. Reduce the dataset size before trying again.',
                failure.retryable
            );
        case 'invalid_config':
            return new ReconstructionJobError(
                'Dataset could not be processed',
                'The images or reconstruction settings failed validation. Re-select supported, overlapping photos and try again.',
                failure.retryable
            );
        case 'cancelled_by_user':
            return new ReconstructionJobError(
                'Reconstruction cancelled',
                'The job was cancelled before the model was complete.',
                failure.retryable
            );
        case 'platform_error':
            return new ReconstructionJobError(
                'Reconstruction service error',
                `The service hit an internal error. ${retryHint}`,
                failure.retryable
            );
        default:
            return new ReconstructionJobError(
                'Reconstruction did not complete',
                `${failure.message}${retryHint ? ` ${retryHint}` : ''}`,
                failure.retryable
            );
    }
};

const eventData = <T>(event: Event): T | null => {
    if (!(event instanceof MessageEvent)) return null;
    try {
        const data = JSON.parse(event.data) as unknown;
        return typeof data === 'object' && data !== null ? data as T : null;
    } catch {
        return null;
    }
};

class ReconstructionJob {
    private activeJobId: string | null = null;
    private activeEvents: EventSource | null = null;
    private cancelled = false;
    private lastStage: StageEvent | null = null;
    private lastProgress: JobProgressEvent | null = null;
    private lastHeartbeat: JobHeartbeatEvent | null = null;
    private eventStreamUnavailable = false;

    constructor(
        private readonly view: ReconstructionView,
        private readonly billing: ReconstructionBilling,
        private readonly artifacts: ReconstructionArtifacts,
        private readonly canStart: () => boolean
    ) {
    }

    get wasCancelled() {
        return this.cancelled;
    }

    async run(datasetId: string) {
        this.cancelled = false;
        this.lastStage = null;
        this.lastProgress = null;
        this.lastHeartbeat = null;
        this.eventStreamUnavailable = false;
        this.view.setWorkerStatus(null);
        this.view.setRetryAvailable(false);

        const response = await fetch('/api/reconstruction/jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                datasetId,
                preset: 'standard',
                idempotencyKey: crypto.randomUUID()
            })
        });
        const data = await readJson<{ jobId: string }>(response);
        this.activeJobId = data.jobId;
        this.view.setState(
            'Job submitted',
            `Job ${this.activeJobId.slice(0, 8)} · waiting for the first stage`,
            { mode: 'indeterminate' }
        );
        this.followEvents(this.activeJobId);
        await this.waitForJob(this.activeJobId);
    }

    async cancel() {
        this.cancelled = true;
        this.activeEvents?.close();
        this.activeEvents = null;
        this.view.setWorkerStatus(null);
        this.view.setRetryAvailable(false);
        if (this.activeJobId) {
            await fetch(`/api/reconstruction/jobs/${encodeURIComponent(this.activeJobId)}/cancel`, {
                method: 'POST'
            }).catch((): void => {});
        }
        this.activeJobId = null;
    }

    private followEvents(jobId: string) {
        this.activeEvents?.close();
        const source = new EventSource(`/api/reconstruction/jobs/${encodeURIComponent(jobId)}/events`);
        this.activeEvents = source;
        source.onopen = () => {
            this.eventStreamUnavailable = false;
            if (this.lastStage?.phase === 'start') {
                this.view.setStage(this.lastStage);
            }
            if (this.lastProgress) this.view.setStageProgress(this.lastProgress);
            if (this.lastHeartbeat) this.view.setWorkerStatus(this.lastHeartbeat);
        };
        source.addEventListener('stage', (event) => {
            const stage = eventData<StageEvent>(event);
            if (!stage) return;
            this.lastStage = stage;
            this.view.setStage(stage);
        });
        source.addEventListener('progress', (event) => {
            const progress = eventData<JobProgressEvent>(event);
            if (!progress) return;
            this.lastProgress = progress;
            this.view.setStageProgress(progress);
        });
        source.addEventListener('heartbeat', (event) => {
            const heartbeat = eventData<JobHeartbeatEvent>(event);
            if (!heartbeat) return;
            this.lastHeartbeat = heartbeat;
            this.view.setWorkerStatus(heartbeat);
        });
        source.addEventListener('artifact', (event) => {
            const artifact = eventData<{ name?: string }>(event);
            if (!artifact) return;
            this.view.progress.showNotice(
                artifact.name ? `Artifact ready: ${artifact.name}` : 'Artifact ready.'
            );
        });
        source.addEventListener('end', () => {
            source.close();
            if (this.activeEvents === source) this.activeEvents = null;
        });
        source.addEventListener('failed', (event) => {
            const data = eventData<{ message?: string }>(event);
            this.eventStreamUnavailable = true;
            this.view.setState(
                'Reconnecting progress stream',
                data?.message || 'The job continues while final status is checked separately.',
                { mode: 'reconnecting' }
            );
        });
        source.onerror = () => {
            if (this.activeEvents !== source) return;
            this.eventStreamUnavailable = true;
            this.view.setState(
                'Reconnecting progress stream',
                'The job continues while final status is checked separately.',
                { mode: 'reconnecting' }
            );
        };
    }

    private async waitForJob(jobId: string) {
        let transientNotFound = 0;
        let artifacts: Artifact[] = [];
        for (;;) {
            if (this.cancelled) return;
            const response = await fetch(`/api/reconstruction/jobs/${encodeURIComponent(jobId)}`, { cache: 'no-store' });
            if (response.status === 404 && transientNotFound < JOB_NOT_FOUND_GRACE) {
                transientNotFound++;
                this.view.progress.showNotice('Syncing final status and artifacts…');
                await delay(2000);
                continue;
            }
            const data = await readJson<{
                job: JobStatus;
                artifacts?: Artifact[];
            }>(response);
            transientNotFound = 0;
            const { job } = data;
            if (job.terminal) {
                artifacts = Array.isArray(data.artifacts) ? data.artifacts : [];
                this.activeEvents?.close();
                this.activeEvents = null;
                this.view.cancelButton.hidden = true;
                this.view.setWorkerStatus(null);
                this.activeJobId = null;
                if (job.status !== 'done') throw terminalError(job);
                break;
            }
            const hasProgressSnapshot = Boolean(job.current_stage || job.progress);
            if (this.eventStreamUnavailable && !hasProgressSnapshot) {
                this.view.setState(
                    'Reconnecting progress stream',
                    `Job status is still “${job.status}”; final status is checked separately.`,
                    { mode: 'reconnecting' }
                );
            } else if (!hasProgressSnapshot && (!this.lastStage || this.lastStage.phase === 'end')) {
                const title = job.status === 'queued' ? 'Waiting for GPU' : `Job: ${job.status}`;
                const detail = job.status === 'queued' ?
                    'The job is queued and will start automatically.' :
                    'The pipeline is active; waiting for the next stage event.';
                this.view.setState(title, detail, { mode: 'indeterminate' });
            }
            this.applySnapshot(job);
            await delay(2500);
        }

        await this.billing.refreshCredits();
        await this.artifacts.refreshRecentRuns();
        if (!artifacts.length) throw new Error('The job finished without any downloadable artifacts.');
        const source: ArtifactSource = {
            type: 'job',
            jobId,
            label: `Job ${jobId.slice(0, 8)}`
        };
        this.artifacts.showArtifacts(artifacts, source);
        if (artifacts.length === 1) {
            await this.artifacts.openArtifact(artifacts[0], source);
        } else {
            const primary = artifacts.find(artifact => artifact.primary);
            this.view.setState('Reconstruction complete · choose an artifact',
                `${artifacts.length} artifacts are available${primary ? ` · ${primary.name} is recommended` : ''}.`,
                { mode: 'done' });
            this.view.setBusy(false, this.canStart());
        }
    }

    private applySnapshot(job: JobStatus) {
        if (job.worker_alive == null) {
            if (job.status === 'queued') {
                this.lastHeartbeat = null;
                this.view.setWorkerStatus(null);
            }
        } else {
            const heartbeat = {
                worker_alive: job.worker_alive,
                heartbeat_at: job.heartbeat_at ?? null
            };
            this.lastHeartbeat = heartbeat;
            this.view.setWorkerStatus(heartbeat);
        }

        if (job.current_stage) {
            this.lastStage = job.current_stage;
            this.view.setStage(job.current_stage);
        }
        if (job.progress &&
            (!this.lastProgress || job.progress.observed_at >= this.lastProgress.observed_at)) {
            this.lastProgress = job.progress;
            this.view.setStageProgress(job.progress);
        }
    }
}

export {
    ReconstructionJob,
    ReconstructionJobError
};
