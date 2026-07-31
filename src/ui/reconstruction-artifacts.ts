import { Events } from '../events';
import { ReconstructionDatasets } from './reconstruction-datasets';
import type { ProgressVisual } from './reconstruction-progress';
import { Artifact, ArtifactSource, RecentDataset, RecentRun } from './reconstruction-types';
import {
    OPENABLE_ARTIFACT_EXTENSIONS,
    formatBytes,
    formatDuration,
    messageOf,
    readJson
} from './reconstruction-utils';
import { ReconstructionView } from './reconstruction-view';

type ArtifactOpenResult = {
    status: 'opened' | 'downloaded' | 'cancelled' | 'failed';
    message?: string;
};

type ArtifactOpenOptions = {
    manageView?: boolean;
    report?: (title: string, detail: string, visual: ProgressVisual) => void;
};

class ReconstructionArtifacts {
    private activeDownload: AbortController | null = null;
    private activeDatasetId: string | null = null;
    private readonly artifactLocations = new Map<string, HTMLElement>();
    private readonly datasets: ReconstructionDatasets;

    constructor(
        private readonly events: Events,
        private readonly view: ReconstructionView,
        private readonly canStart: () => boolean,
        onDatasetDeleted: (datasetId: string) => Promise<void> | void
    ) {
        this.datasets = new ReconstructionDatasets(
            events,
            view,
            canStart,
            async (datasetId) => {
                if (this.activeDatasetId === datasetId) {
                    this.activeDatasetId = null;
                    this.view.artifactPanel.hidden = true;
                    this.view.artifactList.textContent = '';
                    this.artifactLocations.clear();
                }
                await onDatasetDeleted(datasetId);
                await this.refreshRecentRuns();
            }
        );
        view.refreshRunsButton.addEventListener('click', () => this.refreshRecentRuns());
    }

    cancelDownload() {
        this.activeDownload?.abort();
    }

    get isDownloading() {
        return this.activeDownload !== null;
    }

    async refreshRecentRuns() {
        this.view.refreshRunsButton.disabled = true;
        try {
            const response = await fetch('/api/reconstruction/runs?limit=12', { cache: 'no-store' });
            const data = await readJson<{ datasets: RecentDataset[] }>(response);
            this.view.recentRuns.textContent = '';
            if (!data.datasets.length) {
                const empty = document.createElement('span');
                empty.textContent = 'No reconstruction datasets yet.';
                this.view.recentRuns.appendChild(empty);
                return;
            }
            for (const dataset of data.datasets) {
                const card = document.createElement('section');
                card.className = 'recon-dataset';
                const heading = document.createElement('div');
                heading.className = 'recon-dataset-heading';
                const info = document.createElement('div');
                const name = document.createElement('strong');
                name.textContent = dataset.label || dataset.dataset_id;
                name.title = dataset.label || dataset.dataset_id;
                const datasetDetail = document.createElement('span');
                const created = new Date(dataset.created < 1e12 ? dataset.created * 1000 : dataset.created);
                datasetDetail.textContent =
                    `${dataset.image_count.toLocaleString()} source images · ${formatBytes(dataset.bytes)} · ${created.toLocaleString('en-US')}`;
                info.append(name, datasetDetail);
                const deleteButton = document.createElement('button');
                deleteButton.type = 'button';
                deleteButton.className = 'recon-button recon-delete-dataset';
                deleteButton.textContent = 'Delete dataset';
                deleteButton.title = `Delete dataset ${dataset.label || dataset.dataset_id}`;
                deleteButton.setAttribute(
                    'aria-label',
                    `Delete dataset ${dataset.label || dataset.dataset_id} and all of its data`
                );
                deleteButton.addEventListener(
                    'click',
                    () => this.datasets.requestDelete(dataset, deleteButton)
                );
                heading.append(info, deleteButton);
                const models = document.createElement('div');
                models.className = 'recon-dataset-models';
                if (!dataset.models.length) {
                    const empty = document.createElement('span');
                    empty.textContent = 'No completed models yet.';
                    models.appendChild(empty);
                }
                for (const run of dataset.models) {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'recon-button recon-run';
                    const runName = document.createElement('strong');
                    runName.textContent = `${run.pipeline}/${run.run_name}`;
                    const runCreated = new Date(run.created < 1e12 ? run.created * 1000 : run.created);
                    const detail = document.createElement('span');
                    const artifactLabel =
                        `${run.artifact_count} artifact${run.artifact_count === 1 ? '' : 's'}`;
                    detail.textContent =
                        `${runCreated.toLocaleString('en-US')} · ${artifactLabel} · ${formatBytes(run.bytes)}`;
                    button.append(runName, detail);
                    button.addEventListener('click', () => this.loadRecentRunArtifacts(run));
                    models.appendChild(button);
                }
                card.append(heading, models);
                this.view.recentRuns.appendChild(card);
            }
        } catch (error) {
            this.view.recentRuns.textContent = `Could not load datasets: ${messageOf(error)}`;
        } finally {
            this.view.refreshRunsButton.disabled = false;
        }
    }

