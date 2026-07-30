import { ProgressVisual, ReconstructionProgress } from './reconstruction-progress';
import {
    JobHeartbeatEvent,
    JobProgressEvent,
    StageEvent
} from './reconstruction-types';

class ReconstructionView {
    readonly fileSummary: HTMLElement;
    readonly creditValue: HTMLElement;
    readonly startButton: HTMLButtonElement;
    readonly cancelButton: HTMLButtonElement;
    readonly checkoutLink: HTMLAnchorElement;
    readonly imageInput: HTMLInputElement;
    readonly folderInput: HTMLInputElement;
    readonly buyCreditsButton: HTMLButtonElement;
    readonly pricingPanel: HTMLElement;
    readonly pricingPacks: HTMLElement;
    readonly pricingNote: HTMLElement;
    readonly purchaseStatus: HTMLElement;
    readonly purchaseCheckoutLink: HTMLAnchorElement;
    readonly customCreditsInput: HTMLInputElement;
    readonly customPrice: HTMLElement;
    readonly recentRuns: HTMLElement;
    readonly refreshRunsButton: HTMLButtonElement;
    readonly artifactPanel: HTMLElement;
    readonly artifactTitle: HTMLElement;
    readonly artifactList: HTMLElement;
    readonly createTabButton: HTMLButtonElement;
    readonly recentTabButton: HTMLButtonElement;
    readonly createTabPanel: HTMLElement;
    readonly recentTabPanel: HTMLElement;
    readonly dropzone: HTMLDivElement;
    readonly progress: ReconstructionProgress;

