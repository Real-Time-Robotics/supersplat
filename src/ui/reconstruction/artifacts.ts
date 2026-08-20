import { type CacheScope, artifactCache } from './artifact-cache';
import { ReconstructionDatasets, confirmDestructive, deleteOrThrow } from './datasets';
import { onSessionEnded, reconFetch } from './http';
import type { ProgressVisual } from './progress';
import { editableName } from './rename';
import type { Artifact, ArtifactSource, RecentDataset, RecentRun } from './types';
import { gp } from './upload';
import { RateMeter, formatTransferDetail } from './upload-rate';
import {
    OPENABLE_ARTIFACT_EXTENSIONS,
    formatBytes,
    messageOf,
    readJson
} from './utils';
import { ReconstructionView } from './view';
import { Events } from '../../events';
import cachedSvg from '../svg/recon-cached.svg';
import remoteSvg from '../svg/recon-remote.svg';
import { createSvg } from '../svg-element';

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

/** Transfer size: what the server declares, else what the listing recorded. */
const totalBytes = (response: Response, artifact: Artifact): number => {
    return Number(response.headers.get('Content-Length')) ||
        Math.max(0, Number(artifact.size) || 0);
};

/** The gateway sends epoch seconds; older rows can carry milliseconds. */
const datasetCreated = (dataset: RecentDataset): Date => new Date(
    dataset.created < 1e12 ? dataset.created * 1000 : dataset.created);

const countOf = (counts: Record<string, number> | undefined): number => Object
.values(counts || {}).reduce((sum, count) => sum + count, 0);

/** What to call a run on screen: the user's name, else where it landed on the store. */
const titleOf = (run: RecentRun): string => run.label || `${run.pipeline}/${run.run_name}`;

