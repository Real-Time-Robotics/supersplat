import { Button, Container, Label } from '@playcanvas/pcui';

import { Events } from '../events';
import { i18n } from './localization';

type UploadResponse = {
    state: 'ready' | 'checkout_required';
    datasetId: string;
    quote: { required: number; balance: number; billable_gpx: number };
    creditsNeeded?: number;
    checkout?: { url: string; id: string };
};

type PricingPack = {
    credits: number;
    credits_label?: string;
    price_cents?: number;
    price_label?: string;
};

type PricingCatalog = {
    credit_unit_usd: number;
    note: string;
    packs: PricingPack[];
    custom_min_credits: number;
    custom_max_credits: number;
};

type CheckoutStatus = {
    id: string;
    status: 'pending' | 'paid' | 'expired' | 'failed';
};

type UploadProgress = {
    phase: 'presign' | 'upload' | 'finalize' | 'ingest';
    loaded: number;
    total: number;
    file?: string;
};

type StageEvent = {
    phase: 'start' | 'end';
    step: string;
    index: number;
    total: number;
    returncode: number | null;
};

const IMAGE_EXTENSIONS = /\.(?:jpe?g|png|tiff?|bmp|webp)$/i;
const delay = (ms: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
});
const messageOf = (error: unknown) => (
    error instanceof Error ? error.message : String(error)
);

class ReconstructionPanel extends Container {
    private events: Events;
    private files: File[] = [];
    private relativePaths: string[] = [];
    private activeJobId: string | null = null;
    private activeUpload: XMLHttpRequest | null = null;
    private activeEvents: EventSource | null = null;
    private cancelled = false;
    private logLines: string[] = [];
    private balance = 0;
    private pricingLoaded = false;
    private checkoutPollId = 0;
    private stageProgress = 0;

    private fileSummary: HTMLElement;
    private status: HTMLElement;
    private statusDetail: HTMLElement;
    private creditValue: HTMLElement;
    private progressBar: HTMLElement;
    private logs: HTMLPreElement;
    private startButton: HTMLButtonElement;
    private cancelButton: HTMLButtonElement;
    private checkoutLink: HTMLAnchorElement;
    private imageInput: HTMLInputElement;
    private folderInput: HTMLInputElement;
    private buyCreditsButton: HTMLButtonElement;
    private pricingPanel: HTMLElement;
    private pricingPacks: HTMLElement;
    private pricingNote: HTMLElement;
    private purchaseStatus: HTMLElement;
    private purchaseCheckoutLink: HTMLAnchorElement;
    private customCreditsInput: HTMLInputElement;
    private customPrice: HTMLElement;

