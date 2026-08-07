import { ReconstructionArtifacts } from './reconstruction-artifacts';
import { ReconstructionBilling } from './reconstruction-billing';
import { ReconstructionJob, ReconstructionJobError } from './reconstruction-job';
import { folderFingerprint, normalizeObjectName } from './reconstruction-names';
import type { Run } from './reconstruction-run';
import { RunStore } from './reconstruction-run-store';
import { JobStatus, RecentDataset, ReconstructionPipeline, UploadResponse } from './reconstruction-types';
import { ReconstructionUpload, UploadPaused } from './reconstruction-upload';
import type { UploadRecord } from './reconstruction-upload-records';
import {
    IMAGE_EXTENSIONS,
    PIPELINE_KEY,
    PREPARED_DATASET_KEY,
    messageOf,
    readJson
} from './reconstruction-utils';
import { ReconstructionView } from './reconstruction-view';

/** How often a run nobody is watching re-checks its job. */
const RUN_POLL_MS = 10_000;

class ReconstructionWorkflow {
    private files: File[] = [];
    /** The picked folder as store keys, derived once at pick time. */
    private named: { name: string; data: File }[] = [];
    private fingerprint = '';
    private preparedDataset: (Pick<UploadResponse, 'datasetId' | 'quote'> & {
        pipeline: ReconstructionPipeline;
    }) | null = null;
    private pipeline: ReconstructionPipeline = 'splat';
    private cancelled = false;
    private pendingResume: UploadRecord | null = null;
    private watchGeneration = 0;
    private monitor: number | null = null;
    /** An upload/submit owns the panel controls; a job finishing must not steal them back. */
    private submitting = false;
    private readonly upload: ReconstructionUpload;
    private readonly job: ReconstructionJob;
    private readonly runs = new RunStore();

