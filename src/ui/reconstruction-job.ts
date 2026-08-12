import type { ReconstructionArtifacts } from './reconstruction-artifacts';
import type { ReconstructionBilling } from './reconstruction-billing';
import { reconFetch } from './reconstruction-http';
import type { ProgressVisual } from './reconstruction-progress';
import type {
    Artifact,
    ArtifactSource,
    JobArtifactAvailableEvent,
    JobDatasetAvailableEvent,
    JobFailure,
    JobGpu,
    JobHeartbeatEvent,
    JobProgressEvent,
    JobStatus,
    ReconstructionPipeline,
    StageEvent
} from './reconstruction-types';
import {
    JOB_NOT_FOUND_GRACE,
    OPENABLE_ARTIFACT_EXTENSIONS,
    delay,
    readJson
} from './reconstruction-utils';
import type { ReconstructionView } from './reconstruction-view';

const queuedState = (gpu: JobGpu | null | undefined): [string, string, ProgressVisual] => {
    switch (gpu?.state) {
        case 'creating':
            return ['Đang thuê GPU',
                `Fleet đã hết chỗ nên hệ thống đang đặt một máy GPU trên ${gpu.provider}.`,
                { mode: 'indeterminate', center: '1/3' }];
        case 'loading':
            return ['Đang khởi tạo GPU',
                'Máy đã đặt xong và đang tải image pipeline. Bước này thường mất vài phút.',
                { mode: 'indeterminate', center: '2/3' }];
        case 'running':
            return ['GPU đã sẵn sàng',
                'Đang bàn giao job cho máy vừa thuê.',
                { mode: 'indeterminate', center: '3/3' }];
        default:
            return ['Đang chờ máy trống',
                'Job đã vào hàng đợi và sẽ tự khởi động khi có máy trống.',
                { mode: 'indeterminate' }];
    }
};

type WatchOutcome = 'done' | 'detached';

