import { ReconstructionArtifacts } from './reconstruction-artifacts';
import { ReconstructionBilling } from './reconstruction-billing';
import { Artifact, ArtifactSource, StageEvent } from './reconstruction-types';
import { JOB_NOT_FOUND_GRACE, delay, readJson } from './reconstruction-utils';
import { ReconstructionView } from './reconstruction-view';

class ReconstructionJob {
    private activeJobId: string | null = null;
    private activeEvents: EventSource | null = null;
    private cancelled = false;
    private logLines: string[] = [];
    private stageProgress = 0;
    private readonly logs: HTMLPreElement;

    constructor(
        private readonly view: ReconstructionView,
        private readonly billing: ReconstructionBilling,
        private readonly artifacts: ReconstructionArtifacts,
        private readonly canStart: () => boolean
    ) {
        this.logs = view.query('.recon-logs');
    }

    get wasCancelled() {
        return this.cancelled;
    }

    async run(datasetId: string) {
        this.cancelled = false;
        this.logs.hidden = true;
        this.logLines = [];
        this.stageProgress = 0;

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
        this.view.setState('Job running', `Job ${this.activeJobId.slice(0, 8)} · waiting for the first stage`, 62);
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
        this.logs.hidden = false;

        source.addEventListener('log', (event) => {
            let line: unknown = event.data;
            try {
                line = JSON.parse(event.data);
            } catch {
                // Already plain text.
            }
            this.logLines.push(String(line));
            this.logLines = this.logLines.slice(-40);
            this.logs.textContent = this.logLines.join('\n');
            this.logs.scrollTop = this.logs.scrollHeight;
        });
        source.addEventListener('stage', (event) => {
            const stage = JSON.parse(event.data) as StageEvent;
            const ratio = stage.total > 0 ?
                (stage.index - (stage.phase === 'start' ? 1 : 0)) / stage.total :
                0;
            this.stageProgress = 62 + Math.max(0, Math.min(1, ratio)) * 29;
            const verb = stage.phase === 'start' ? 'Running' : 'Done';
            this.view.setState(`${verb}: ${stage.step}`, `Stage ${stage.index} / ${stage.total}`, this.stageProgress);
        });
        source.addEventListener('artifact', (event) => {
            const artifact = JSON.parse(event.data) as { name?: string };
            this.view.statusDetail.textContent = artifact.name ? `Artifact ready: ${artifact.name}` : 'Artifact ready.';
        });
        source.addEventListener('end', () => {
            source.close();
            if (this.activeEvents === source) this.activeEvents = null;
        });
        source.addEventListener('failed', (event) => {
            const data = JSON.parse(event.data) as { message?: string };
            this.view.statusDetail.textContent = data.message || 'Lost connection to the job event stream.';
            source.close();
        });
        source.onerror = () => {
            source.close();
            if (this.activeEvents === source) this.activeEvents = null;
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
                this.view.statusDetail.textContent = 'Syncing final status and artifacts…';
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
            if (this.stageProgress === 0) {
                const progress = job.status === 'queued' ? 62 : job.status === 'viewer' ? 91 : 68;
                this.view.setState(`Job: ${job.status}`,
                    'The pipeline is running on the GPU; detailed progress appears per stage.',
                    progress);
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
                100);
            this.view.setBusy(false, this.canStart());
        }
    }
}

export { ReconstructionJob };