    constructor(
        private readonly view: ReconstructionView,
        private readonly billing: ReconstructionBilling,
        artifacts: ReconstructionArtifacts
    ) {
        this.upload = new ReconstructionUpload(view);
        this.job = new ReconstructionJob(view, billing, artifacts, () => this.releaseBusy());

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
        this.view.setRetryAvailable(false);
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
            const response = await fetch(
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

    async restoreOpenSessions() {
        const records = await this.upload.openSessions().catch(() => [] as UploadRecord[]);
        const known = new Set(this.runs.list().map(run => run.datasetId).filter(Boolean));
        const uploading = this.submitting ? this.fingerprint : '';
        for (const record of records) {
            if (known.has(record.datasetId) || record.fingerprint === uploading) continue;
            this.runs.add({
                id: crypto.randomUUID(),
                state: 'paused',
                datasetId: record.datasetId,
                pipeline: record.pipeline,
                preset: record.preset,
                runName: record.preset,
                label: record.label,
                jobId: null,
                percent: 0,
                detail: 'Chọn lại thư mục để tiếp tục.'
            });
        }
    }

    async refreshPreparedQuote(): Promise<UploadResponse | null> {
        if (!this.preparedDataset) return null;
        this.preparedDataset.pipeline = this.pipeline;
        try {
            const response = await fetch(
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

    async cancelJob() {
        this.view.cancelButton.disabled = true;
        this.view.setRetryAvailable(false);
        this.view.checkoutLink.hidden = true;
        if (this.submitting && this.runs.selected()?.state === 'uploading') {
            this.upload.pause();
            return;
        }
        try {
            const accepted = await this.job.cancel();
            if (!accepted) {
                this.cancelled = false;
                return;
            }
            this.cancelled = true;
            this.billing.cancelPolling();
            this.view.cancelButton.hidden = true;
            this.view.setState(
                'Cancellation requested',
                'The job will stop at the next safe checkpoint.',
                { mode: 'indeterminate', center: 'Stop' }
            );
            this.setBusy(false);
        } catch (error) {
            this.cancelled = false;
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
        this.view.setRetryAvailable(false);

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
        }
    }

    private async selectFiles(list: FileList | null) {
        const candidates = Array.from(list ?? []).filter(file => IMAGE_EXTENSIONS.test(file.name));
        this.view.setTab('create');
        this.view.setRetryAvailable(false);
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
        this.pendingResume = open.find(record => record.fingerprint === this.fingerprint) ?? null;
        if (!this.pendingResume) return;
        this.view.fileSummary.textContent =
            `${candidates.length.toLocaleString()} ảnh · phiên tải lên ${this.pendingResume.datasetId} đang dở`;
        this.view.setState('Có thể tiếp tục',
            'Thư mục này đã có phiên tải lên chưa hoàn tất. Nhấn Bắt đầu để tiếp tục — ảnh đã lên sẽ không gửi lại.',
            { mode: 'idle' });
    }

    private setBusy(busy: boolean) {
        this.view.setBusy(busy, this.canStart);
    }

    /** A watched job reached a terminal state and wants the controls back. */
    private releaseBusy() {
        if (!this.submitting) this.setBusy(false);
    }

    private renderRuns() {
        this.view.renderRuns(this.runs.list(), this.runs.selected()?.id ?? null,
            id => this.selectRun(id));
        const cap = this.runs.slotCap();
        this.view.setRunsNote(cap === null ? '' : `Tối đa ${cap} job chạy cùng lúc`);
        this.syncMonitor();
    }

    /**
     * Selecting a run moves the progress card
     */
    private selectRun(id: string) {
        if (this.runs.selected()?.id === id) return;
        this.runs.select(id);
        const run = this.runs.selected();
        if (run?.jobId && run.state === 'running') this.watchRun(run);
    }

    private async watchRun(run: Run) {
        const generation = ++this.watchGeneration;
        try {
            await this.job.attach(run.jobId as string);
            if (generation !== this.watchGeneration) return;
            this.runs.update(run.id, { state: 'done', percent: 100, detail: '' });
        } catch (error) {
            if (generation !== this.watchGeneration) return;
            this.runs.update(run.id, { state: 'failed', detail: messageOf(error) });
            if (this.cancelled || this.job.wasCancelled) return;
            const jobError = error instanceof ReconstructionJobError ? error : null;
            this.view.cancelButton.hidden = true;
            this.view.setRetryAvailable(Boolean(jobError?.retryable));
            this.view.setState(jobError?.title || 'Reconstruction failed',
                messageOf(error), { mode: 'failed' });
        } finally {
            await this.startWaitingRuns();
        }
    }

    private syncMonitor() {
        const live = this.runs.list().some(run => run.state === 'running');
        if (live && this.monitor === null) {
            this.monitor = window.setInterval(() => {
                // A tick that fails (offline, a 502) is skipped; the next one retries.
                this.pollUnwatchedRuns().catch((): void => undefined);
            }, RUN_POLL_MS);
        } else if (!live && this.monitor !== null) {
            window.clearInterval(this.monitor);
            this.monitor = null;
        }
    }

    private async pollUnwatchedRuns() {
        const selectedId = this.runs.selected()?.id ?? null;
        const pending = this.runs.list().filter(run => (
            run.state === 'running' && run.jobId !== null && run.id !== selectedId));
        for (const run of pending) {
            const response = await fetch(
                `/api/reconstruction/jobs/${encodeURIComponent(run.jobId as string)}`,
                { cache: 'no-store' });
            const { job } = await readJson<{ job: JobStatus }>(response);
            if (!job.terminal) {
                this.runs.update(run.id, { detail: job.status });
                continue;
            }
            this.runs.update(run.id, {
                state: job.status === 'done' ? 'done' : 'failed',
                percent: job.status === 'done' ? 100 : run.percent,
                detail: job.status === 'done' ? '' : (job.failure?.message ?? job.status)
            });
            await this.startWaitingRuns();
        }
    }

    private submitDeps() {
        return {
            submit: (run: Run) => this.job.submit(
                run.datasetId as string, run.pipeline as ReconstructionPipeline, run.runName),
            takenRunNames: (datasetId: string, pipeline: string) => this.takenRunNames(
                datasetId, pipeline)
        };
    }

    private trackRun(): Run {
        const label = this.pendingResume?.label ??
            `SuperSplat ${new Date().toLocaleString('en-US')}`;
        const run: Run = {
            id: crypto.randomUUID(),
            state: 'uploading',
            datasetId: this.pendingResume?.datasetId ?? this.preparedDataset?.datasetId ?? null,
            pipeline: this.pipeline,
            preset: 'standard',
            runName: 'standard',
            label,
            jobId: null,
            percent: 0,
            detail: ''
        };
        this.runs.add(run);
        return run;
    }

    /** Upload (or resume) the picked folder and return the committed dataset id. */
    private transfer(run: Run): Promise<string> {
        if (this.pendingResume) {
            const record = this.pendingResume;
            this.pendingResume = null;
            return this.upload.resume(record, this.files);
        }
        return this.upload.start(this.named, this.fingerprint, this.pipeline, 'standard', run.label);
    }

    private async quoteDataset(datasetId: string): Promise<UploadResponse> {
        const response = await fetch(
            `/api/reconstruction/datasets/${encodeURIComponent(datasetId)}/quote` +
            `?pipeline=${encodeURIComponent(this.pipeline)}`,
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

    private async takenRunNames(datasetId: string, pipeline: string): Promise<string[]> {
        const response = await fetch(
            `/api/reconstruction/datasets/${encodeURIComponent(datasetId)}/runs`,
            { cache: 'no-store' }
        );
        const data = await readJson<{ runs: { pipeline: string; run_name: string }[] }>(response);
        return data.runs.filter(r => r.pipeline === pipeline).map(r => r.run_name);
    }

    /** A slot freed up, so whatever the cap made wait can go now. */
    private async startWaitingRuns() {
        if (!this.runs.list().some(r => r.state === 'waiting-slot')) return;
        await this.runs.submitReady(this.submitDeps());
    }

    private async reconstruct() {
        if (!this.canStart || this.submitting) return;
        if (this.billing.concurrentCap !== null) this.runs.seedSlotCap(this.billing.concurrentCap);
        this.cancelled = false;
        this.submitting = true;
        this.view.setRetryAvailable(false);
        this.view.checkoutLink.hidden = true;
        this.setBusy(true);
        this.view.cancelButton.hidden = false;
        const run = this.trackRun();
        try {
            let prepared = await this.refreshPreparedQuote();
            if (!prepared) {
                const datasetId = await this.transfer(run);
                prepared = await this.quoteDataset(datasetId);
                this.preparedDataset = {
                    datasetId,
                    quote: prepared.quote,
                    pipeline: this.pipeline
                };
                this.persistPreparedDataset();
            }
            this.runs.update(run.id, { state: 'quoting', datasetId: prepared.datasetId });
            this.billing.setBalance(prepared.quote.balance);
            this.view.setState('Quote received',
                `Needs ${prepared.quote.required.toLocaleString()} credits for ${prepared.quote.billable_gpx.toFixed(2)} billable Gpx.`,
                { mode: 'done', center: 'Ready' });

            if (prepared.state === 'checkout_required') {
                const creditsNeeded = prepared.creditsNeeded ?? Math.max(
                    0,
                    Math.ceil(prepared.quote.required - prepared.quote.balance)
                );
                await this.billing.showCreditShortfall(creditsNeeded);
                this.view.cancelButton.hidden = true;
                this.view.setState('Insufficient credits',
                    `The dataset is already on R2 and needs ${prepared.quote.required.toLocaleString()} credits. The current balance is ${prepared.quote.balance.toLocaleString()}, so ${creditsNeeded.toLocaleString()} more are needed. Buy credits and press Start again; the images will not be uploaded twice.`,
                    { mode: 'idle', center: 'Credit' });
                this.setBusy(false);
                return;
            }

            await this.runs.submitReady(this.submitDeps());
            const submitted = this.runs.list().find(r => r.id === run.id);
            if (submitted?.state === 'waiting-slot') {
                const cap = this.runs.slotCap();
                this.view.setState('Đang chờ lượt',
                    `Gói hiện tại cho phép ${cap ?? 1} job chạy cùng lúc. Luồng này sẽ tự khởi động khi có chỗ trống.`,
                    { mode: 'indeterminate', center: 'Chờ' });
                this.setBusy(false);
                return;
            }
            if (!submitted?.jobId) {
                this.setBusy(false);
                this.view.cancelButton.hidden = true;
                this.view.setState('Không gửi được job',
                    submitted?.detail || 'Máy chủ từ chối job này.', { mode: 'failed' });
                return;
            }
            this.submitting = false;
            this.setBusy(false);
            this.runs.select(run.id);
            this.watchRun(submitted);
        } catch (error) {
            if (error instanceof UploadPaused) {
                this.runs.update(run.id, { state: 'paused' });
                this.view.cancelButton.hidden = true;
                this.view.cancelButton.disabled = false;
                this.view.setState('Đã tạm dừng',
                    'Ảnh đã tải lên vẫn được giữ. Nhấn Bắt đầu để tiếp tục.',
                    { mode: 'idle', center: 'Dừng' });
                this.setBusy(false);
                return;
            }
            this.runs.update(run.id, { state: 'failed', detail: messageOf(error) });
            if (this.cancelled || this.job.wasCancelled) return;
            const jobError = error instanceof ReconstructionJobError ? error : null;
            this.view.cancelButton.hidden = true;
            this.view.setRetryAvailable(Boolean(jobError?.retryable));
            this.view.setState(jobError?.title || 'Reconstruction failed', messageOf(error), { mode: 'failed' });
            this.setBusy(false);
            if (jobError && !jobError.retryable) this.view.startButton.disabled = true;
        } finally {
            this.submitting = false;
        }
    }
}

export { ReconstructionWorkflow };