    showArtifacts(artifacts: Artifact[], source: ArtifactSource) {
        this.view.setTab('recent');
        this.activeDatasetId = source.type === 'run' ? source.run.dataset_id : null;
        this.view.artifactPanel.hidden = false;
        this.view.artifactTitle.textContent = source.label;
        this.view.artifactList.textContent = '';
        this.artifactLocations.clear();
        for (const artifact of artifacts) {
            const row = document.createElement('div');
            row.className = `recon-artifact${artifact.primary ? ' primary' : ''}`;
            const info = document.createElement('div');
            const name = document.createElement('strong');
            name.textContent = artifact.name;
            name.title = artifact.name;
            const detail = document.createElement('span');
            const descriptors = [artifact.kind, artifact.format, formatBytes(artifact.size)].filter(Boolean);
            detail.textContent = descriptors.join(' · ');
            info.appendChild(name);
            if (artifact.primary) {
                const badge = document.createElement('em');
                badge.textContent = 'Primary';
                info.appendChild(badge);
            }
            info.appendChild(detail);
            const action = document.createElement('button');
            const openable = OPENABLE_ARTIFACT_EXTENSIONS.test(artifact.name);
            action.type = 'button';
            action.className = 'recon-button';
            action.textContent = openable ? 'Open' : 'Download';
            action.title = openable ? 'Download and open in SuperSplat' : 'Download this artifact';
            action.addEventListener('click', () => this.openArtifact(artifact, source));
            const location = document.createElement('span');
            location.className = 'recon-artifact-location';
            location.setAttribute('role', 'img');
            this.artifactLocations.set(artifact.name, location);
            this.updateArtifactLocation(artifact);
            row.append(info, action, location);
            this.view.artifactList.appendChild(row);
        }
    }

    async openArtifact(
        artifact: Artifact,
        source: ArtifactSource,
        options: ArtifactOpenOptions = {}
    ): Promise<ArtifactOpenResult> {
        this.activeDownload?.abort();
        const controller = new AbortController();
        this.activeDownload = controller;
        const manageView = options.manageView ?? true;
        const report = options.report ??
            ((title: string, detail: string, visual: ProgressVisual) => this.view.setState(title, detail, visual));
        if (manageView) {
            this.view.setBusy(true, this.canStart());
            this.view.cancelButton.hidden = false;
        }
        const filename = artifact.name.split('/').pop() || 'genesis-artifact';
        try {
            let response: Response;
            if (source.type === 'job') {
                const route = `/api/reconstruction/jobs/${encodeURIComponent(source.jobId)}/model` +
                    `?name=${encodeURIComponent(artifact.name)}`;
                response = await fetch(route, { signal: controller.signal, cache: 'no-store' });
            } else {
                const { run } = source;
                const route = `/api/reconstruction/datasets/${encodeURIComponent(run.dataset_id)}` +
                    `/runs/${encodeURIComponent(run.pipeline)}/${encodeURIComponent(run.run_name)}/model` +
                    `?name=${encodeURIComponent(artifact.name)}&created=${encodeURIComponent(run.created)}`;
                response = await fetch(route, { signal: controller.signal, cache: 'no-store' });
            }
            if (!response.ok) await readJson(response);
            artifact.local = response.headers.get('X-Artifact-Local') === 'true';
            this.updateArtifactLocation(artifact);
            const blob = await this.readDownload(response, artifact, controller.signal, report);
            artifact.local = true;
            this.updateArtifactLocation(artifact);
            if (OPENABLE_ARTIFACT_EXTENSIONS.test(filename)) {
                report(
                    'Opening artifact',
                    `${filename} · ${formatBytes(blob.size)}`,
                    { mode: 'indeterminate', center: 'Open' }
                );
                const file = new File([blob], filename, {
                    type: blob.type || 'application/octet-stream'
                });
                await this.events.invoke('import', [{ filename, contents: file }]);
                report(
                    'Artifact opened in SuperSplat',
                    `${filename} · ${formatBytes(blob.size)}`,
                    { mode: 'done' }
                );
                return { status: 'opened' };
            }
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = filename;
            anchor.click();
            setTimeout(() => URL.revokeObjectURL(url), 0);
            report(
                'Artifact downloaded',
                `${filename} · ${formatBytes(blob.size)}`,
                { mode: 'done' }
            );
            return { status: 'downloaded' };
        } catch (error) {
            if (this.activeDownload === controller) {
                if ((error as DOMException)?.name === 'AbortError') {
                    report('Download cancelled', filename, { mode: 'idle' });
                } else {
                    report('Could not download artifact', messageOf(error), { mode: 'failed' });
                }
            }
            return (error as DOMException)?.name === 'AbortError' ?
                { status: 'cancelled' } :
                { status: 'failed', message: messageOf(error) };
        } finally {
            if (this.activeDownload === controller) {
                this.activeDownload = null;
                if (manageView) {
                    this.view.cancelButton.hidden = true;
                    this.view.setBusy(false, this.canStart());
                }
            }
        }
    }

