import { ReconstructionArtifacts } from './reconstruction-artifacts';
import { ReconstructionBilling } from './reconstruction-billing';
import { Artifact, ArtifactSource, StageEvent } from './reconstruction-types';
import { JOB_NOT_FOUND_GRACE, delay, readJson } from './reconstruction-utils';
import { ReconstructionView } from './reconstruction-view';

class ReconstructionJob {
    private activeJobId: string | null = null;
    private activeEvents: EventSource | null = null;
    private cancelled = false;
    private lastStage: StageEvent | null = null;
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
        this.eventStreamUnavailable = false;

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
        };
        source.addEventListener('stage', (event) => {
            const stage = JSON.parse(event.data) as StageEvent;
            this.lastStage = stage;
            this.view.setStage(stage);
        });
        source.addEventListener('artifact', (event) => {
            const artifact = JSON.parse(event.data) as { name?: string };
            this.view.progress.showNotice(
                artifact.name ? `Artifact ready: ${artifact.name}` : 'Artifact ready.'
            );
        });
        source.addEventListener('end', () => {
            source.close();
            if (this.activeEvents === source) this.activeEvents = null;
        });
        source.addEventListener('failed', (event) => {
            const data = JSON.parse(event.data) as { message?: string };
            this.eventStreamUnavailable = true;
            this.view.setState(
                'Reconnecting progress stream',
                data.message || 'The job continues while final status is checked separately.',
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
                job: { terminal: boolean; status: string };
                artifacts?: Artifact[];
            }>(response);
            transientNotFound = 0;
            const { job } = data;
            if (job.terminal) {
                artifacts = Array.isArray(data.artifacts) ? data.artifacts : [];
                this.activeEvents?.close();
                this.activeEvents = null;
                this.view.cancelButton.hidden = true;
                this.activeJobId = null;
                if (job.status !== 'done') throw new Error(`Job ended with status “${job.status}”.`);
                break;
            }
            if (this.eventStreamUnavailable) {
                this.view.setState(
                    'Reconnecting progress stream',
                    `Job status is still “${job.status}”; final status is checked separately.`,
                    { mode: 'reconnecting' }
                );
            } else if (!this.lastStage || this.lastStage.phase === 'end') {
                const title = job.status === 'queued' ? 'Waiting for GPU' : `Job: ${job.status}`;
                const detail = job.status === 'queued' ?
                    'The job is queued and will start automatically.' :
                    'The pipeline is active; waiting for the next stage event.';
                this.view.setState(title, detail, { mode: 'indeterminate' });
            }
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
}

export { ReconstructionJob };