class ReconstructionArtifacts {
    private activeDownload: AbortController | null = null;
    private activeDatasetId: string | null = null;
    private activeScope: CacheScope | null = null;
    private sessionGeneration = 0;
    private pickedDatasetId: string | null = null;
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
                    this.closeArtifactPanel();
                }
                await onDatasetDeleted(datasetId);
                await this.refreshRecentRuns();
            }
        );
        for (const button of view.refreshRunsButtons) {
            button.addEventListener('click', () => this.refreshRecentRuns());
        }
        view.clearCacheButton.addEventListener('click', () => this.clearCache());
        view.downloadCancelButton.addEventListener('click', () => this.cancelDownload());
        onSessionEnded(() => this.endSession());
        artifactCache.reconcile().then(() => this.refreshCacheUsage());
    }

    beginSession() {
        this.sessionGeneration++;
    }

    private endSession() {
        this.sessionGeneration++;
        this.cancelDownload();
        this.view.transfer.hide();
        this.activeDatasetId = null;
        this.pickedDatasetId = null;
        this.closeArtifactPanel();
        this.view.recentRuns.textContent = '';
        this.view.datasetTree.textContent = '';
        this.setRefreshDisabled(false);
    }

    private setRefreshDisabled(disabled: boolean) {
        for (const button of this.view.refreshRunsButtons) button.disabled = disabled;
    }

    cancelDownload() {
        this.activeDownload?.abort();
    }

    async refreshRecentRuns() {
        const generation = this.sessionGeneration;
        this.setRefreshDisabled(true);
        try {
            const response = await reconFetch('/api/reconstruction/runs?limit=12', { cache: 'no-store' });
            const data = await readJson<{ datasets: RecentDataset[] }>(response);
            if (generation !== this.sessionGeneration) return;
            // One fetch feeds both tabs: Create picks a dataset, Artifacts walks into it.
            this.renderDatasetPicker(data.datasets);
            this.renderDatasetTree(data.datasets);
        } catch (error) {
            if (generation !== this.sessionGeneration) return;
            const message = `Could not load datasets: ${messageOf(error)}`;
            this.view.recentRuns.textContent = message;
            this.view.datasetTree.textContent = message;
        } finally {
            if (generation === this.sessionGeneration) this.setRefreshDisabled(false);
        }
    }

    /**
     * Create's picker. Named by when the server committed the dataset.
     */
    private renderDatasetPicker(datasets: RecentDataset[]) {
        this.view.recentRuns.textContent = '';
        if (!datasets.length) {
            const empty = document.createElement('span');
            empty.textContent = 'No reconstruction datasets yet.';
            this.view.recentRuns.appendChild(empty);
            return;
        }
        for (const dataset of datasets) {
            const row = document.createElement('div');
            row.className = 'recon-pick';
            row.dataset.datasetId = dataset.dataset_id;
            const name = dataset.label || dataset.dataset_id;

            const info = document.createElement('div');
            info.className = 'recon-pick-info';
            const created = document.createElement('strong');
            created.className = 'recon-pick-created';
            created.append(this.renameableDataset(dataset));
            const detail = document.createElement('span');
            detail.className = 'recon-pick-detail';
            detail.textContent = [
                `${dataset.image_count.toLocaleString()} images`,
                formatBytes(dataset.bytes),
                datasetCreated(dataset).toLocaleString('en-US')
            ].join(' · ');
            info.append(created, detail);

            const actions = document.createElement('div');
            actions.className = 'recon-dataset-actions';
            const useButton = document.createElement('button');
            useButton.type = 'button';
            useButton.className = 'recon-button recon-primary recon-use-dataset';
            useButton.textContent = 'Use dataset';
            useButton.title = `Use ${name} without uploading it again`;
            useButton.addEventListener('click', () => this.onDatasetSelected(dataset));
            const deleteButton = document.createElement('button');
            deleteButton.type = 'button';
            deleteButton.className = 'recon-button recon-delete-dataset';
            deleteButton.textContent = 'Delete';
            deleteButton.title = `Delete dataset ${name}`;
            deleteButton.setAttribute('aria-label',
                `Delete dataset ${name} and all of its data`);
            deleteButton.addEventListener('click',
                () => this.datasets.requestDelete(dataset, deleteButton));
            actions.append(useButton, deleteButton);

            row.append(info, actions);
            this.paintPick(row, dataset.dataset_id === this.pickedDatasetId);
            this.view.recentRuns.appendChild(row);
        }
    }

    private renameableDataset(dataset: RecentDataset): HTMLElement {
        return editableName(dataset.label, { kind: 'dataset', datasetId: dataset.dataset_id }, {
            placeholder: dataset.dataset_id,
            onRenamed: (label) => {
                dataset.label = label;
            },
            onError: message => this.view.progress.showNotice(
                `Không đổi được tên bộ ảnh: ${message}`, 8000)
        });
    }

    /**
     * Marks the dataset a run would reuse.
     */
    setPickedDataset(datasetId: string | null) {
        this.pickedDatasetId = datasetId;
        for (const child of this.view.recentRuns.children) {
            const row = child as HTMLElement;
            if (row.dataset.datasetId) {
                this.paintPick(row, row.dataset.datasetId === datasetId);
            }
        }
    }

    private paintPick(row: HTMLElement, picked: boolean) {
        row.classList.toggle('active', picked);
        row.setAttribute('aria-current', String(picked));
    }

    /** Artifacts' tree: a row per dataset, expanding to the jobs it produced. */
    private renderDatasetTree(datasets: RecentDataset[]) {
        this.view.datasetTree.textContent = '';
        if (!datasets.length) {
            const empty = document.createElement('span');
            empty.textContent = 'No reconstruction datasets yet.';
            this.view.datasetTree.appendChild(empty);
            return;
        }
        for (const dataset of datasets) {
            const card = document.createElement('section');
            card.className = 'recon-dataset';
            const heading = document.createElement('div');
            heading.className = 'recon-dataset-heading';
            const info = document.createElement('div');
            info.className = 'recon-dataset-info';
            const name = document.createElement('strong');
            name.append(this.renameableDataset(dataset));
            const detail = document.createElement('span');
            const runs = countOf(dataset.run_counts);
            detail.textContent = [
                `${dataset.image_count.toLocaleString()} source images`,
                formatBytes(dataset.bytes),
                datasetCreated(dataset).toLocaleString('en-US'),
                `${runs} job${runs === 1 ? '' : 's'}`
            ].join(' · ');
            info.append(name, detail);

            const jobs = document.createElement('div');
            jobs.className = 'recon-dataset-models';
            const expand = document.createElement('button');
            expand.type = 'button';
            expand.className = 'recon-button recon-expand-dataset';
            // Counted from run_counts, not model_counts: a failed or running job is still a
            // job the user started and wants to see, even with nothing openable yet.
            expand.textContent = runs ?
                `Xem ${runs} job` :
                'Chưa có job nào';
            expand.disabled = runs === 0;
            expand.addEventListener('click', () => this.loadDatasetJobs(dataset, jobs, expand));
            jobs.appendChild(expand);

            heading.append(info);
            card.append(heading, jobs);
            this.view.datasetTree.appendChild(card);
        }
    }

    private async loadDatasetJobs(
        dataset: RecentDataset,
        container: HTMLElement,
        trigger: HTMLButtonElement
    ) {
        const generation = this.sessionGeneration;
        trigger.disabled = true;
        trigger.textContent = 'Đang tải…';
        try {
            const response = await reconFetch(
                `/api/reconstruction/datasets/${encodeURIComponent(dataset.dataset_id)}/runs`,
                { cache: 'no-store' }
            );
            const data = await readJson<{ runs: RecentRun[] }>(response);
            if (generation !== this.sessionGeneration) return;
            const jobs = data.runs
            .sort((a, b) => b.created - a.created)
            .map(run => ({
                ...run,
                dataset_id: dataset.dataset_id,
                dataset_label: dataset.label || '',
                image_count: dataset.image_count
            }));
            container.textContent = '';
            if (!jobs.length) {
                const empty = document.createElement('span');
                empty.textContent = 'Dataset này chưa có job nào.';
                container.appendChild(empty);
                return;
            }
            for (const run of jobs) container.appendChild(this.jobRow(run));
        } catch (error) {
            if (generation !== this.sessionGeneration) return;
            trigger.disabled = false;
            trigger.textContent = `Không tải được: ${messageOf(error)}`;
        }
    }

    private jobRow(run: RecentRun): HTMLElement {
        const row = document.createElement('div');
        row.className = 'recon-job-row';

        const openable = run.artifact_count > 0;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'recon-button recon-run';
        button.disabled = !openable;
        const top = document.createElement('span');
        top.className = 'recon-run-top';
        const runName = document.createElement('strong');
        runName.textContent = titleOf(run);
        runName.title = `${run.pipeline}/${run.run_name}`;
        const state = document.createElement('span');
        state.className = 'recon-run-state';
        state.dataset.state = run.status;
        state.textContent = run.status;
        top.append(runName, state);
        const detail = document.createElement('span');
        detail.textContent = [
            new Date(run.created < 1e12 ? run.created * 1000 : run.created)
            .toLocaleString('en-US'),
            `${run.artifact_count} artifact${run.artifact_count === 1 ? '' : 's'}`,
            formatBytes(run.bytes)
        ].join(' · ');
        button.append(top, detail);
        if (openable) {
            button.addEventListener('click', () => this.loadRecentRunArtifacts(run));
        }

        const actions = document.createElement('div');
        actions.className = 'recon-job-actions';
        // A run whose job row is already gone can still be opened and deleted; only the
        // rename needs the job that wrote it, so that is the one affordance it loses.
        if (run.job_id) {
            const rename = editableName(run.label, { kind: 'job', jobId: run.job_id }, {
                placeholder: `${run.pipeline}/${run.run_name}`,
                onRenamed: (label) => {
                    run.label = label;
                    runName.textContent = titleOf(run);
                },
                onError: message => this.view.progress.showNotice(
                    `Không đổi được tên luồng: ${message}`, 8000)
            });
            rename.classList.add('recon-job-rename');
            actions.append(rename);
        }
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'recon-button recon-job-delete';
        remove.textContent = '✕';
        remove.title = 'Xoá luồng này: artifact và log của nó';
        remove.setAttribute('aria-label', remove.title);
        remove.addEventListener('click', () => this.requestRunDelete(run));
        actions.append(remove);

        row.append(button, actions);
        return row;
    }

    /** Delete a run: its artifacts, and the jobs and logs that made them. */
    private async requestRunDelete(run: RecentRun) {
        const name = titleOf(run);
        const confirmed = await confirmDestructive(this.events, {
            header: 'Xoá luồng này?',
            message: `Xoá “${name}” cùng toàn bộ artifact và log của nó?`,
            warning: {
                text: `${run.artifact_count} tệp (${formatBytes(run.bytes)}) sẽ bị xoá vĩnh viễn. Ảnh gốc của bộ ảnh vẫn được giữ.`
            }
        });
        if (!confirmed) return;

        try {
            await deleteOrThrow(
                `/api/reconstruction/datasets/${encodeURIComponent(run.dataset_id)}` +
                `/runs/${encodeURIComponent(run.pipeline)}/${encodeURIComponent(run.run_name)}`,
                'Luồng này đang chạy. Huỷ nó trước khi xoá.');
            this.forgetRun(run);
            this.view.progress.showNotice(`Đã xoá “${name}”.`, 6000);
            await this.refreshRecentRuns();
        } catch (error) {
            this.view.progress.showNotice(`Không xoá được: ${messageOf(error)}`, 8000);
        }
    }

    /** Drop what is on screen (and cached) for a run that no longer exists. */
    private forgetRun(run: RecentRun) {
        artifactCache.removeScope(scopeOf({ type: 'run', run, label: '' }))
        .then(() => this.refreshCacheUsage())
        .catch((): void => undefined);
        if (this.activeScope?.kind === 'run' &&
            this.activeScope.runName === run.run_name &&
            this.activeScope.pipeline === run.pipeline &&
            this.activeScope.datasetId === run.dataset_id) this.closeArtifactPanel();
    }

    /** Empty the artifact pane, for when what it was showing is gone. */
    private closeArtifactPanel() {
        this.activeScope = null;
        this.view.artifactPanel.hidden = true;
        this.view.artifactList.textContent = '';
        this.artifactLocations.clear();
    }

    showArtifacts(artifacts: Artifact[], source: ArtifactSource) {
        this.view.setTab('artifacts');
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
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'recon-button recon-artifact-delete';
            remove.textContent = '✕';
            remove.title = `Xoá ${artifact.name} khỏi kho lưu trữ`;
            remove.setAttribute('aria-label', remove.title);
            remove.addEventListener('click',
                () => this.requestArtifactDelete(artifact, source, row, remove));
            this.artifactLocations.set(artifact.name, location);
            this.updateArtifactLocation(artifact);
            row.append(info, action, location, remove);
            this.view.artifactList.appendChild(row);
        }
    }

    /** Delete one file of a run, leaving the rest of it alone. */
    private async requestArtifactDelete(artifact: Artifact, source: ArtifactSource,
        row: HTMLElement, trigger: HTMLButtonElement) {
        const confirmed = await confirmDestructive(this.events, {
            header: 'Xoá tệp này?',
            message: `Xoá “${artifact.name}” (${formatBytes(artifact.size)}) khỏi kho lưu trữ?`,
            warning: artifact.primary ?
                { text: 'Đây là tệp chính của luồng; xoá xong luồng sẽ không mở được nữa.' } :
                undefined
        });
        if (!confirmed) return;

        const route = source.type === 'job' ?
            `/api/reconstruction/jobs/${encodeURIComponent(source.jobId)}` +
                `/artifacts/${encodeURIComponent(artifact.name)}` :
            `/api/reconstruction/datasets/${encodeURIComponent(source.run.dataset_id)}` +
                `/runs/${encodeURIComponent(source.run.pipeline)}` +
                `/${encodeURIComponent(source.run.run_name)}` +
                `/artifacts/${encodeURIComponent(artifact.name)}`;
        trigger.disabled = true;
        try {
            await deleteOrThrow(route, 'Luồng này đang chạy. Huỷ nó trước khi xoá tệp.');
            // scopeOf(source), not activeScope: the panel can have moved on while the
            // confirm was open, and the eviction has to follow the file that was deleted.
            await artifactCache.remove(scopeOf(source), artifact.name);
            this.artifactLocations.delete(artifact.name);
            row.remove();
            await this.refreshCacheUsage();
            this.view.progress.showNotice(`Đã xoá ${artifact.name}.`, 6000);
        } catch (error) {
            trigger.disabled = false;
            this.view.progress.showNotice(`Không xoá được: ${messageOf(error)}`, 8000);
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
            ((title: string, detail: string, visual: ProgressVisual) => {
                this.view.setTransferState(title, detail, visual);
            });
        if (manageView) {
            this.view.setBusy(true, this.canStart());
            this.view.downloadCancelButton.hidden = false;
        }
        const filename = artifact.name.split('/').pop() || 'genesis-artifact';
        try {
            const scope = scopeOf(source);
            let blob = await artifactCache.read(scope, artifact.name);
            artifact.local = blob !== null;
            this.updateArtifactLocation(artifact);
            if (!blob) {
                const url = source.type === 'job' ?
                    await gp.getArtifactUrl(source.jobId, artifact.name,
                        { signal: controller.signal }) :
                    await gp.getRunArtifactUrl(source.run.dataset_id, source.run.pipeline,
                        source.run.run_name, artifact.name, { signal: controller.signal });
                const fetched = await this.fetchArtifact(url, scope, artifact,
                    controller.signal, report);
                blob = fetched.blob;
                artifact.local = fetched.cached;
                this.updateArtifactLocation(artifact);
                await this.refreshCacheUsage();
            }
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
            // Cache.put reports an aborted body as a NetworkError, not an AbortError
            const cancelled = controller.signal.aborted ||
                (error as DOMException)?.name === 'AbortError';
            if (this.activeDownload === controller) {
                if (cancelled) {
                    report('Download cancelled', filename, { mode: 'idle' });
                } else {
                    report('Could not download artifact', messageOf(error), { mode: 'failed' });
                }
            }
            return cancelled ?
                { status: 'cancelled' } :
                { status: 'failed', message: messageOf(error) };
        } finally {
            if (this.activeDownload === controller) {
                this.activeDownload = null;
                if (manageView) {
                    this.view.downloadCancelButton.hidden = true;
                    this.view.setBusy(false, this.canStart());
                }
            }
        }
    }

    private async loadRecentRunArtifacts(run: RecentRun) {
        this.view.setBusy(true, this.canStart());
        const label = `${run.dataset_label || run.dataset_id} · ${run.pipeline}/${run.run_name}`;
        this.view.setTransferState('Loading artifact list', label, { mode: 'indeterminate' });
        try {
            const route = `/api/reconstruction/datasets/${encodeURIComponent(run.dataset_id)}` +
                `/runs/${encodeURIComponent(run.pipeline)}/${encodeURIComponent(run.run_name)}/artifacts` +
                `?created=${encodeURIComponent(run.created)}`;
            const data = await readJson<{ artifacts: Artifact[] }>(
                await reconFetch(route, { cache: 'no-store' })
            );
            const artifacts = Array.isArray(data.artifacts) ? data.artifacts : [];
            if (!artifacts.length) throw new Error('This run does not contain any downloadable artifacts.');
            const source: ArtifactSource = { type: 'run', run, label };
            this.showArtifacts(artifacts, source);
            if (artifacts.length === 1) {
                await this.openArtifact(artifacts[0], source);
            } else {
                const primary = artifacts.find(artifact => artifact.primary);
                this.view.setTransferState('Choose an artifact',
                    `${artifacts.length} artifacts are available${primary ? ` · ${primary.name} is recommended` : ''}.`,
                    { mode: 'idle' });
                this.view.setBusy(false, this.canStart());
            }
        } catch (error) {
            this.view.setTransferState('Could not load saved artifacts', messageOf(error),
                { mode: 'failed' });
            this.view.setBusy(false, this.canStart());
        }
    }

    private updateArtifactLocation(artifact: Artifact) {
        const location = this.artifactLocations.get(artifact.name);
        if (location) this.paintArtifactLocation(location, Boolean(artifact.local));
    }

    private paintArtifactLocation(location: HTMLElement, local: boolean) {
        location.classList.toggle('local', local);
        location.classList.toggle('remote', !local);
        // Drawn, not typed: neither ✓ nor ☁ exists in Arial, so both fell back to a font
        // with different metrics — and ☁ renders as colour emoji on some platforms.
        location.replaceChildren(createSvg(local ? cachedSvg : remoteSvg));
        const label = local ?
            'Đã có trên máy này · bấm để xoá khỏi bộ nhớ đệm' :
            'Chưa có trên máy này; sẽ tải từ kho lưu trữ';
        location.title = label;
        location.setAttribute('aria-label', label);
        location.setAttribute('role', local ? 'button' : 'img');
        if (local) location.tabIndex = 0;
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
            this.paintArtifactLocation(location, false);
        }
        await this.refreshCacheUsage();
    }

    private async fetchArtifact(
        url: string,
        scope: CacheScope,
        artifact: Artifact,
        signal: AbortSignal,
        report: (title: string, detail: string, visual: ProgressVisual) => void
    ): Promise<{ blob: Blob; cached: boolean }> {
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error(`Artifact storage returned ${response.status}`);
        const total = totalBytes(response, artifact);
        const meter = this.progressMeter(artifact, total, report);

        let cached: Blob | null;
        try {
            cached = await artifactCache.store(scope, artifact.name, response, total,
                bytes => meter.tick(bytes));
        } catch (error) {
            if (signal.aborted) throw error;
            meter.restart('Không lưu được vào bộ nhớ đệm (đĩa hoặc bộ nhớ trình duyệt đầy) · đang tải lại, không lưu đệm');
            const retry = await fetch(url, { signal });
            if (!retry.ok) throw new Error(`Artifact storage returned ${retry.status}`);
            return { blob: await this.readDownload(retry, signal, meter), cached: false };
        }
        if (cached) {
            meter.done();
            return { blob: cached, cached: true };
        }
        return { blob: await this.readDownload(response, signal, meter), cached: false };
    }

    /**
     * Throttled transfer progress, shared by both read paths so they report alike.
     */
    private progressMeter(
        artifact: Artifact,
        total: number,
        report: (title: string, detail: string, visual: ProgressVisual) => void
    ) {
        const title = `Downloading: ${artifact.name}`;
        let rates = new RateMeter();
        let loaded = 0;
        let lastRendered = 0;
        report(title,
            total > 0 ? `0 B / ${formatBytes(total)} · estimating…` : 'Starting download…',
            total > 0 ? { mode: 'determinate', value: 0 } : { mode: 'indeterminate' });

        return {
            /** A second attempt moves the same bytes again, so the count starts over. */
            restart(note: string) {
                rates = new RateMeter();
                loaded = 0;
                lastRendered = 0;
                report(title, note,
                    total > 0 ? { mode: 'determinate', value: 0 } : { mode: 'indeterminate' });
            },
            tick(bytes: number) {
                loaded += bytes;
                const now = performance.now();
                if (now - lastRendered < 125) return;
                lastRendered = now;
                report(title, formatTransferDetail(rates.sample(loaded, total)),
                    total > 0 ?
                        { mode: 'determinate', value: (loaded / total) * 100 } :
                        { mode: 'indeterminate' });
            },
            done() {
                report(title, `${formatBytes(loaded)} / ${formatBytes(total || loaded)} · complete`,
                    { mode: 'done' });
            }
        };
    }

    private async readDownload(
        response: Response,
        signal: AbortSignal,
        meter: { tick: (bytes: number) => void; done: () => void }
    ): Promise<Blob> {
        const contentType = response.headers.get('Content-Type') || 'application/octet-stream';
        if (!response.body) return response.blob();

        const reader = response.body.getReader();
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        try {
            for (;;) {
                if (signal.aborted) throw new DOMException('Download cancelled', 'AbortError');
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(new Uint8Array(value));
                meter.tick(value.byteLength);
            }
        } catch (error) {
            await reader.cancel().catch((): void => {});
            throw error;
        }
        meter.done();
        return new Blob(chunks, { type: contentType });
    }
}

export { ReconstructionArtifacts };
export type { ArtifactOpenResult };
