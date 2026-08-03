import { ReconstructionArtifacts } from './reconstruction-artifacts';
import { ReconstructionBilling } from './reconstruction-billing';
import { ReconstructionJob, ReconstructionJobError } from './reconstruction-job';
import { ReconstructionPipeline, UploadResponse } from './reconstruction-types';
import { ReconstructionUpload } from './reconstruction-upload';
import {
    IMAGE_EXTENSIONS,
    PIPELINE_KEY,
    PREPARED_DATASET_KEY,
    messageOf,
    readJson
} from './reconstruction-utils';
import { ReconstructionView } from './reconstruction-view';

class ReconstructionWorkflow {
    private files: File[] = [];
    private relativePaths: string[] = [];
    private preparedDataset: (Pick<UploadResponse, 'datasetId' | 'quote'> & {
        pipeline: ReconstructionPipeline;
    }) | null = null;
    private pipeline: ReconstructionPipeline = 'splat';
    private cancelled = false;
    private readonly upload: ReconstructionUpload;
    private readonly job: ReconstructionJob;

    constructor(
        private readonly view: ReconstructionView,
        private readonly billing: ReconstructionBilling,
        artifacts: ReconstructionArtifacts
    ) {
        this.upload = new ReconstructionUpload(view);
        this.job = new ReconstructionJob(view, billing, artifacts, () => this.canStart);

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

        view.folderInput.addEventListener('change', () => this.selectFiles(view.folderInput.files));
        view.imageInput.addEventListener('change', () => this.selectFiles(view.imageInput.files));
        view.startButton.addEventListener('click', () => this.reconstruct());

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
            this.selectFiles(event.dataTransfer?.files ?? null);
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
                throw new Error('The uploaded dataset is no longer on R2; the next Start will upload the images again.');
            }
            const quote = await readJson<UploadResponse['quote']>(response);
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
        } catch (error) {
            throw new Error(`Could not recheck the uploaded dataset: ${messageOf(error)}`);
        }
    }

    async cancelJob() {
        this.view.cancelButton.disabled = true;
        this.view.setRetryAvailable(false);
        this.view.checkoutLink.hidden = true;
        this.upload.cancel();
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

    private get actionLabel() {
        return this.pipeline === 'splat' ? 'Create Gaussian Splat' : 'Create textured mesh';
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

    private selectFiles(list: FileList | null) {
        const candidates = Array.from(list ?? []).filter(file => IMAGE_EXTENSIONS.test(file.name));
        this.view.setTab('create');
        this.clearPreparedDataset();
        this.view.setRetryAvailable(false);
        this.files = candidates;
        this.relativePaths = candidates.map(file => (
            (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
        ));
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
    }

    private setBusy(busy: boolean) {
        this.view.setBusy(busy, this.canStart);
    }

    private async reconstruct() {
        if (!this.canStart) return;
        this.cancelled = false;
        this.view.setRetryAvailable(false);
        this.view.checkoutLink.hidden = true;
        this.setBusy(true);
        this.view.cancelButton.hidden = false;
        try {
            let prepared = await this.refreshPreparedQuote();
            if (!prepared) {
                prepared = await this.upload.run(this.files, this.relativePaths, this.pipeline);
                this.preparedDataset = {
                    datasetId: prepared.datasetId,
                    quote: prepared.quote,
                    pipeline: this.pipeline
                };
                this.persistPreparedDataset();
            }
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

            await this.job.run(prepared.datasetId, this.pipeline);
        } catch (error) {
            if (this.cancelled || this.job.wasCancelled) return;
            const jobError = error instanceof ReconstructionJobError ? error : null;
            this.view.cancelButton.hidden = true;
            this.view.setRetryAvailable(Boolean(jobError?.retryable));
            this.view.setState(jobError?.title || 'Reconstruction failed', messageOf(error), { mode: 'failed' });
            this.setBusy(false);
            if (jobError && !jobError.retryable) this.view.startButton.disabled = true;
        }
    }
}

export { ReconstructionWorkflow };