    constructor(events: Events) {
        super({
            id: 'reconstruction-panel',
            class: 'panel',
            hidden: true
        });

        this.events = events;

        const header = new Container({ class: 'panel-header' });
        const icon = new Label({
            text: '\uE344',
            class: 'panel-header-icon'
        });
        const title = new Label({ class: 'panel-header-label' });
        i18n.bindText(title, 'panel.reconstruction');
        const close = new Button({
            class: ['panel-header-button', 'reconstruction-panel-close'],
            text: '\u00D7'
        });
        close.dom.setAttribute('aria-label', 'Close Reconstruction panel');
        close.dom.setAttribute('title', 'Close');
        close.on('click', () => events.fire('reconstructionPanel.setVisible', false));
        header.append(icon);
        header.append(title);
        header.append(close);
        this.append(header);

        const body = document.createElement('div');
        body.className = 'recon-body blocks-shortcuts';
        body.innerHTML = `
            <div class="recon-intro">
                <strong>Images to Gaussian Splat</strong>
                <span>Genesis Point · Polar sandbox</span>
            </div>
            <section class="recon-credit">
                <div class="recon-credit-balance">
                    <span><i></i> CREDIT BALANCE</span>
                    <strong><span class="recon-credit-value">—</span> credits</strong>
                </div>
                <button class="recon-button recon-buy-credits" type="button" aria-expanded="false">＋ Buy credits</button>
            </section>
            <section class="recon-pricing" aria-hidden="true">
                <div class="recon-section-heading">
                    <strong>Buy PAYG credits</strong>
                    <span>Polar sandbox · no real charges</span>
                </div>
                <div class="recon-pricing-packs"><span>Loading pricing…</span></div>
                <div class="recon-custom-credits">
                    <label for="recon-custom-credits">Custom credits</label>
                    <div>
                        <input id="recon-custom-credits" type="number" min="100" max="1000000" step="100" value="1000">
                        <span class="recon-custom-price">≈ $10.00</span>
                        <button class="recon-button recon-primary recon-custom-buy" type="button">Buy</button>
                    </div>
                </div>
                <p class="recon-pricing-note"></p>
                <p class="recon-purchase-status" role="status"></p>
                <a class="recon-purchase-checkout" target="genesis-polar-checkout" rel="noopener" hidden>Reopen Polar checkout ↗</a>
            </section>
            <div class="recon-dropzone" tabindex="0">
                <div class="recon-drop-icon">＋</div>
                <strong>Drop an image folder here</strong>
                <span>JPG, PNG, TIFF, BMP or WebP</span>
                <div class="recon-file-actions">
                    <button class="recon-button recon-folder-button" type="button">Choose folder</button>
                    <button class="recon-button recon-images-button" type="button">Choose images</button>
                </div>
            </div>
            <input class="recon-folder-input" type="file" accept="image/*,.tif,.tiff" multiple hidden>
            <input class="recon-image-input" type="file" accept="image/*,.tif,.tiff" multiple hidden>
            <div class="recon-file-summary">No images selected</div>
            <div class="recon-progress-track"><div class="recon-progress-bar"></div></div>
            <div class="recon-state">
                <strong class="recon-status">Ready</strong>
                <span class="recon-status-detail">Choose a set of photos captured around an object or space.</span>
            </div>
            <a class="recon-checkout" target="genesis-polar-checkout" rel="noopener" hidden>Open Polar sandbox checkout ↗</a>
            <pre class="recon-logs" hidden></pre>
            <footer class="recon-footer">
                <button class="recon-button recon-cancel" type="button" hidden>Cancel</button>
                <button class="recon-button recon-primary recon-start" type="button" disabled>Create Gaussian Splat</button>
            </footer>
            <p class="recon-note">Credits are only held once the job starts. The finished model opens automatically in SuperSplat.</p>`;
        this.dom.appendChild(body);

        this.fileSummary = this.query('.recon-file-summary');
        this.status = this.query('.recon-status');
        this.statusDetail = this.query('.recon-status-detail');
        this.creditValue = this.query('.recon-credit-value');
        this.progressBar = this.query('.recon-progress-bar');
        this.logs = this.query('.recon-logs');
        this.startButton = this.query('.recon-start');
        this.cancelButton = this.query('.recon-cancel');
        this.checkoutLink = this.query('.recon-checkout');
        this.imageInput = this.query('.recon-image-input');
        this.folderInput = this.query('.recon-folder-input');
        this.buyCreditsButton = this.query('.recon-buy-credits');
        this.pricingPanel = this.query('.recon-pricing');
        this.pricingPacks = this.query('.recon-pricing-packs');
        this.pricingNote = this.query('.recon-pricing-note');
        this.purchaseStatus = this.query('.recon-purchase-status');
        this.purchaseCheckoutLink = this.query('.recon-purchase-checkout');
        this.customCreditsInput = this.query('.recon-custom-credits input');
        this.customPrice = this.query('.recon-custom-price');
        this.folderInput.setAttribute('webkitdirectory', '');

        this.query('.recon-folder-button').addEventListener('click', () => this.folderInput.click());
        this.query('.recon-images-button').addEventListener('click', () => this.imageInput.click());
        this.folderInput.addEventListener('change', () => this.selectFiles(this.folderInput.files));
        this.imageInput.addEventListener('change', () => this.selectFiles(this.imageInput.files));
        this.startButton.addEventListener('click', () => this.reconstruct());
        this.cancelButton.addEventListener('click', () => this.cancelJob());
        this.buyCreditsButton.addEventListener('click', () => this.togglePricing());
        this.query('.recon-custom-buy').addEventListener('click', () => this.purchaseCustomCredits());
        this.customCreditsInput.addEventListener('input', () => this.updateCustomPrice());

        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        const dropzone = this.query<HTMLDivElement>('.recon-dropzone');
        ['dragenter', 'dragover'].forEach(name => dropzone.addEventListener(name, (event) => {
            event.preventDefault();
            event.stopPropagation();
            dropzone.classList.add('dragging');
        }));
        ['dragleave', 'drop'].forEach(name => dropzone.addEventListener(name, () => dropzone.classList.remove('dragging')));
        dropzone.addEventListener('drop', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.selectFiles(event.dataTransfer?.files ?? null);
        });
        dropzone.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') this.imageInput.click();
        });

        const setVisible = (visible: boolean) => {
            if (visible === this.hidden) {
                this.hidden = !visible;
                events.fire('reconstructionPanel.visible', visible);
                if (visible) this.refreshCredits();
            }
        };
        events.function('reconstructionPanel.visible', () => !this.hidden);
        events.on('reconstructionPanel.setVisible', (visible: boolean) => setVisible(visible));
        events.on('reconstructionPanel.toggleVisible', () => setVisible(this.hidden));
        events.on('colorPanel.visible', (visible: boolean) => {
            if (visible) setVisible(false);
        });
        events.on('settingsPanel.visible', (visible: boolean) => {
            if (visible) setVisible(false);
        });

        this.refreshCredits();
    }

    private query<T extends HTMLElement = HTMLElement>(selector: string): T {
        return this.dom.querySelector(selector) as T;
    }

    private selectFiles(list: FileList | null) {
        const candidates = Array.from(list ?? []).filter(file => IMAGE_EXTENSIONS.test(file.name));
        this.files = candidates;
        this.relativePaths = candidates.map(file => (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name);
        const bytes = candidates.reduce((sum, file) => sum + file.size, 0);
        const size = bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
        this.fileSummary.textContent = candidates.length ?
            `${candidates.length.toLocaleString()} images · ${size}` :
            'No supported images found';
        this.startButton.disabled = candidates.length === 0;
        this.setState('Ready to upload', candidates.length < 20 ?
            'A small image set may produce an unstable model; use at least 20 well-overlapping photos.' :
            'It will upload, quote the credit cost, then start automatically once the balance is sufficient.', 0);
    }

    private async refreshCredits() {
        try {
            const response = await fetch('/api/reconstruction/credits', { cache: 'no-store' });
            const data = await this.readJson(response);
            this.balance = Number(data.balance);
            this.creditValue.textContent = this.balance.toLocaleString();
            return this.balance;
        } catch {
            this.creditValue.textContent = 'offline';
            return null;
        }
    }

    private async togglePricing() {
        const open = !this.pricingPanel.classList.contains('open');
        this.pricingPanel.classList.toggle('open', open);
        this.pricingPanel.setAttribute('aria-hidden', String(!open));
        this.buyCreditsButton.setAttribute('aria-expanded', String(open));
        if (open && !this.pricingLoaded) await this.loadPricing();
    }

    private async loadPricing() {
        try {
            const response = await fetch('/api/reconstruction/pricing', { cache: 'no-store' });
            const catalog = await this.readJson(response) as PricingCatalog;
            this.pricingPacks.textContent = '';
            for (const pack of catalog.packs) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'recon-button recon-price-pack';
                const credits = document.createElement('strong');
                credits.textContent = pack.credits_label || pack.credits.toLocaleString();
                const label = document.createElement('span');
                const price = pack.price_label || `$${((pack.price_cents || 0) / 100).toFixed(2)}`;
                label.textContent = `${price} · PAYG`;
                button.append(credits, label);
                button.addEventListener('click', () => this.purchaseCredits({ packCredits: pack.credits }, pack.credits));
                this.pricingPacks.appendChild(button);
            }
            this.pricingNote.textContent = catalog.note;
            this.customCreditsInput.min = String(catalog.custom_min_credits);
            this.customCreditsInput.max = String(catalog.custom_max_credits);
            this.customCreditsInput.dataset.unitUsd = String(catalog.credit_unit_usd);
            this.updateCustomPrice();
            this.pricingLoaded = true;
        } catch (error) {
            this.pricingPacks.textContent = messageOf(error);
        }
    }

    private updateCustomPrice() {
        const credits = Number(this.customCreditsInput.value);
        const unitUsd = Number(this.customCreditsInput.dataset.unitUsd || 0.01);
        this.customPrice.textContent = Number.isFinite(credits) ? `≈ $${(credits * unitUsd).toFixed(2)}` : '—';
    }

    private async purchaseCustomCredits() {
        const customCredits = Number(this.customCreditsInput.value);
        const min = Number(this.customCreditsInput.min || 100);
        const max = Number(this.customCreditsInput.max || 1_000_000);
        if (!Number.isInteger(customCredits) || customCredits < min || customCredits > max) {
            this.purchaseStatus.textContent = `Enter between ${min.toLocaleString()} and ${max.toLocaleString()} credits.`;
            return;
        }
        await this.purchaseCredits({ customCredits }, customCredits);
    }

    private async purchaseCredits(body: { packCredits?: number; customCredits?: number }, expectedCredits: number) {
        const balanceBefore = await this.refreshCredits() ?? this.balance;
        const popup = window.open('about:blank', `genesis-polar-${Date.now()}`, 'popup,width=520,height=760');
        if (popup) popup.document.body.textContent = 'Creating Polar sandbox checkout…';
        this.purchaseStatus.textContent = 'Creating checkout…';
        try {
            const response = await fetch('/api/reconstruction/checkout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const checkout = await this.readJson(response);
            this.purchaseCheckoutLink.href = checkout.url;
            this.purchaseCheckoutLink.hidden = false;
            if (popup) popup.location.href = checkout.url;
            this.purchaseStatus.textContent = `Waiting for Polar to add ${expectedCredits.toLocaleString()} credits…`;
            await this.waitForCheckout(checkout.id, balanceBefore, popup, expectedCredits);
        } catch (error) {
            popup?.close();
            this.purchaseStatus.textContent = messageOf(error);
        }
    }

    private async waitForCheckout(checkoutId: string, balanceBefore: number, popup: Window | null, expectedCredits: number) {
        const pollId = ++this.checkoutPollId;
        for (let attempt = 0; attempt < 150 && pollId === this.checkoutPollId; attempt++) {
            let checkout: CheckoutStatus | null = null;
            try {
                const response = await fetch(`/api/reconstruction/checkouts/${encodeURIComponent(checkoutId)}`, { cache: 'no-store' });
                checkout = await this.readJson(response) as CheckoutStatus;
            } catch {
                // Balance remains a reliable fallback if Polar status is temporarily unavailable.
            }
            const balance = await this.refreshCredits();
            if (checkout?.status === 'paid' || (balance != null && balance > balanceBefore)) {
                if (popup && !popup.closed) popup.close();
                const received = balance == null ? expectedCredits : Math.max(expectedCredits, balance - balanceBefore);
                this.purchaseStatus.textContent = `Received ${received.toLocaleString()} credits.`;
                this.purchaseCheckoutLink.hidden = true;
                return;
            }
            if (checkout?.status === 'expired' || checkout?.status === 'failed') {
                throw new Error(`Polar checkout ended with status “${checkout.status}”.`);
            }
            await delay(2000);
        }
        if (pollId === this.checkoutPollId) {
            throw new Error('Checkout is still not complete. You can reopen the checkout or check your balance later.');
        }
    }

    private setState(title: string, detail: string, progress: number) {
        this.status.textContent = title;
        this.statusDetail.textContent = detail;
        this.progressBar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
    }

    private setBusy(busy: boolean) {
        this.startButton.disabled = busy || this.files.length === 0;
        this.imageInput.disabled = busy;
        this.folderInput.disabled = busy;
    }

    private updateStorageProgress(progress: UploadProgress) {
        if (progress.phase === 'presign') {
            this.setState('Preparing object storage', 'The server is creating secure upload URLs.', 36);
            return;
        }
        if (progress.phase === 'upload') {
            const ratio = progress.total > 0 ? progress.loaded / progress.total : 0;
            const current = progress.file ? ` · ${progress.file}` : '';
            this.setState('Uploading to object storage',
                `${Math.round(progress.loaded / 1024 / 1024)} / ${Math.round(progress.total / 1024 / 1024)} MB${current}`,
                36 + ratio * 17);
            return;
        }
        if (progress.phase === 'finalize') {
            this.setState('Finalizing dataset', 'Object storage received all images.', 54);
            return;
        }
        this.setState('Processing dataset', 'The server is validating and indexing images.', 56);
    }

    private upload(): Promise<UploadResponse> {
        return new Promise((resolve, reject) => {
            const operationId = crypto.randomUUID();
            const source = new EventSource(`/api/reconstruction/uploads/${encodeURIComponent(operationId)}/events`);
            const form = new FormData();
            this.files.forEach(file => form.append('images', file, file.name));
            form.append('relativePaths', JSON.stringify(this.relativePaths));
            form.append('label', `SuperSplat ${new Date().toLocaleString('en-US')}`);
            form.append('operationId', operationId);

            source.addEventListener('progress', (event) => {
                this.updateStorageProgress(JSON.parse(event.data) as UploadProgress);
            });
            source.addEventListener('end', () => source.close());
            source.addEventListener('failed', (event) => {
                const data = JSON.parse(event.data) as { message?: string };
                this.statusDetail.textContent = data.message || 'Object storage upload failed.';
                source.close();
            });

            const request = new XMLHttpRequest();
            this.activeUpload = request;
            request.open('POST', '/api/reconstruction/upload');
            request.upload.onprogress = (event) => {
                if (!event.lengthComputable) return;
                const percent = Math.round((event.loaded / event.total) * 34);
                this.setState('Sending images to localhost',
                    `${Math.round(event.loaded / 1024 / 1024)} / ${Math.round(event.total / 1024 / 1024)} MB`,
                    percent);
            };
            request.onerror = () => {
                this.activeUpload = null;
                source.close();
                reject(new Error('Lost connection to the localhost server.'));
            };
            request.onabort = () => {
                this.activeUpload = null;
                source.close();
                reject(new DOMException('Upload cancelled', 'AbortError'));
            };
            request.onload = () => {
                this.activeUpload = null;
                source.close();
                let responseBody: any = {};
                try {
                    responseBody = JSON.parse(request.responseText);
                } catch {
                    // Status handling below supplies a useful fallback.
                }
                if (request.status < 200 || request.status >= 300) {
                    reject(new Error(responseBody.error || `Upload failed (${request.status})`));
                } else {
                    resolve(responseBody as UploadResponse);
                }
            };
            request.send(form);
        });
    }

    private async reconstruct() {
        if (!this.files.length) return;
        this.cancelled = false;
        this.checkoutLink.hidden = true;
        this.logs.hidden = true;
        this.logLines = [];
        this.stageProgress = 0;
        this.setBusy(true);
        this.cancelButton.hidden = false;
        try {
            const prepared = await this.upload();
            this.creditValue.textContent = prepared.quote.balance.toLocaleString();
            this.setState('Quote received',
                `Needs ${prepared.quote.required.toLocaleString()} credits for ${prepared.quote.billable_gpx.toFixed(2)} billable Gpx.`,
                58);

            if (prepared.state === 'checkout_required') {
                const checkout = prepared.checkout;
                if (!checkout) throw new Error('The SDK did not return a Polar checkout URL.');
                this.checkoutLink.href = checkout.url;
                this.checkoutLink.hidden = false;
                const popup = window.open(checkout.url, `genesis-polar-${Date.now()}`, 'popup,width=520,height=760');
                this.setState('Waiting for sandbox credit purchase',
                    `Short ${prepared.creditsNeeded?.toLocaleString()} credits. Complete checkout in the Polar window.`,
                    59);
                await this.waitForCheckout(checkout.id, prepared.quote.balance, popup, prepared.creditsNeeded || 0);
                await this.waitForCredits(prepared.datasetId, prepared.quote.required);
                if (this.cancelled) return;
            }

            await this.startJob(prepared.datasetId);
        } catch (error) {
            if (this.cancelled) return;
            this.cancelButton.hidden = true;
            this.setState('Reconstruction failed', messageOf(error), 0);
            this.setBusy(false);
        }
    }

    private async waitForCredits(datasetId: string, required: number) {
        for (;;) {
            if (this.cancelled) return;
            const response = await fetch(`/api/reconstruction/datasets/${encodeURIComponent(datasetId)}/quote`, { cache: 'no-store' });
            const quote = await this.readJson(response);
            this.creditValue.textContent = Number(quote.balance).toLocaleString();
            if (quote.balance >= required) {
                this.checkoutLink.hidden = true;
                this.setState('Credits received', 'Submitting the Gaussian Splatting job…', 60);
                return;
            }
            await delay(2000);
        }
    }

    private async startJob(datasetId: string) {
        const response = await fetch('/api/reconstruction/jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                datasetId,
                preset: 'standard',
                idempotencyKey: crypto.randomUUID()
            })
        });
        const data = await this.readJson(response);
        this.activeJobId = data.jobId;
        this.setState('Job running', `Job ${this.activeJobId.slice(0, 8)} · waiting for the first stage`, 62);
        this.followEvents(this.activeJobId);
        await this.waitForJob(this.activeJobId);
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
            const ratio = stage.total > 0 ? (stage.index - (stage.phase === 'start' ? 1 : 0)) / stage.total : 0;
            this.stageProgress = 62 + Math.max(0, Math.min(1, ratio)) * 29;
            const verb = stage.phase === 'start' ? 'Running' : 'Done';
            this.setState(`${verb}: ${stage.step}`, `Stage ${stage.index} / ${stage.total}`, this.stageProgress);
        });
        source.addEventListener('artifact', (event) => {
            const artifact = JSON.parse(event.data) as { name?: string };
            this.statusDetail.textContent = artifact.name ? `Artifact ready: ${artifact.name}` : 'Artifact ready.';
        });
        source.addEventListener('end', () => {
            source.close();
            if (this.activeEvents === source) this.activeEvents = null;
        });
        source.addEventListener('failed', (event) => {
            const data = JSON.parse(event.data) as { message?: string };
            this.statusDetail.textContent = data.message || 'Lost connection to the job event stream.';
            source.close();
        });
        source.onerror = () => {
            source.close();
            if (this.activeEvents === source) this.activeEvents = null;
        };
    }

    private async waitForJob(jobId: string) {
        let transientNotFound = 0;
        for (;;) {
            if (this.cancelled) return;
            const response = await fetch(`/api/reconstruction/jobs/${encodeURIComponent(jobId)}`, { cache: 'no-store' });
            if (response.status === 404 && transientNotFound < 30) {
                transientNotFound++;
                this.statusDetail.textContent = 'Syncing final status and artifacts…';
                await delay(2000);
                continue;
            }
            const data = await this.readJson(response);
            transientNotFound = 0;
            const job = data.job;
            if (job.terminal) {
                this.activeEvents?.close();
                this.activeEvents = null;
                this.cancelButton.hidden = true;
                this.activeJobId = null;
                if (job.status !== 'done') throw new Error(`Job ended with status “${job.status}”.`);
                break;
            }
            if (this.stageProgress === 0) {
                const progress = job.status === 'queued' ? 62 : job.status === 'viewer' ? 91 : 68;
                this.setState(`Job: ${job.status}`, 'The pipeline is running on the GPU; detailed progress appears per stage.', progress);
            }
            await delay(2500);
        }

        this.setState('Downloading model', 'Fetching the PLY artifact and loading it into SuperSplat…', 94);
        const modelResponse = await fetch(`/api/reconstruction/jobs/${encodeURIComponent(jobId)}/model`);
        if (!modelResponse.ok) await this.readJson(modelResponse);
        const blob = await modelResponse.blob();
        const disposition = modelResponse.headers.get('Content-Disposition') || '';
        const filename = disposition.match(/filename="([^"]+)"/)?.[1] || `genesis-${jobId.slice(0, 8)}.ply`;
        const file = new File([blob], filename, { type: blob.type || 'application/ply' });
        await this.events.invoke('import', [{ filename, contents: file }]);
        await this.refreshCredits();
        this.setState('Model opened in SuperSplat', `${filename} · ${(blob.size / 1024 / 1024).toFixed(1)} MB`, 100);
        this.setBusy(false);
    }

    private async cancelJob() {
        this.cancelled = true;
        this.checkoutPollId++;
        this.checkoutLink.hidden = true;
        this.activeUpload?.abort();
        this.activeUpload = null;
        this.activeEvents?.close();
        this.activeEvents = null;
        if (this.activeJobId) {
            await fetch(`/api/reconstruction/jobs/${encodeURIComponent(this.activeJobId)}/cancel`, {
                method: 'POST'
            }).catch((): void => {});
        }
        this.activeJobId = null;
        this.cancelButton.hidden = true;
        this.setState('Cancellation requested', 'The job will stop at the next safe checkpoint.', 0);
        this.setBusy(false);
    }

    private async readJson(response: Response): Promise<any> {
        let body: any = {};
        try {
            body = await response.json();
        } catch {
            // Use status below.
        }
        if (!response.ok) throw new Error(body.error || `Server returned ${response.status}`);
        return body;
    }
}

export { ReconstructionPanel };
