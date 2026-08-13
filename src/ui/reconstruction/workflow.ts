import { ReconstructionArtifacts } from './artifacts';
import { ReconstructionBilling } from './billing';
import { estimateTotalPixels, shortfallNote } from './estimate';
import { onSessionEnded, reconFetch } from './http';
import { ReconstructionJob, ReconstructionJobError } from './job';
import { folderFingerprint, normalizeObjectName } from './names';
import type { ProgressVisual } from './progress';
import { runCard, type Run, type RunAction } from './run';
import { RunCoordinator } from './run-coordinator';
import { RunStore } from './run-store';
import type {
    Artifact,
    ArtifactSource,
    JobStatus,
    RecentDataset,
    ReconstructionPipeline,
    UploadResponse
} from './types';
import { ReconstructionUpload, UploadPaused, type Named } from './upload';
import type { TransferRate } from './upload-rate';
import type { UploadRecord } from './upload-records';
import {
    IMAGE_EXTENSIONS,
    PIPELINE_KEY,
    PREPARED_DATASET_KEY,
    messageOf,
    readJson
} from './utils';
import { ReconstructionView } from './view';
import { Events } from '../../events';

type PickedFolder = { named: Named[]; fingerprint: string; record: UploadRecord | null };

// Matches the four boxes one user can rent at once on the control plane.
const MAX_CONCURRENT_UPLOADS = 4;

class ReconstructionWorkflow {
    private files: File[] = [];
    private named: { name: string; data: File }[] = [];
    private fingerprint = '';
    private preparedDataset: (Pick<UploadResponse, 'datasetId' | 'quote'> & {
        pipeline: ReconstructionPipeline;
    }) | null = null;
    private pipeline: ReconstructionPipeline = 'splat';
    private pendingResume: UploadRecord | null = null;
    private watchGeneration = 0;
    private sessionGeneration = 0;
    /** Runs whose start is in flight; guards a double Start on one run, not concurrency. */
    private readonly submitting = new Set<string>();
    /** Runs a cancel was accepted for, so a later error reads as cancelled not failed. */
    private readonly cancelling = new Set<string>();
    private readonly picked = new Map<string, PickedFolder>();
    private readonly discarding = new Set<string>();
    private readonly upload: ReconstructionUpload;
    private readonly job: ReconstructionJob;
    private readonly runs = new RunStore();
    private readonly coordinator: RunCoordinator;

