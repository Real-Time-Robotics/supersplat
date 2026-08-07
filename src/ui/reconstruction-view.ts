import { ProgressVisual, ReconstructionProgress } from './reconstruction-progress';
import type { Run, RunState } from './reconstruction-run';
import {
    JobHeartbeatEvent,
    JobProgressEvent,
    ReconstructionPipeline,
    StageEvent
} from './reconstruction-types';

const RUN_STATE_TEXT: Record<RunState, string> = {
    uploading: 'Đang tải lên',
    paused: 'Đã tạm dừng',
    quoting: 'Đang báo giá',
    'waiting-slot': 'Đang chờ lượt',
    running: 'Đang chạy',
    done: 'Hoàn tất',
    failed: 'Thất bại'
};

class ReconstructionView {
    readonly authPanel: HTMLElement;
    readonly appPanel: HTMLElement;
    readonly accountLabel: HTMLElement;
    readonly fileSummary: HTMLElement;
    readonly creditValue: HTMLElement;
    readonly startButton: HTMLButtonElement;
    readonly cancelButton: HTMLButtonElement;
    readonly openPrimaryButton: HTMLButtonElement;
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
    readonly runsPanel: HTMLElement;
    readonly runList: HTMLElement;
    readonly runsNote: HTMLElement;
    readonly artifactPanel: HTMLElement;
    readonly artifactTitle: HTMLElement;
    readonly artifactList: HTMLElement;
    readonly cacheUsageLabel: HTMLElement;
    readonly clearCacheButton: HTMLButtonElement;
    readonly createTabButton: HTMLButtonElement;
    readonly recentTabButton: HTMLButtonElement;
    readonly createTabPanel: HTMLElement;
    readonly recentTabPanel: HTMLElement;
    readonly dropzone: HTMLDivElement;
    readonly pipelineButtons: HTMLButtonElement[];
    readonly pipelineDescription: HTMLElement;
    readonly pipelineNote: HTMLElement;
    readonly progress: ReconstructionProgress;
    private pipeline: ReconstructionPipeline = 'splat';