class ReconstructionJobError extends Error {
    constructor(
        readonly title: string,
        message: string,
        readonly retryable: boolean,
        readonly code: string = ''
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
                failure.retryable,
                failure.code
            );
        case 'stage_failed':
            return new ReconstructionJobError(
                `${stage} failed`,
                `That reconstruction step stopped unexpectedly. ${retryHint}`,
                failure.retryable,
                failure.code
            );
        case 'stage_killed':
            return new ReconstructionJobError(
                `${stage} ran out of resources`,
                'The GPU stopped this step, usually because it ran out of memory. Try fewer or lower-resolution photos.',
                failure.retryable,
                failure.code
            );
        case 'budget_exceeded':
            return new ReconstructionJobError(
                'Processing limit reached',
                'The job reached its GPU-time limit. Reduce the dataset size before trying again.',
                failure.retryable,
                failure.code
            );
        case 'invalid_config':
            return new ReconstructionJobError(
                'Dataset could not be processed',
                'The images or reconstruction settings failed validation. Re-select supported, overlapping photos and try again.',
                failure.retryable,
                failure.code
            );
        case 'cancelled_by_user':
            return new ReconstructionJobError(
                'Reconstruction cancelled',
                'The job was cancelled before the model was complete.',
                failure.retryable,
                failure.code
            );
        case 'platform_error':
            return new ReconstructionJobError(
                'Reconstruction service error',
                `The service hit an internal error. ${retryHint}`,
                failure.retryable,
                failure.code
            );
        default:
            return new ReconstructionJobError(
                'Reconstruction did not complete',
                `${failure.message}${retryHint ? ` ${retryHint}` : ''}`,
                failure.retryable,
                failure.code
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
    private watchGeneration = 0;
    private cancelled = false;
    private lastStage: StageEvent | null = null;
    private lastProgress: JobProgressEvent | null = null;
    private lastHeartbeat: JobHeartbeatEvent | null = null;
    private eventStreamUnavailable = false;
    private deliveryActive = false;
    private availablePrimary: Artifact | null = null;
    private openingPrimary = false;
    private primaryOpenAttempted = false;
    private openedPrimaryName: string | null = null;
    private primaryOpenPromise: Promise<void> | null = null;
    private terminalFailure = false;

    constructor(
        private readonly view: ReconstructionView,
        private readonly billing: ReconstructionBilling,
        private readonly artifacts: ReconstructionArtifacts
    ) {
        this.view.openPrimaryButton.addEventListener('click', () => this.togglePrimaryOpen());
    }

    async submit(datasetId: string, pipeline: ReconstructionPipeline,
        runName: string, idempotencyKey: string): Promise<string> {
        const response = await reconFetch('/api/reconstruction/jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                datasetId,
                pipeline,
                preset: 'standard',
                runName,
                idempotencyKey
            })
        });
        if (response.status === 409) {
            const body = await response.json().catch(() => ({}));
            const refusal = new Error(body.error || 'Đã đạt giới hạn số job chạy song song.') as
                Error & { status?: number; code?: string };
            refusal.status = 409;
            refusal.code = body.code || '';
            throw refusal;
        }
        const data = await readJson<{ jobId: string }>(response);
        return data.jobId;
    }

    attach(jobId: string): Promise<WatchOutcome> {
        const generation = ++this.watchGeneration;
        this.cancelled = false;
        this.lastStage = null;
        this.lastProgress = null;
        this.lastHeartbeat = null;
        this.eventStreamUnavailable = false;
        this.deliveryActive = false;
        this.availablePrimary = null;
        this.openingPrimary = false;
        this.primaryOpenAttempted = false;
        this.openedPrimaryName = null;
        this.primaryOpenPromise = null;
        this.terminalFailure = false;
        this.view.openPrimaryButton.hidden = true;
        this.view.openPrimaryButton.disabled = false;
        this.view.openPrimaryButton.textContent = 'Open model now';
        this.view.cancelButton.disabled = false;
        this.view.cancelButton.hidden = false;
        this.view.setWorkerStatus(null);
        this.view.resetStartLabel();

        this.activeJobId = jobId;
        this.followEvents(jobId);
        return this.waitForJob(jobId, generation);
    }

    get watching(): string | null {
        return this.activeJobId;
    }

    private stillWatching(generation: number): boolean {
        return generation === this.watchGeneration;
    }

    detach() {
        this.watchGeneration++;
        this.activeEvents?.close();
        this.activeEvents = null;
        this.activeJobId = null;
        this.view.setWorkerStatus(null);
        this.view.resetStartLabel();
        this.view.cancelButton.hidden = true;
        this.view.openPrimaryButton.hidden = true;
    }

    async cancel(): Promise<boolean> {
        if (this.activeJobId) {
            const response = await reconFetch(`/api/reconstruction/jobs/${encodeURIComponent(this.activeJobId)}/cancel`, {
                method: 'POST'
            });
            if (response.status === 409) {
                this.enterDelivery();
                return false;
            }
            if (!response.ok) await readJson(response);
        }
        this.cancelled = true;
        this.activeEvents?.close();
        this.activeEvents = null;
        this.view.setWorkerStatus(null);
        this.view.resetStartLabel();
        return true;
    }

    private followEvents(jobId: string) {
        this.activeEvents?.close();
        const source = new EventSource(`/api/reconstruction/jobs/${encodeURIComponent(jobId)}/events`);
        this.activeEvents = source;
        source.onopen = () => {
            this.eventStreamUnavailable = false;
            if (this.lastStage?.phase === 'start') {
                this.view.setStage(this.lastStage);
                if (this.lastProgress?.stage === this.lastStage.step) {
                    this.view.setStageProgress(this.lastProgress);
                }
            }
            if (this.lastHeartbeat) this.view.setWorkerStatus(this.lastHeartbeat);
        };
        source.addEventListener('stage', (event) => {
            const stage = eventData<StageEvent>(event);
            if (!stage) return;
            this.lastStage = stage;
            this.view.setStage(stage);
            this.observeStage(stage);
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
            const artifact = eventData<JobArtifactAvailableEvent>(event);
            if (!artifact || artifact.state !== 'available' ||
                artifact.primary !== true ||
                typeof artifact.name !== 'string' || !artifact.name) return;
            this.offerPrimary(artifact);
        });
        source.addEventListener('dataset', (event) => {
            const dataset = eventData<JobDatasetAvailableEvent>(event);
            if (!dataset || dataset.state !== 'available' || dataset.kind !== 'sparse' ||
                typeof dataset.dataset_id !== 'string' || !dataset.dataset_id) return;
            if (!this.availablePrimary) {
                this.view.progress.showNotice('Camera alignment data is available.', 8000);
            }
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

    private renderPending(job: JobStatus, artifacts: Artifact[]) {
        if (this.cancelled) {
            this.view.setState('Đang huỷ luồng',
                'Đã gửi yêu cầu dừng. Đang chờ máy chủ xác nhận job đã kết thúc.',
                { mode: 'indeterminate', center: 'Huỷ' });
            return;
        }
        for (const artifact of artifacts) this.offerPrimary(artifact);
        const hasProgressSnapshot = Boolean(job.current_stage || job.progress);
        if (this.eventStreamUnavailable && !hasProgressSnapshot) {
            this.view.setState(
                'Reconnecting progress stream',
                `Job status is still “${job.status}”; final status is checked separately.`,
                { mode: 'reconnecting' }
            );
        } else if (!hasProgressSnapshot && (!this.lastStage || this.lastStage.phase === 'end')) {
            if (job.status === 'queued') {
                this.view.setState(...queuedState(job.gpu));
            } else {
                this.view.setState(`Job: ${job.status}`,
                    'The pipeline is active; waiting for the next stage event.',
                    { mode: 'indeterminate' });
            }
        }
        this.applySnapshot(job);
    }

    private async waitForJob(jobId: string, generation: number): Promise<WatchOutcome> {
        let transientNotFound = 0;
        let artifacts: Artifact[] = [];
        for (;;) {
            if (!this.stillWatching(generation)) return 'detached';
            const response = await reconFetch(`/api/reconstruction/jobs/${encodeURIComponent(jobId)}`, { cache: 'no-store' });
            if (!this.stillWatching(generation)) return 'detached';
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
                this.deliveryActive = false;
                this.activeEvents?.close();
                this.activeEvents = null;
                this.view.cancelButton.hidden = true;
                this.view.setWorkerStatus(null);
                this.activeJobId = null;
                if (job.status !== 'done') {
                    this.terminalFailure = true;
                    this.artifacts.cancelDownload();
                    this.view.openPrimaryButton.hidden = true;
                    throw terminalError(job);
                }
                break;
            }
            this.renderPending(job, data.artifacts ?? []);
            await delay(this.cancelled ? 7500 : 2500);
        }

        if (!this.stillWatching(generation)) return 'detached';
        if (this.primaryOpenPromise) await this.primaryOpenPromise;
        this.view.openPrimaryButton.hidden = true;
        await this.billing.refreshCredits();
        await this.artifacts.refreshRecentRuns();
        if (!this.stillWatching(generation)) return 'detached';
        if (!artifacts.length) throw new Error('The job finished without any downloadable artifacts.');
        const source: ArtifactSource = {
            type: 'job',
            jobId,
            label: `Job ${jobId.slice(0, 8)}`
        };
        this.artifacts.showArtifacts(artifacts, source);
        if (artifacts.length === 1 && !this.primaryOpenAttempted) {
            await this.artifacts.openArtifact(artifacts[0], source);
        } else {
            const primary = artifacts.find(artifact => artifact.primary);
            this.view.setState('Reconstruction complete · choose an artifact',
                `${artifacts.length} artifacts are available${primary ? ` · ${primary.name} is recommended` : ''}.`,
                { mode: 'done' });
        }
        return 'done';
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
            this.observeStage(job.current_stage);
        }
        if (job.progress &&
            (!this.lastProgress || job.progress.observed_at >= this.lastProgress.observed_at)) {
            this.lastProgress = job.progress;
            this.view.setStageProgress(job.progress);
        }
    }

    private observeStage(stage: StageEvent) {
        if (stage.step === 'publish_results') this.enterDelivery();
    }

    private enterDelivery() {
        const firstObservation = !this.deliveryActive;
        this.deliveryActive = true;
        this.view.cancelButton.hidden = true;
        this.view.cancelButton.disabled = true;
        if (firstObservation && !this.availablePrimary) {
            this.view.progress.showNotice(
                'Processing is complete. Securing your results cannot be cancelled.',
                12000
            );
        }
    }

    private offerPrimary(artifact: Artifact) {
        if (!artifact.primary || !OPENABLE_ARTIFACT_EXTENSIONS.test(artifact.name)) return;
        const firstObservation = this.availablePrimary?.name !== artifact.name;
        this.availablePrimary = artifact;
        if (this.openedPrimaryName === artifact.name) return;
        const button = this.view.openPrimaryButton;
        button.hidden = false;
        button.disabled = false;
        if (!this.openingPrimary && !this.primaryOpenAttempted) {
            button.textContent = 'Open model now';
        }
        button.title = `${artifact.name} is ready while remaining files continue uploading`;
        button.setAttribute('aria-label', `Open ${artifact.name} now`);
        if (firstObservation) {
            this.view.progress.showNotice(
                `Primary model ready: ${artifact.name}. Remaining files are still uploading.`,
                10000
            );
        }
    }

    private togglePrimaryOpen() {
        if (this.openingPrimary) {
            this.view.openPrimaryButton.disabled = true;
            this.artifacts.cancelDownload();
            return;
        }
        const artifact = this.availablePrimary;
        const jobId = this.activeJobId;
        if (!artifact || !jobId) return;
        this.primaryOpenAttempted = true;
        this.openingPrimary = true;
        const button = this.view.openPrimaryButton;
        button.textContent = 'Cancel opening';
        button.title = `Cancel downloading ${artifact.name}`;
        const source: ArtifactSource = {
            type: 'job',
            jobId,
            label: `Job ${jobId.slice(0, 8)}`
        };
        const task = this.openPrimary(artifact, source);
        this.primaryOpenPromise = task;
        task.finally(() => {
            if (this.primaryOpenPromise === task) this.primaryOpenPromise = null;
        });
    }

    private async openPrimary(artifact: Artifact, source: ArtifactSource) {
        const result = await this.artifacts.openArtifact(artifact, source, {
            manageView: false,
            report: (title, detail, visual) => {
                const button = this.view.openPrimaryButton;
                button.title = `${title}: ${detail}`;
                if (visual.mode === 'determinate') {
                    button.textContent = `Cancel opening · ${Math.round(visual.value)}%`;
                } else if (title === 'Opening artifact') {
                    button.textContent = 'Opening model…';
                    button.disabled = true;
                }
            }
        });
        this.openingPrimary = false;
        const button = this.view.openPrimaryButton;
        button.disabled = false;
        if (this.terminalFailure) {
            button.hidden = true;
            return;
        }
        if (result.status === 'opened' || result.status === 'downloaded') {
            this.openedPrimaryName = artifact.name;
            button.hidden = true;
            this.view.progress.showNotice(
                this.deliveryActive ?
                    'Primary model opened. Remaining files are still uploading.' :
                    'Primary model opened.',
                8000
            );
        } else {
            button.hidden = false;
            button.textContent = result.status === 'cancelled' ? 'Open model now' : 'Retry opening';
            button.title = result.message || `Open ${artifact.name}`;
            if (result.status === 'failed') {
                this.view.progress.showNotice(
                    `Could not open the primary model yet: ${result.message || 'download failed'}`,
                    8000
                );
            }
        }
    }
}

export {
    ReconstructionJob,
    ReconstructionJobError,
    type WatchOutcome
};