    private async loadRecentRunArtifacts(run: RecentRun) {
        this.view.setBusy(true, this.canStart());
        const label = `${run.dataset_label || run.dataset_id} · ${run.pipeline}/${run.run_name}`;
        this.view.setState('Loading artifact list', label, { mode: 'indeterminate' });
        try {
            const route = `/api/reconstruction/datasets/${encodeURIComponent(run.dataset_id)}` +
                `/runs/${encodeURIComponent(run.pipeline)}/${encodeURIComponent(run.run_name)}/artifacts` +
                `?created=${encodeURIComponent(run.created)}`;
            const data = await readJson<{ artifacts: Artifact[] }>(
                await fetch(route, { cache: 'no-store' })
            );
            const artifacts = Array.isArray(data.artifacts) ? data.artifacts : [];
            if (!artifacts.length) throw new Error('This run does not contain any downloadable artifacts.');
            const source: ArtifactSource = { type: 'run', run, label };
            this.showArtifacts(artifacts, source);
            if (artifacts.length === 1) {
                await this.openArtifact(artifacts[0], source);
            } else {
                const primary = artifacts.find(artifact => artifact.primary);
                this.view.setState('Choose an artifact',
                    `${artifacts.length} artifacts are available${primary ? ` · ${primary.name} is recommended` : ''}.`,
                    { mode: 'idle' });
                this.view.setBusy(false, this.canStart());
            }
        } catch (error) {
            this.view.setState('Could not load saved artifacts', messageOf(error), { mode: 'failed' });
            this.view.setBusy(false, this.canStart());
        }
    }

    private updateArtifactLocation(artifact: Artifact) {
        const location = this.artifactLocations.get(artifact.name);
        if (!location) return;
        location.classList.toggle('local', Boolean(artifact.local));
        location.classList.toggle('remote', !artifact.local);
        location.textContent = artifact.local ? '✓' : '☁';
        const label = artifact.local ? 'Available in local cache' : 'Stored remotely; download required';
        location.title = label;
        location.setAttribute('aria-label', label);
    }

    private async readDownload(
        response: Response,
        artifact: Artifact,
        signal: AbortSignal,
        report: (title: string, detail: string, visual: ProgressVisual) => void
    ): Promise<Blob> {
        const headerSize = Number(response.headers.get('Content-Length') || 0);
        const total = headerSize > 0 ? headerSize : Math.max(0, Number(artifact.size) || 0);
        const contentType = response.headers.get('Content-Type') || 'application/octet-stream';
        if (!response.body) return response.blob();

        const reader = response.body.getReader();
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        const started = performance.now();
        const samples: { time: number; loaded: number }[] = [{ time: started, loaded: 0 }];
        let loaded = 0;
        let lastRendered = 0;
        const operation = artifact.local ? 'Loading local copy' : 'Downloading';
        report(`${operation}: ${artifact.name}`,
            total > 0 ? `0 B / ${formatBytes(total)} · estimating…` : 'Starting download…',
            total > 0 ? { mode: 'determinate', value: 0 } : { mode: 'indeterminate' });

        try {
            for (;;) {
                if (signal.aborted) throw new DOMException('Download cancelled', 'AbortError');
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(new Uint8Array(value));
                loaded += value.byteLength;
                const now = performance.now();
                samples.push({ time: now, loaded });
                while (samples.length > 2 && now - samples[0].time > 8000) samples.shift();
                if (now - lastRendered < 125) continue;
                lastRendered = now;
                const first = samples[0];
                const elapsed = (now - first.time) / 1000;
                const speed = elapsed >= 0.4 ? (loaded - first.loaded) / elapsed : 0;
                const eta = total > loaded && speed > 0 ? (total - loaded) / speed : 0;
                const transferred = total > 0 ?
                    `${formatBytes(loaded)} / ${formatBytes(total)}` :
                    formatBytes(loaded);
                const speedAndEta = speed > 0 ?
                    ` · ${formatBytes(speed)}/s${total > 0 ? ` · ${formatDuration(eta)}` : ''}` :
                    ' · estimating…';
                report(`${operation}: ${artifact.name}`, transferred + speedAndEta,
                    total > 0 ?
                        { mode: 'determinate', value: (loaded / total) * 100 } :
                        { mode: 'indeterminate' });
            }
        } catch (error) {
            await reader.cancel().catch((): void => {});
            throw error;
        }
        report(`${operation}: ${artifact.name}`,
            `${formatBytes(loaded)} / ${formatBytes(total || loaded)} · complete`,
            { mode: 'done' });
        return new Blob(chunks, { type: contentType });
    }
}

export {
    ArtifactOpenResult,
    ReconstructionArtifacts
};