    constructor(readonly root: HTMLElement) {
        const body = document.createElement('div');
        body.className = 'recon-body blocks-shortcuts';
        body.innerHTML = `
            <div class="recon-intro">
                <strong>Images to Gaussian Splat</strong>
            </div>
            <section class="recon-credit">
                <div class="recon-credit-balance">
                    <i></i>
                    <strong>Credit: <span class="recon-credit-value">—</span></strong>
                </div>
                <button class="recon-button recon-buy-credits" type="button" aria-expanded="false">Buy Credit</button>
            </section>
            <section class="recon-pricing" aria-hidden="true">
                <div class="recon-section-heading">
                    <strong>Buy PAYG credits</strong>
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
                <a class="recon-purchase-checkout" target="reconstruction-checkout" rel="noopener" hidden>Reopen checkout ↗</a>
            </section>
            <div class="recon-tabs" role="tablist" aria-label="Reconstruction">
                <button class="recon-tab active" type="button" role="tab" aria-selected="true" aria-controls="recon-create-tab">Create model</button>
                <button class="recon-tab" type="button" role="tab" aria-selected="false" aria-controls="recon-recent-tab">Recent models</button>
            </div>
            <section class="recon-shared-progress">
                <div class="recon-progress-card" data-mode="idle">
                    <div class="recon-progress-ring" role="progressbar" aria-label="Ready">
                        <svg viewBox="0 0 44 44" aria-hidden="true">
                            <circle class="recon-progress-track" cx="22" cy="22" r="18" pathLength="100"></circle>
                            <circle class="recon-progress-value" cx="22" cy="22" r="18" pathLength="100"></circle>
                            <circle class="recon-progress-activity" cx="22" cy="22" r="18" pathLength="100"></circle>
                        </svg>
                        <strong class="recon-progress-center">—</strong>
                    </div>
                    <div class="recon-state">
                        <strong class="recon-status">Ready</strong>
                        <span class="recon-status-detail">Choose a set of photos captured around an object or space.</span>
                        <span class="recon-worker-status" role="status" hidden>
                            <i></i>
                            <span></span>
                        </span>
                    </div>
                </div>
                <a class="recon-checkout" target="reconstruction-checkout" rel="noopener" hidden>Open checkout ↗</a>
                <div class="recon-shared-actions">
                    <button class="recon-button recon-cancel" type="button" hidden>Cancel</button>
                </div>
            </section>
            <section id="recon-create-tab" class="recon-tab-panel" role="tabpanel">
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
                <footer class="recon-footer">
                    <button class="recon-button recon-primary recon-start" type="button" disabled>Create Gaussian Splat</button>
                </footer>
                <p class="recon-note">Credits are only held once the job starts. Completed artifacts remain available in Recent models.</p>
            </section>
            <section id="recon-recent-tab" class="recon-tab-panel" role="tabpanel" hidden>
                <section class="recon-recent">
                    <div class="recon-recent-heading">
                        <div>
                            <strong>Recent datasets</strong>
                            <span>Open completed models or permanently delete a dataset</span>
                        </div>
                        <button class="recon-button recon-refresh-runs" type="button" aria-label="Refresh recent models">↻</button>
                    </div>
                    <div class="recon-recent-list"><span>Loading…</span></div>
                </section>
                <section class="recon-artifacts" hidden>
                    <div class="recon-artifact-heading">
                        <strong>Available artifacts</strong>
                        <span class="recon-artifact-title"></span>
                    </div>
                    <div class="recon-artifact-list"></div>
                </section>
            </section>`;
        root.appendChild(body);

        this.fileSummary = this.query('.recon-file-summary');
        this.creditValue = this.query('.recon-credit-value');
        this.progress = new ReconstructionProgress(root);
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
        this.recentRuns = this.query('.recon-recent-list');
        this.refreshRunsButton = this.query('.recon-refresh-runs');
        this.artifactPanel = this.query('.recon-artifacts');
        this.artifactTitle = this.query('.recon-artifact-title');
        this.artifactList = this.query('.recon-artifact-list');
        this.dropzone = this.query('.recon-dropzone');
        const tabs = root.querySelectorAll<HTMLButtonElement>('.recon-tab');
        this.createTabButton = tabs[0];
        this.recentTabButton = tabs[1];
        this.createTabPanel = this.query('#recon-create-tab');
        this.recentTabPanel = this.query('#recon-recent-tab');
        this.folderInput.setAttribute('webkitdirectory', '');

        this.query('.recon-folder-button').addEventListener('click', () => this.folderInput.click());
        this.query('.recon-images-button').addEventListener('click', () => this.imageInput.click());
        this.createTabButton.addEventListener('click', () => this.setTab('create'));
        this.recentTabButton.addEventListener('click', () => this.setTab('recent'));

        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            root.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });
    }

    query<T extends HTMLElement = HTMLElement>(selector: string): T {
        return this.root.querySelector(selector) as T;
    }

    setTab(tab: 'create' | 'recent') {
        const create = tab === 'create';
        this.createTabButton.classList.toggle('active', create);
        this.recentTabButton.classList.toggle('active', !create);
        this.createTabButton.setAttribute('aria-selected', String(create));
        this.recentTabButton.setAttribute('aria-selected', String(!create));
        this.createTabPanel.hidden = !create;
        this.recentTabPanel.hidden = create;
    }

    setState(title: string, detail: string, visual: ProgressVisual = { mode: 'idle' }) {
        this.progress.set(title, detail, visual);
    }

    setStage(stage: StageEvent) {
        this.progress.setStage(stage);
    }

    setStageProgress(progress: JobProgressEvent) {
        this.progress.setStageProgress(progress);
    }

    setWorkerStatus(heartbeat: JobHeartbeatEvent | null) {
        this.progress.setWorkerStatus(heartbeat);
    }

    setRetryAvailable(retryable: boolean) {
        this.startButton.textContent = retryable ? 'Retry reconstruction' : 'Create Gaussian Splat';
    }

    setBusy(busy: boolean, canStart: boolean) {
        this.startButton.disabled = busy || !canStart;
        this.imageInput.disabled = busy;
        this.folderInput.disabled = busy;
        this.root.querySelectorAll<HTMLButtonElement>('.recon-run, .recon-delete-dataset')
        .forEach((button) => {
            button.disabled = busy;
        });
    }
}

export { ReconstructionView };