    constructor(
        private readonly events: Events,
        private readonly view: ReconstructionView,
        private readonly billing: ReconstructionBilling,
        private readonly artifacts: ReconstructionArtifacts
    ) {
        this.upload = new ReconstructionUpload();
        this.job = new ReconstructionJob(view, billing, artifacts);
        this.coordinator = new RunCoordinator(this.runs, {
            submit: run => this.submitRun(run),
            fetchJob: jobId => this.readJob(jobId)
        });
        onSessionEnded(() => this.endSession());

        const savedPipeline = localStorage.getItem(PIPELINE_KEY);
        if (savedPipeline === 'photogrammetry') this.pipeline = savedPipeline;
        this.view.setPipeline(this.pipeline);
        for (const button of view.pipelineButtons) {
            button.addEventListener('click', () => {
                const pipeline = button.dataset.pipeline;
                if (pipeline === 'splat' || pipeline === 'photogrammetry') {
                    this.selectPipeline(pipeline).catch((error) => {
                        this.view.setState('Could not change pipeline', messageOf(error), { mode: 'failed' });
                    });
                }
            });
        }

        const pick = (list: FileList | null) => {
            this.selectFiles(list).catch((error) => {
                this.view.setState('Không đọc được thư mục', messageOf(error), { mode: 'failed' });
            });
        };
        view.folderInput.addEventListener('change', () => pick(view.folderInput.files));
        view.imageInput.addEventListener('change', () => pick(view.imageInput.files));
        view.startButton.addEventListener('click', () => this.reconstruct());
        view.newRunButton.addEventListener('click', () => this.newRun());
        this.runs.onChange(() => this.renderRuns());

        ['dragenter', 'dragover'].forEach(name => view.dropzone.addEventListener(name, (event) => {
            event.preventDefault();
            event.stopPropagation();
            view.dropzone.classList.add('dragging');
        }));
        ['dragleave', 'drop'].forEach(name => view.dropzone.addEventListener(name, () => {
            view.dropzone.classList.remove('dragging');
        }));
        view.dropzone.addEventListener('drop', (event) => {
            event.preventDefault();
            event.stopPropagation();
            pick(event.dataTransfer?.files ?? null);
        });
        view.dropzone.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') view.imageInput.click();
        });

        this.restorePreparedDataset();
    }

    get canStart() {
        return this.files.length > 0 || Boolean(this.preparedDataset);
    }

    handleDatasetDeleted(datasetId: string) {
        if (this.preparedDataset?.datasetId !== datasetId) return;
        this.clearPreparedDataset();
        if (this.files.length === 0) {
            this.view.fileSummary.textContent = 'No images selected';
            this.view.startButton.disabled = true;
        }
    }

    async useExistingDataset(dataset: RecentDataset) {
        const datasetLabel = dataset.label || dataset.dataset_id;
        this.files = [];
        this.named = [];
        this.fingerprint = '';
        this.pendingResume = null;
        this.view.folderInput.value = '';
        this.view.imageInput.value = '';
        this.clearPreparedDataset();
        this.view.setTab('create');
        this.view.resetStartLabel();
        this.view.checkoutLink.hidden = true;
        this.view.fileSummary.textContent =
            `${datasetLabel} · ${dataset.image_count.toLocaleString()} existing images`;
        this.view.setState(
            'Checking existing dataset',
            `Quoting ${this.pipelineName} without uploading the images again.`,
            { mode: 'indeterminate' }
        );
        this.setBusy(true);

        try {
            const response = await reconFetch(
                `/api/reconstruction/datasets/${encodeURIComponent(dataset.dataset_id)}/quote` +
                `?pipeline=${encodeURIComponent(this.pipeline)}`,
                { cache: 'no-store' }
            );
            if (response.status === 404) {
                throw new Error('This dataset is no longer available on R2. Choose another dataset or upload images.');
            }
            const quote = await readJson<UploadResponse['quote']>(response);
            this.preparedDataset = {
                datasetId: dataset.dataset_id,
                pipeline: this.pipeline,
                quote
            };
            this.applyPreparedQuote(quote);
            this.view.fileSummary.textContent =
                `${datasetLabel} · ${dataset.image_count.toLocaleString()} existing images · ready to reuse`;
        } catch (error) {
            this.clearPreparedDataset();
            this.view.fileSummary.textContent = 'No images selected';
            this.view.setState('Could not use dataset', messageOf(error), { mode: 'failed' });
        } finally {
            this.setBusy(false);
        }
    }

    beginSession() {
        this.sessionGeneration++;
        this.coordinator.beginSession(this.billing.concurrentCap);
    }

    private endSession() {
        this.sessionGeneration++;
        this.watchGeneration++;
        this.coordinator.stop();
        this.upload.pauseAll();
        this.job.detach();
        this.artifacts.cancelDownload();
        this.billing.endSession();
        this.runs.clear();
        this.picked.clear();
        this.discarding.clear();
        this.clearPreparedDataset();
        this.releaseComposeFolder();
        this.cancelling.clear();
        this.submitting.clear();
        this.view.checkoutLink.hidden = true;
    }

    async restoreOpenSessions() {
        const generation = this.sessionGeneration;
        const records = await this.upload.openSessions().catch(() => [] as UploadRecord[]);
        if (generation !== this.sessionGeneration) return;
        const known = new Set(this.runs.list().map(run => run.datasetId).filter(Boolean));
        const held = new Set(Array.from(this.picked.values()).map(folder => folder.fingerprint));
        for (const record of records) {
            if (known.has(record.datasetId) || held.has(record.fingerprint)) continue;
            const detail = 'Chọn lại thư mục để tiếp tục';
            const run = this.runs.upsert({
                id: crypto.randomUUID(),
                state: 'paused',
                datasetId: record.datasetId,
                pipeline: record.pipeline,
                preset: record.preset,
                runName: record.preset,
                submitKey: null,
                label: record.label,
                jobId: null,
                percent: 0,
                detail
            });
            this.coordinator.transition(run.id, 'paused', { detail });
        }
    }

    async refreshPreparedQuote(): Promise<UploadResponse | null> {
        if (!this.preparedDataset) return null;
        this.preparedDataset.pipeline = this.pipeline;
        try {
            const response = await reconFetch(
                `/api/reconstruction/datasets/${encodeURIComponent(this.preparedDataset.datasetId)}/quote` +
                `?pipeline=${encodeURIComponent(this.pipeline)}`,
                { cache: 'no-store' }
            );
            if (response.status === 404) {
                this.clearPreparedDataset();
                throw new Error('The selected dataset is no longer available on R2. Choose another dataset or upload images.');
            }
            const quote = await readJson<UploadResponse['quote']>(response);
            return this.applyPreparedQuote(quote);
        } catch (error) {
            throw new Error(`Could not recheck the uploaded dataset: ${messageOf(error)}`);
        }
    }

    private card(run: Run, title: string, detail: string, visual: ProgressVisual) {
        if (this.runs.selected()?.id === run.id) this.view.setState(title, detail, visual);
    }

    private composerCard(title: string, detail: string, visual: ProgressVisual) {
        if (this.runs.selected() === null) this.view.setState(title, detail, visual);
    }

    private settleCancelled(error: unknown, run: Run): boolean {
        const code = error instanceof ReconstructionJobError ? error.code : '';
        if (code !== 'cancelled_by_user' && !this.cancelling.has(run.id)) return false;
        this.cancelling.delete(run.id);
        this.coordinator.settle(run.id, 'cancelled', { percent: 0, detail: '' });
        this.card(run, 'Đã huỷ luồng',
            'Máy chủ xác nhận job đã dừng. Ảnh đã tải lên vẫn còn trong kho lưu trữ.',
            { mode: 'idle', center: 'Huỷ' });
        return true;
    }

    async cancelJob() {
        const target = this.runs.selected();
        this.view.cancelButton.disabled = true;
        this.view.resetStartLabel();
        this.view.checkoutLink.hidden = true;
        try {
            const accepted = await this.job.cancel();
            if (!accepted) {
                if (target) this.cancelling.delete(target.id);
                return;
            }
            if (target) this.cancelling.add(target.id);
            this.billing.cancelPolling();
            this.view.cancelButton.hidden = true;
        } catch (error) {
            if (target) this.cancelling.delete(target.id);
            this.view.cancelButton.disabled = false;
            this.view.progress.showNotice(`Could not cancel: ${messageOf(error)}`, 8000);
        }
    }

    private restorePreparedDataset() {
        try {
            const value = JSON.parse(localStorage.getItem(PREPARED_DATASET_KEY) || 'null');
            if (!value?.datasetId || !value?.quote) return;
            this.preparedDataset = {
                datasetId: value.datasetId,
                quote: value.quote,
                pipeline: this.pipeline
            };
            this.view.fileSummary.textContent = `Dataset ${value.datasetId} is already uploaded · ready to reuse`;
            this.view.startButton.disabled = false;
        } catch {
            localStorage.removeItem(PREPARED_DATASET_KEY);
        }
    }

    private persistPreparedDataset() {
        if (this.preparedDataset) {
            localStorage.setItem(PREPARED_DATASET_KEY, JSON.stringify(this.preparedDataset));
        } else {
            localStorage.removeItem(PREPARED_DATASET_KEY);
        }
    }

    private clearPreparedDataset() {
        this.preparedDataset = null;
        this.persistPreparedDataset();
    }

    private applyPreparedQuote(quote: UploadResponse['quote']): UploadResponse {
        if (!this.preparedDataset) throw new Error('No dataset is selected.');
        this.preparedDataset.quote = quote;
        this.persistPreparedDataset();
        this.billing.setBalance(quote.balance);
        const creditsNeeded = Math.max(0, Math.ceil(quote.required - quote.balance));
        if (creditsNeeded === 0) {
            this.view.setState('Credits available',
                `The dataset is already uploaded. Press ${this.actionLabel} to start the ${quote.required.toLocaleString()}-credit job.`,
                { mode: 'done', center: 'Ready' });
        } else {
            this.view.setState('Insufficient credits',
                `The dataset is already on R2; ${creditsNeeded.toLocaleString()} more credits are needed. Buy credits and press Start again; the images will not be uploaded twice.`,
                { mode: 'idle', center: 'Credit' });
        }
        return {
            state: creditsNeeded === 0 ? 'ready' : 'checkout_required',
            datasetId: this.preparedDataset.datasetId,
            quote,
            creditsNeeded
        };
    }

    private get actionLabel() {
        return this.pipeline === 'splat' ? 'Create Gaussian Splat' : 'Create textured mesh';
    }

    private get pipelineName() {
        return this.pipeline === 'splat' ? 'Gaussian Splatting' : 'Photogrammetry';
    }

    private async selectPipeline(pipeline: ReconstructionPipeline) {
        if (pipeline === this.pipeline) return;
        this.pipeline = pipeline;
        localStorage.setItem(PIPELINE_KEY, pipeline);
        this.view.setPipeline(pipeline);
        this.view.resetStartLabel();

        if (this.preparedDataset) {
            this.view.setBusy(true, false);
            this.view.setState(
                'Updating quote',
                `Checking the uploaded dataset for ${pipeline === 'splat' ? 'Gaussian Splatting' : 'Photogrammetry'}.`,
                { mode: 'indeterminate' }
            );
            try {
                await this.refreshPreparedQuote();
            } catch (error) {
                this.view.setState('Could not update quote', messageOf(error), { mode: 'failed' });
            } finally {
                this.setBusy(false);
            }
            return;
        }

        if (this.files.length > 0) {
            this.view.setState(
                'Ready to upload',
                `${this.files.length.toLocaleString()} selected images will be processed with ${pipeline === 'splat' ? 'Gaussian Splatting' : 'Photogrammetry'}.`,
                { mode: 'idle' }
            );
            this.warnIfShort(this.files);   // the two pipelines do not cost the same
        }
    }

    private async selectFiles(list: FileList | null) {
        const candidates = Array.from(list ?? []).filter(file => IMAGE_EXTENSIONS.test(file.name));
        this.view.setTab('create');
        this.view.resetStartLabel();
        this.files = candidates;
        this.pendingResume = null;
        this.named = candidates.map((file, index) => ({
            name: normalizeObjectName(
                (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
                index),
            data: file
        }));
        this.fingerprint = folderFingerprint(
            this.named.map(f => ({ name: f.name, size: f.data.size })));
        this.clearPreparedDataset();

        const bytes = candidates.reduce((sum, file) => sum + file.size, 0);
        const size = bytes >= 1024 ** 3 ?
            `${(bytes / 1024 ** 3).toFixed(2)} GB` :
            `${(bytes / 1024 ** 2).toFixed(1)} MB`;
        this.view.fileSummary.textContent = candidates.length ?
            `${candidates.length.toLocaleString()} images · ${size}` :
            'No supported images found';
        this.view.startButton.disabled = candidates.length === 0;
        this.view.setState(
            'Ready to upload',
            candidates.length < 20 ?
                'A small image set may produce an unstable model; use at least 20 well-overlapping photos.' :
                `It will upload, quote the ${this.pipeline === 'splat' ? 'Gaussian Splatting' : 'Photogrammetry'} cost, then start automatically once the balance is sufficient.`,
            { mode: 'idle' });

        const open = await this.upload.openSessions().catch(() => [] as UploadRecord[]);
        if (this.files !== candidates) return;   // a newer pick landed while we waited
        const resume = open.find(record => record.fingerprint === this.fingerprint) ?? null;
        this.pendingResume = resume;
        if (!resume) {
            this.warnIfShort(candidates);
            return;
        }
        this.view.fileSummary.textContent =
            `${candidates.length.toLocaleString()} ảnh · phiên tải lên ${resume.datasetId} đang dở`;
        this.view.setState('Có thể tiếp tục',
            'Thư mục này đã có phiên tải lên chưa hoàn tất. Nhấn Bắt đầu để tiếp tục — ảnh đã lên sẽ không gửi lại.',
            { mode: 'idle' });
        const waiting = this.runs.list().find(run => run.datasetId === resume.datasetId);
        if (waiting) {
            this.picked.set(waiting.id, {
                named: this.named, fingerprint: this.fingerprint, record: resume
            });
            this.runs.update(waiting.id, { detail: 'Sẵn sàng tải tiếp' });
            this.renderRuns();   // `picked` is the view's source for resume vs re-pick
        }
    }

    private setBusy(busy: boolean) {
        this.view.setBusy(busy, this.canStart);
    }

    private async warnIfShort(files: File[]) {
        if (this.runs.selected() !== null) return;   // a re-pick belongs to its run
        try {
            const pixels = await estimateTotalPixels(files);
            if (this.files !== files) return;        // a newer pick landed while we decoded
            const response = await reconFetch('/api/reconstruction/estimate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    nImages: files.length,
                    totalPixels: pixels ?? undefined,
                    pipeline: this.pipeline
                })
            });
            const body = await readJson<{ required: number; balance: number }>(response);
            if (this.files !== files) return;
            this.billing.setBalance(body.balance);
            const note = shortfallNote(body.required, body.balance, pixels !== null);
            if (note) this.composerCard('Có thể thiếu credit', note, { mode: 'idle', center: 'Credit' });
        } catch {
        }
    }

    private releaseComposeFolder() {
        this.files = [];
        this.named = [];
        this.fingerprint = '';
        this.pendingResume = null;
        this.view.folderInput.value = '';
        this.view.imageInput.value = '';
        this.view.fileSummary.textContent = 'No images selected';
        this.view.startButton.disabled = !this.canStart;
    }

    private renderRuns() {
        const runs = this.runs.list();
        const live = new Set(runs.map(run => run.id));
        for (const id of this.picked.keys()) if (!live.has(id)) this.picked.delete(id);
        this.view.renderRuns(runs, this.runs.selected()?.id ?? null, this.coordinator.slotCap(), {
            onSelect: id => this.selectRun(id),
            onAction: (id, action) => {
                this.runAction(id, action).catch((error) => {
                    this.view.progress.showNotice(messageOf(error), 8000);
                });
            },
            hasFolder: id => this.picked.has(id)
        });
        this.view.showCompose(this.runs.selected());
        this.coordinator.sync();
    }

    private selectRun(id: string) {
        this.runs.select(id);
        this.showSelected();
    }

    private showSelected() {
        const run = this.runs.selected();
        this.view.showCompose(run);
        if (!run) {
            this.job.detach();
            this.view.setState('Ready',
                'Chọn một bộ ảnh chụp quanh vật thể hoặc không gian.', { mode: 'idle' });
            return;
        }
        if (run.state === 'running' && run.jobId) {
            if (this.job.watching !== run.jobId) this.watchRun(run);
            return;
        }
        this.job.detach();
        this.view.setState(...runCard(run));
    }

    private newRun() {
        this.runs.select(null);       // emits, so the list and the pickers re-render
        this.view.setTab('create');
        this.showSelected();
    }

    private async runAction(id: string, action: RunAction) {
        const run = this.runs.list().find(other => other.id === id);
        if (!run) return;
        switch (action) {
            case 'pause':
                this.upload.pause(run.id);
                return;
            case 'resume':
            case 'retry':
                await this.startRun(run);
                return;
            case 'repick':
                this.runs.select(id);
                this.view.folderInput.click();
                return;
            case 'cancel':
                await this.discardRun(run);
                return;
            case 'dismiss':
                this.picked.delete(id);
                this.runs.remove(id);
                this.showSelected();
                return;
            case 'open':
                await this.openRun(run);
        }
    }

    private async discardRun(run: Run) {
        const name = run.runName || run.preset;
        const stored = Boolean(run.datasetId);
        const answer = await this.events.invoke('showPopup', {
            type: 'yesno',
            header: 'Huỷ luồng này?',
            message: stored ? `Huỷ “${name}” và xoá những ảnh đã tải lên?` : `Huỷ “${name}”?`,
            selectable: true,
            warning: stored ?
                { text: 'Ảnh đã tải lên trong phiên này sẽ bị xoá khỏi kho lưu trữ.' } :
                undefined
        }) as { action?: string } | undefined;
        if (answer?.action !== 'yes') return;

        this.discarding.add(run.id);
        try {
            if (run.state === 'uploading') this.upload.pause(run.id);
            if (run.datasetId) await this.upload.discard(run.datasetId);
        } finally {
            this.discarding.delete(run.id);
        }
        this.picked.delete(run.id);
        this.runs.remove(run.id);
        if (run.datasetId) this.handleDatasetDeleted(run.datasetId);
        this.showSelected();
        this.view.progress.showNotice(stored ?
            `Đã huỷ “${name}”. Ảnh của luồng này đã bị xoá khỏi kho lưu trữ.` :
            `Đã huỷ “${name}”.`, 8000);
        await this.artifacts.refreshRecentRuns();
    }

    private async openRun(run: Run) {
        if (!run.jobId) return;
        const response = await reconFetch(
            `/api/reconstruction/jobs/${encodeURIComponent(run.jobId)}`, { cache: 'no-store' });
        const data = await readJson<{ artifacts?: Artifact[] }>(response);
        const artifacts = data.artifacts ?? [];
        if (artifacts.length === 0) {
            this.view.progress.showNotice('Luồng này không còn artifact nào để mở.', 8000);
            return;
        }
        const source: ArtifactSource = {
            type: 'job',
            jobId: run.jobId,
            label: run.runName || run.preset
        };
        this.artifacts.showArtifacts(artifacts, source);   // switches to the Recent tab itself
        if (artifacts.length === 1) await this.artifacts.openArtifact(artifacts[0], source);
    }

    private async readJob(jobId: string): Promise<JobStatus> {
        const response = await reconFetch(
            `/api/reconstruction/jobs/${encodeURIComponent(jobId)}`, { cache: 'no-store' });
        return (await readJson<{ job: JobStatus }>(response)).job;
    }

    private trackRun(): Run {
        const resuming = this.pendingResume;
        const folder = this.named.length === 0 ?
            null :
            { named: this.named, fingerprint: this.fingerprint, record: resuming };
        const run = this.runs.upsert({
            id: crypto.randomUUID(),
            state: folder ? 'uploading' : 'quoting',
            datasetId: resuming?.datasetId ??
                (folder ? null : this.preparedDataset?.datasetId ?? null),
            pipeline: this.pipeline,
            preset: 'standard',
            runName: 'standard',
            submitKey: null,
            label: resuming?.label ?? `SuperSplat ${new Date().toLocaleString('en-US')}`,
            jobId: null,
            percent: 0,
            detail: ''
        });
        if (folder) this.picked.set(run.id, folder);
        return run;
    }

    private transfer(run: Run): Promise<string> {
        const folder = this.picked.get(run.id);
        if (!folder) {
            return Promise.reject(new Error(
                'Không còn dữ liệu thư mục cho luồng này. Chọn lại thư mục để tiếp tục.'));
        }
        const hooks = {
            onSession: (record: UploadRecord) => {
                folder.record = record;
                this.runs.update(run.id, { datasetId: record.datasetId });
            },
            onPercent: (percent: number) => this.runs.update(
                run.id, { percent: Math.round(percent) }),
            onRate: (rate: TransferRate) => this.view.setTransfer(run.id, rate),
            onCard: (title: string, detail: string, visual: ProgressVisual) => {
                this.card(run, title, detail, visual);
            }
        };
        return folder.record ?
            this.upload.resume(run.id, folder.record, folder.named, hooks) :
            this.upload.start(run.id, folder.named, folder.fingerprint, run.pipeline,
                run.preset, run.label, hooks);
    }

    /** Invariant: use the run's pipeline, never the current picker value. */
    private async quoteDataset(datasetId: string,
        pipeline: ReconstructionPipeline): Promise<UploadResponse> {
        const response = await reconFetch(
            `/api/reconstruction/datasets/${encodeURIComponent(datasetId)}/quote` +
            `?pipeline=${encodeURIComponent(pipeline)}`,
            { cache: 'no-store' }
        );
        const quote = await readJson<UploadResponse['quote']>(response);
        const creditsNeeded = Math.max(0, Math.ceil(quote.required - quote.balance));
        return {
            state: creditsNeeded === 0 ? 'ready' : 'checkout_required',
            datasetId,
            quote,
            creditsNeeded
        };
    }

    private submitRun(run: Run): Promise<string> {
        return this.job.submit(run.datasetId as string,
            run.pipeline as ReconstructionPipeline, run.runName, run.submitKey as string);
    }

    private reconstruct() {
        if (!this.canStart) return;
        const run = this.trackRun();
        this.releaseComposeFolder();
        this.startRun(run).catch((error) => {
            this.card(run, 'Reconstruction failed', messageOf(error), { mode: 'failed' });
        });
    }

    private startQueuedRun() {
        const next = this.runs.list().find(run => run.state === 'queued');
        if (!next) return;
        this.startRun(next, false).catch((error) => {
            this.view.progress.showNotice(messageOf(error), 8000);
        });
    }

    private async startRun(run: Run, select = true) {
        const generation = this.sessionGeneration;
        if (this.submitting.has(run.id)) return;
        const transferring = this.picked.has(run.id);
        // Only bytes are rationed. A run reusing an uploaded dataset must not wait behind someone else's upload.
        if (transferring && this.upload.active >= MAX_CONCURRENT_UPLOADS) {
            this.coordinator.transition(run.id, 'queued', { detail: '' });
            if (select) this.selectRun(run.id);
            return;
        }
        this.coordinator.setSlotCap(this.billing.concurrentCap);
        this.cancelling.delete(run.id);
        this.submitting.add(run.id);
        if (select) this.runs.select(run.id);
        if (!this.coordinator.transition(run.id, transferring ? 'uploading' : 'quoting',
            { detail: '' })) {
            this.submitting.delete(run.id);
            throw new Error('Luồng này không ở trạng thái có thể bắt đầu lại.');
        }
        this.view.checkoutLink.hidden = true;
        try {
            const datasetId = transferring ?
                await this.transfer(run) :
                run.datasetId ?? this.preparedDataset?.datasetId;
            if (generation !== this.sessionGeneration) return;
            if (!datasetId) throw new Error('Không có dataset nào để chạy.');
            const prepared = await this.quoteDataset(datasetId, run.pipeline as ReconstructionPipeline);
            if (generation !== this.sessionGeneration) return;
            this.picked.delete(run.id);
            this.coordinator.transition(run.id, 'quoting', { datasetId });
            this.billing.setBalance(prepared.quote.balance);
            this.card(run, 'Quote received',
                `Needs ${prepared.quote.required.toLocaleString()} credits for ${prepared.quote.billable_gpx.toFixed(2)} billable Gpx.`,
                { mode: 'done', center: 'Ready' });

            if (prepared.state === 'checkout_required') {
                const creditsNeeded = prepared.creditsNeeded ?? Math.max(
                    0,
                    Math.ceil(prepared.quote.required - prepared.quote.balance)
                );
                await this.billing.showCreditShortfall(creditsNeeded);
                if (generation !== this.sessionGeneration) return;
                this.coordinator.transition(run.id, 'failed', {
                    detail: `Thiếu ${creditsNeeded.toLocaleString()} credit`
                });
                this.card(run, 'Insufficient credits',
                    `This run needs ${prepared.quote.required.toLocaleString()} credits and the balance is ${prepared.quote.balance.toLocaleString()}, so ${creditsNeeded.toLocaleString()} more are needed. Buy credits, then press “Thử lại” on the run; the images will not be uploaded twice.`,
                    { mode: 'idle', center: 'Credit' });
                return;
            }

            await this.coordinator.submitReady();
            if (generation !== this.sessionGeneration) return;
            const submitted = this.runs.list().find(r => r.id === run.id);
            if (submitted?.state === 'waiting-slot') {
                const cap = this.coordinator.slotCap();
                this.card(run, 'Đang chờ lượt',
                    `${cap === null ? 'Gói đăng ký hiện tại đã dùng hết số luồng chạy cùng lúc' : `Gói đăng ký hiện tại chỉ cho phép ${cap} luồng cùng lúc`}. Luồng này sẽ tự khởi động khi có chỗ trống — kể cả khi chỗ đó được giải phóng ở tab khác.`,
                    { mode: 'indeterminate', center: 'Chờ' });
                return;
            }
            if (!submitted?.jobId) {
                this.card(run, 'Không gửi được job',
                    submitted?.detail || 'Máy chủ từ chối job này.', { mode: 'failed' });
                return;
            }
            if (this.runs.selected()?.id === run.id) this.watchRun(submitted);
        } catch (error) {
            if (generation !== this.sessionGeneration) return;
            const alive = this.runs.list().some(r => r.id === run.id);
            if (error instanceof UploadPaused) {
                if (!alive || this.discarding.has(run.id)) return;
                this.coordinator.transition(run.id, 'paused');
                this.card(run, 'Đã tạm dừng',
                    'Ảnh đã tải lên vẫn được giữ. Nhấn ▶ trên luồng để tiếp tục.',
                    { mode: 'idle', center: 'Dừng' });
                return;
            }
            if (this.settleCancelled(error, run)) return;
            if (alive) this.coordinator.transition(run.id, 'failed', { detail: messageOf(error) });
            const jobError = error instanceof ReconstructionJobError ? error : null;
            this.card(run, jobError?.title || 'Reconstruction failed', messageOf(error),
                { mode: 'failed' });
        } finally {
            if (generation === this.sessionGeneration) {
                this.submitting.delete(run.id);
                this.startQueuedRun();
            }
        }
    }

    private async watchRun(run: Run) {
        const generation = ++this.watchGeneration;
        try {
            const outcome = await this.job.attach(run.jobId as string);
            if (generation !== this.watchGeneration) return;
            if (outcome === 'detached') return;
            this.coordinator.settle(run.id, 'done', { percent: 100, detail: '' });
        } catch (error) {
            if (generation !== this.watchGeneration) return;
            if (this.settleCancelled(error, run)) return;
            const jobError = error instanceof ReconstructionJobError ? error : null;
            // A dropped stream is not a terminal job result.
            if (jobError) this.coordinator.settle(run.id, 'failed', { detail: messageOf(error) });
            else this.coordinator.transition(run.id, 'failed', { detail: messageOf(error) });
            this.card(run, jobError?.title || 'Reconstruction failed',
                messageOf(error), { mode: 'failed' });
        } finally {
            await this.coordinator.submitReady();
        }
    }
}

export { ReconstructionWorkflow };
