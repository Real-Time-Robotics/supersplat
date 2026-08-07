import { Events } from '../events';
import { type CacheScope, artifactCache } from './reconstruction-artifact-cache';
import { ReconstructionDatasets } from './reconstruction-datasets';
import type { ProgressVisual } from './reconstruction-progress';
import { Artifact, ArtifactSource, RecentDataset, RecentRun } from './reconstruction-types';
import { gp } from './reconstruction-upload';
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

const scopeOf = (source: ArtifactSource): CacheScope => (source.type === 'job' ?
    { kind: 'job', jobId: source.jobId } :
    {
        kind: 'run',
        datasetId: source.run.dataset_id,
        pipeline: source.run.pipeline,
        runName: source.run.run_name,
        created: source.run.created
    });

class ReconstructionArtifacts {
    private activeDownload: AbortController | null = null;
    private activeDatasetId: string | null = null;
    private activeScope: CacheScope | null = null;
    private readonly artifactLocations = new Map<string, HTMLElement>();
    private readonly datasets: ReconstructionDatasets;

    constructor(
        private readonly events: Events,
        private readonly view: ReconstructionView,
        private readonly canStart: () => boolean,
        onDatasetDeleted: (datasetId: string) => Promise<void> | void,
        private readonly onDatasetSelected: (dataset: RecentDataset) => Promise<void> | void
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
        view.clearCacheButton.addEventListener('click', () => this.clearCache());
        artifactCache.reconcile().then(() => this.refreshCacheUsage());
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
                info.className = 'recon-dataset-info';
                const name = document.createElement('strong');
                name.textContent = dataset.label || dataset.dataset_id;
                name.title = dataset.label || dataset.dataset_id;
                const datasetDetail = document.createElement('span');
                const created = new Date(dataset.created < 1e12 ? dataset.created * 1000 : dataset.created);
                datasetDetail.textContent =
                    `${dataset.image_count.toLocaleString()} source images · ${formatBytes(dataset.bytes)} · ${created.toLocaleString('en-US')}`;
                info.append(name, datasetDetail);
                const actions = document.createElement('div');
                actions.className = 'recon-dataset-actions';
                const useButton = document.createElement('button');
                useButton.type = 'button';
                useButton.className = 'recon-button recon-primary recon-use-dataset';
                useButton.textContent = 'Use dataset';
                useButton.title = `Use ${dataset.label || dataset.dataset_id} without uploading it again`;
                useButton.addEventListener('click', () => this.onDatasetSelected(dataset));
                const deleteButton = document.createElement('button');
                deleteButton.type = 'button';
                deleteButton.className = 'recon-button recon-delete-dataset';
                deleteButton.textContent = 'Delete';
                deleteButton.title = `Delete dataset ${dataset.label || dataset.dataset_id}`;
                deleteButton.setAttribute(
                    'aria-label',
                    `Delete dataset ${dataset.label || dataset.dataset_id} and all of its data`
                );
                deleteButton.addEventListener(
                    'click',
                    () => this.datasets.requestDelete(dataset, deleteButton)
                );
                actions.append(useButton, deleteButton);
                heading.append(info, actions);
                const models = document.createElement('div');
                models.className = 'recon-dataset-models';
                const total = Object.values(dataset.run_counts || {})
                .reduce((sum, count) => sum + count, 0);
                const expand = document.createElement('button');
                expand.type = 'button';
                expand.className = 'recon-button recon-expand-dataset';
                expand.textContent = total ?
                    `Xem ${total} lần chạy` :
                    'Chưa có lần chạy nào';
                expand.disabled = total === 0;
                expand.addEventListener(
                    'click',
                    () => this.loadDatasetModels(dataset, models, expand)
                );
                models.appendChild(expand);
                card.append(heading, models);
                this.view.recentRuns.appendChild(card);
            }
        } catch (error) {
            this.view.recentRuns.textContent = `Could not load datasets: ${messageOf(error)}`;
        } finally {
            this.view.refreshRunsButton.disabled = false;
        }
    }

    private async loadDatasetModels(
        dataset: RecentDataset,
        container: HTMLElement,
        trigger: HTMLButtonElement
    ) {
        trigger.disabled = true;
        trigger.textContent = 'Đang tải…';
        try {
            const response = await fetch(
                `/api/reconstruction/datasets/${encodeURIComponent(dataset.dataset_id)}/runs`,
                { cache: 'no-store' }
            );
            const data = await readJson<{ runs: RecentRun[] }>(response);
            const models = data.runs
            .filter(run => run.status === 'done' && run.artifact_count > 0 && run.primary)
            .sort((a, b) => b.created - a.created)
            .map(run => ({
                ...run,
                dataset_id: dataset.dataset_id,
                dataset_label: dataset.label || '',
                image_count: dataset.image_count
            }));
            container.textContent = '';
            if (!models.length) {
                const empty = document.createElement('span');
                empty.textContent = data.runs.length ?
                    `${data.runs.length} lần chạy · chưa có mô hình nào hoàn tất` :
                    'Chưa có mô hình nào hoàn tất.';
                container.appendChild(empty);
                return;
            }
            for (const run of models) {
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
                container.appendChild(button);
            }
        } catch (error) {
            trigger.disabled = false;
            trigger.textContent = `Không tải được: ${messageOf(error)}`;
        }
    }

    showArtifacts(artifacts: Artifact[], source: ArtifactSource) {
        this.view.setTab('recent');
        this.activeDatasetId = source.type === 'run' ? source.run.dataset_id : null;
        this.activeScope = scopeOf(source);
        this.view.artifactPanel.hidden = false;
        this.view.artifactTitle.textContent = source.label;
        this.view.artifactList.textContent = '';
        this.artifactLocations.clear();
        for (const artifact of artifacts) {
            artifact.local = artifactCache.has(this.activeScope, artifact.name);
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
            location.addEventListener('click', () => this.evictArtifact(artifact));
            location.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                this.evictArtifact(artifact);
            });
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
            const scope = scopeOf(source);
            let response = await artifactCache.read(scope, artifact.name);
            const cached = response !== null;
            artifact.local = cached;
            this.updateArtifactLocation(artifact);
            if (!response) {
                const url = source.type === 'job' ?
                    await gp.getArtifactUrl(source.jobId, artifact.name,
                        { signal: controller.signal }) :
                    await gp.getRunArtifactUrl(source.run.dataset_id, source.run.pipeline,
                        source.run.run_name, artifact.name, { signal: controller.signal });
                response = await fetch(url, { signal: controller.signal });
                if (!response.ok) throw new Error(`Artifact storage returned ${response.status}`);
            }
            const blob = await this.readDownload(response, artifact, controller.signal, report);
            if (!cached) await artifactCache.write(scope, artifact.name, new Response(blob));
            artifact.local = true;
            this.updateArtifactLocation(artifact);
            await this.refreshCacheUsage();
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
        const label = artifact.local ?
            'Đã có trên máy này · bấm để xoá khỏi bộ nhớ đệm' :
            'Chưa có trên máy này; sẽ tải từ kho lưu trữ';
        location.title = label;
        location.setAttribute('aria-label', label);
        location.setAttribute('role', artifact.local ? 'button' : 'img');
        if (artifact.local) location.tabIndex = 0;
        else location.removeAttribute('tabindex');
    }

    private async evictArtifact(artifact: Artifact) {
        if (!this.activeScope || !artifact.local) return;
        await artifactCache.remove(this.activeScope, artifact.name);
        artifact.local = false;
        this.updateArtifactLocation(artifact);
        await this.refreshCacheUsage();
    }

    async refreshCacheUsage() {
        const { bytes, budget } = await artifactCache.usage();
        const label = this.view.cacheUsageLabel;
        if (!label) return;
        label.textContent = `Bộ nhớ đệm: ${formatBytes(bytes)} / ${formatBytes(budget)}`;
        this.view.clearCacheButton.disabled = bytes === 0;
    }

    async clearCache() {
        await artifactCache.clear();
        for (const location of this.artifactLocations.values()) {
            location.classList.remove('local');
            location.classList.add('remote');
            location.textContent = '☁';
            location.setAttribute('role', 'img');
            location.removeAttribute('tabindex');
            const label = 'Chưa có trên máy này; sẽ tải từ kho lưu trữ';
            location.title = label;
            location.setAttribute('aria-label', label);
        }
        await this.refreshCacheUsage();
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