    constructor(readonly root: HTMLElement) {
        const body = document.createElement('div');
        body.className = 'recon-body blocks-shortcuts';
        body.innerHTML = `
            <section class="recon-auth" aria-label="Genesis Reconstruction account">
                <div class="recon-auth-hero">
                    <div class="recon-auth-brand">
                        <strong>Genesis Reconstruction</strong>
                        <span>Turn your photos into a production-ready 3D model.</span>
                    </div>
                </div>
                <div class="recon-auth-tabs" role="tablist" aria-label="Account access">
                    <button class="recon-auth-tab active" type="button" role="tab" data-auth-tab="login" aria-selected="true">Log in</button>
                    <button class="recon-auth-tab" type="button" role="tab" data-auth-tab="register" aria-selected="false">Register</button>
                    <button class="recon-auth-tab" type="button" role="tab" data-auth-tab="api-key" aria-selected="false">API key</button>
                </div>
                <div class="recon-auth-stage">
                    <form class="recon-auth-form" data-auth-form="login">
                        <label>Email<input name="email" type="email" autocomplete="username" minlength="3" maxlength="255" required></label>
                        <label>Password<input name="password" type="password" autocomplete="current-password" maxlength="256" required></label>
                        <button class="recon-button recon-primary" type="submit">Log in</button>
                    </form>
                    <form class="recon-auth-form" data-auth-form="register" hidden>
                        <div class="recon-auth-names">
                            <label>First Name<input name="firstName" autocomplete="given-name" maxlength="100" required></label>
                            <label>Last Name<input name="lastName" autocomplete="family-name" maxlength="100" required></label>
                        </div>
                        <label>Email<input name="email" type="email" autocomplete="username" minlength="3" maxlength="255" required></label>
                        <label>Password<input name="password" type="password" autocomplete="new-password" minlength="6" maxlength="256" required></label>
                        <label>Confirm Password<input name="confirmPassword" type="password" autocomplete="new-password" minlength="6" maxlength="256" required></label>
                        <button class="recon-button recon-primary" type="submit">Create account</button>
                    </form>
                    <form class="recon-auth-form" data-auth-form="api-key" hidden>
                        <label>Genesis API key
                            <span class="recon-auth-secret-input">
                                <input name="apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="gp_live_..." required>
                                <button class="recon-auth-reveal" type="button" aria-label="Show API key">Show</button>
                            </span>
                        </label>
                        <p>Use an existing key without logging in. It stays in this server session and is never saved in the browser.</p>
                        <button class="recon-button recon-primary" type="submit">Continue with API key</button>
                    </form>
                    <div class="recon-auth-created" hidden>
                        <strong>Your SuperSplat API key</strong>
                        <p>This key is shown once. Copy it before continuing.</p>
                        <div><code></code><button class="recon-button recon-copy-key" type="button">Copy</button></div>
                        <button class="recon-button recon-primary recon-auth-continue" type="button">Continue</button>
                    </div>
                </div>
                <p class="recon-auth-status" role="status"></p>
            </section>
            <div class="recon-app" hidden>
            <section class="recon-account">
                <span>Signed in as <strong class="recon-account-label"></strong></span>
                <button class="recon-button recon-sign-out" type="button">Forget on this device</button>
            </section>
            <div class="recon-intro">
                <strong>Images to 3D model</strong>
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
                    <button class="recon-button recon-primary recon-open-primary" type="button" hidden>Open model now</button>
                    <button class="recon-button recon-cancel" type="button" hidden>Cancel</button>
                </div>
            </section>
            <section class="recon-runs" aria-label="Các luồng đang chạy" hidden>
                <div class="recon-section-heading">
                    <strong>Các luồng đang chạy</strong>
                    <span class="recon-runs-note"></span>
                </div>
                <div class="recon-run-list"></div>
            </section>
            <section id="recon-create-tab" class="recon-tab-panel" role="tabpanel">
                <section class="recon-pipeline-picker" aria-labelledby="recon-pipeline-heading">
                    <div class="recon-section-heading">
                        <strong id="recon-pipeline-heading">Choose a reconstruction pipeline</strong>
                        <span class="recon-pipeline-description">Editable Gaussian Splat for fast browser viewing.</span>
                    </div>
                    <div class="recon-pipeline-options" role="radiogroup" aria-label="Reconstruction pipeline">
                        <button class="recon-pipeline-card active" type="button" role="radio" aria-checked="true" data-pipeline="splat">
                            <span class="recon-pipeline-mark">3DGS</span>
                            <span class="recon-pipeline-copy">
                                <strong>3D Gaussian Splatting</strong>
                                <small>Fast, editable scene for SuperSplat</small>
                            </span>
                            <span class="recon-pipeline-check" aria-hidden="true">&#10003;</span>
                        </button>
                        <button class="recon-pipeline-card" type="button" role="radio" aria-checked="false" data-pipeline="photogrammetry">
                            <span class="recon-pipeline-mark">MESH</span>
                            <span class="recon-pipeline-copy">
                                <strong>Photogrammetry</strong>
                                <small>GPS-aligned mesh, orthophoto and DSM</small>
                            </span>
                            <span class="recon-pipeline-check" aria-hidden="true">&#10003;</span>
                        </button>
                    </div>
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
                            <span>Reuse source images, open completed models, or delete a dataset</span>
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
                    <div class="recon-cache-row">
                        <span class="recon-cache-usage">Bộ nhớ đệm: —</span>
                        <button type="button" class="recon-cache-clear" disabled>Xoá tất cả</button>
                    </div>
                </section>
            </section>
            </div>`;
        root.appendChild(body);

        this.authPanel = this.query('.recon-auth');
        this.appPanel = this.query('.recon-app');
        this.accountLabel = this.query('.recon-account-label');
        this.fileSummary = this.query('.recon-file-summary');
        this.creditValue = this.query('.recon-credit-value');
        this.progress = new ReconstructionProgress(root);
        this.startButton = this.query('.recon-start');
        this.cancelButton = this.query('.recon-cancel');
        this.openPrimaryButton = this.query('.recon-open-primary');
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
        this.runsPanel = this.query('.recon-runs');
        this.runList = this.query('.recon-run-list');
        this.runsNote = this.query('.recon-runs-note');
        this.artifactPanel = this.query('.recon-artifacts');
        this.artifactTitle = this.query('.recon-artifact-title');
        this.artifactList = this.query('.recon-artifact-list');
        this.cacheUsageLabel = this.query('.recon-cache-usage');
        this.clearCacheButton = this.query('.recon-cache-clear');
        this.dropzone = this.query('.recon-dropzone');
        this.pipelineButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('.recon-pipeline-card'));
        this.pipelineDescription = this.query('.recon-pipeline-description');
        this.pipelineNote = this.query('.recon-note');
        const tabs = root.querySelectorAll<HTMLButtonElement>('.recon-tabs > .recon-tab');
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

    renderRuns(runs: Run[], selectedId: string | null, onSelect: (id: string) => void) {
        this.runList.replaceChildren();
        for (const run of runs) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'recon-run-row';
            row.classList.toggle('active', run.id === selectedId);
            row.setAttribute('aria-pressed', String(run.id === selectedId));

            const label = document.createElement('span');
            label.className = 'recon-run-label';
            label.textContent = run.label;
            const pipeline = document.createElement('span');
            pipeline.className = 'recon-run-pipeline';
            pipeline.textContent = run.pipeline === 'splat' ? '3DGS' : 'MESH';
            const state = document.createElement('span');
            state.className = 'recon-run-state';
            state.dataset.state = run.state;
            state.textContent = RUN_STATE_TEXT[run.state];
            state.title = run.detail;
            const percent = document.createElement('span');
            percent.className = 'recon-run-percent';
            percent.textContent = run.percent > 0 ? `${Math.round(run.percent)}%` : '';

            row.append(label, pipeline, state, percent);
            row.addEventListener('click', () => onSelect(run.id));
            this.runList.appendChild(row);
        }
        this.runsPanel.hidden = runs.length === 0;
    }

    setRunsNote(note: string) {
        this.runsNote.textContent = note;
    }

    showAuth() {
        this.authPanel.hidden = false;
        this.appPanel.hidden = true;
    }

    showApp(accountLabel: string) {
        this.accountLabel.textContent = accountLabel;
        this.authPanel.hidden = true;
        this.appPanel.hidden = false;
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
        this.startButton.textContent = retryable ?
            'Retry reconstruction' :
            this.pipeline === 'splat' ? 'Create Gaussian Splat' : 'Create textured mesh';
    }

    setPipeline(pipeline: ReconstructionPipeline) {
        this.pipeline = pipeline;
        for (const button of this.pipelineButtons) {
            const selected = button.dataset.pipeline === pipeline;
            button.classList.toggle('active', selected);
            button.setAttribute('aria-checked', String(selected));
        }
        if (pipeline === 'photogrammetry') {
            this.pipelineDescription.textContent =
                'GPS-aligned textured mesh with orthophoto and DSM deliverables.';
            this.pipelineNote.textContent =
                'Photogrammetry uses the Standard preset and requires EXIF GPS in at least three source photos.';
        } else {
            this.pipelineDescription.textContent = 'Editable Gaussian Splat for fast browser viewing.';
            this.pipelineNote.textContent =
                'Credits are only held once the job starts. Completed artifacts remain available in Recent models.';
        }
        this.setRetryAvailable(false);
    }

    setBusy(busy: boolean, canStart: boolean) {
        this.startButton.disabled = busy || !canStart;
        this.imageInput.disabled = busy;
        this.folderInput.disabled = busy;
        for (const button of this.pipelineButtons) button.disabled = busy;
        this.root.querySelectorAll<HTMLButtonElement>('.recon-run, .recon-use-dataset, .recon-delete-dataset')
        .forEach((button) => {
            button.disabled = busy;
        });
    }
}

export { ReconstructionView };
