import { ProgressVisual, ReconstructionProgress } from './reconstruction-progress';
import { runControls, type Run, type RunAction, type RunState } from './reconstruction-run';
import {
    JobHeartbeatEvent,
    JobProgressEvent,
    ReconstructionPipeline,
    StageEvent
} from './reconstruction-types';

type PanelTab = 'create' | 'recent' | 'api';

type RunHandlers = {
    onSelect(id: string): void;
    onAction(id: string, action: RunAction): void;
    /** Whether this run's picked folder is still in hand, which decides resume vs re-pick. */
    hasFolder(id: string): boolean;
};

const RUN_ACTION_UI: Record<RunAction, {
    label: string; title: string; wide?: boolean; danger?: boolean;
}> = {
    pause: { label: '❚❚', title: 'Tạm dừng tải lên' },
    resume: { label: '▶', title: 'Tiếp tục tải lên' },
    repick: { label: 'Chọn lại thư mục', title: 'Chọn lại đúng thư mục cũ để tải tiếp', wide: true },
    cancel: { label: '✕', title: 'Huỷ luồng và xoá ảnh đã tải lên', danger: true },
    dismiss: { label: '✕', title: 'Bỏ luồng khỏi danh sách', danger: true },
    open: { label: 'Mở', title: 'Mở model', wide: true },
    retry: { label: 'Thử lại', title: 'Chạy lại luồng', wide: true }
};

const runDetail = (run: Run): string => (
    [run.percent > 0 && run.percent < 100 ? `${Math.round(run.percent)}%` : '', run.detail]
    .filter(Boolean).join(' · '));

const RUN_STATE_TEXT: Record<RunState, string> = {
    queued: 'Đang chờ tải',
    uploading: 'Đang tải lên',
    paused: 'Đã tạm dừng',
    quoting: 'Đang báo giá',
    'waiting-slot': 'Đang chờ lượt',
    running: 'Đang chạy',
    done: 'Hoàn tất',
    cancelled: 'Đã huỷ',
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
    readonly newRunButton: HTMLButtonElement;
    readonly composePanel: HTMLElement;
    readonly runFixed: HTMLElement;
    readonly runFixedTitle: HTMLElement;
    readonly runFixedDetail: HTMLElement;
    readonly artifactPanel: HTMLElement;
    readonly artifactTitle: HTMLElement;
    readonly artifactList: HTMLElement;
    readonly cacheUsageLabel: HTMLElement;
    readonly clearCacheButton: HTMLButtonElement;
    readonly tabButtons: HTMLButtonElement[];
    readonly apiStatus: HTMLElement;
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
            <section class="recon-runs" aria-label="Luồng của bạn" hidden>
                <div class="recon-section-heading">
                    <strong>Luồng của bạn</strong>
                    <span class="recon-runs-note"></span>
                    <button class="recon-button recon-primary recon-new-run" type="button" title="Bắt đầu một luồng mới với dataset và pipeline khác">＋ Luồng mới</button>
                </div>
                <div class="recon-run-list"></div>
            </section>
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
            <div class="recon-tabs" role="tablist" aria-label="Reconstruction">
                <button class="recon-tab active" type="button" role="tab" aria-selected="true" data-tab="create" aria-controls="recon-create-tab">Create model</button>
                <button class="recon-tab" type="button" role="tab" aria-selected="false" data-tab="recent" aria-controls="recon-recent-tab">Recent models</button>
                <button class="recon-tab" type="button" role="tab" aria-selected="false" data-tab="api" aria-controls="recon-api-tab">API</button>
            </div>
            <section id="recon-create-tab" class="recon-tab-panel" role="tabpanel">
                <div class="recon-run-fixed" hidden>
                    <strong class="recon-run-fixed-title"></strong>
                    <span class="recon-run-fixed-detail"></span>
                </div>
                <div class="recon-compose">
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
                </div>
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
            <section id="recon-api-tab" class="recon-tab-panel" role="tabpanel" hidden>
                <div class="recon-section-heading">
                    <strong>API key</strong>
                    <span>Dùng để gọi Genesis Point từ SDK hoặc curl. Giữ kín như mật khẩu.</span>
                </div>
                <p class="recon-api-status" role="status">
                    Tạo và thu hồi API key trong trang quản lý của Genesis Point.
                    Phiên đăng nhập này không tạo key nào.
                </p>
                <a class="recon-button recon-api-manage" target="_blank" rel="noopener"
                   href="https://recons.rtrobotics.com/?tab=api-keys">Mở trang quản lý API key</a>
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
        this.newRunButton = this.query('.recon-new-run');
        this.composePanel = this.query('.recon-compose');
        this.runFixed = this.query('.recon-run-fixed');
        this.runFixedTitle = this.query('.recon-run-fixed-title');
        this.runFixedDetail = this.query('.recon-run-fixed-detail');
        this.artifactPanel = this.query('.recon-artifacts');
        this.artifactTitle = this.query('.recon-artifact-title');
        this.artifactList = this.query('.recon-artifact-list');
        this.cacheUsageLabel = this.query('.recon-cache-usage');
        this.clearCacheButton = this.query('.recon-cache-clear');
        this.dropzone = this.query('.recon-dropzone');
        this.pipelineButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('.recon-pipeline-card'));
        this.pipelineDescription = this.query('.recon-pipeline-description');
        this.pipelineNote = this.query('.recon-note');
        this.tabButtons = Array.from(
            root.querySelectorAll<HTMLButtonElement>('.recon-tabs > .recon-tab'));
        this.apiStatus = this.query('.recon-api-status');
        this.folderInput.setAttribute('webkitdirectory', '');

        this.query('.recon-folder-button').addEventListener('click', () => this.folderInput.click());
        this.query('.recon-images-button').addEventListener('click', () => this.imageInput.click());
        for (const button of this.tabButtons) {
            button.addEventListener('click',
                () => this.setTab(button.dataset.tab as PanelTab));
        }

        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            root.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });
    }

    query<T extends HTMLElement = HTMLElement>(selector: string): T {
        return this.root.querySelector(selector) as T;
    }

    /**
     * Show either the pickers for a new run, or what the selected one already committed to.
     */
    showCompose(run: Run | null) {
        this.composePanel.hidden = run !== null;
        this.runFixed.hidden = run === null;
        if (!run) return;
        this.runFixedTitle.textContent = run.runName || run.preset;
        this.runFixedDetail.textContent = [
            run.pipeline === 'splat' ? '3D Gaussian Splatting' : 'Photogrammetry',
            run.datasetId ? `dataset ${run.datasetId}` : 'chưa có dataset'
        ].join(' · ');
    }

    setTab(tab: PanelTab) {
        for (const button of this.tabButtons) {
            const selected = button.dataset.tab === tab;
            button.classList.toggle('active', selected);
            button.setAttribute('aria-selected', String(selected));
            this.query(`#recon-${button.dataset.tab}-tab`).hidden = !selected;
        }
    }

    renderRuns(runs: Run[], selectedId: string | null, cap: number | null,
        handlers: RunHandlers) {
        this.runList.replaceChildren();
        for (const run of runs) {
            const row = document.createElement('div');
            row.className = 'recon-run-row';
            row.classList.toggle('active', run.id === selectedId);

            const select = document.createElement('button');
            select.type = 'button';
            select.className = 'recon-run-select';
            select.setAttribute('aria-pressed', String(run.id === selectedId));
            select.addEventListener('click', () => handlers.onSelect(run.id));

            const top = document.createElement('span');
            top.className = 'recon-run-top';
            const name = document.createElement('span');
            name.className = 'recon-run-name';
            name.textContent = run.runName || run.preset;
            const chip = document.createElement('span');
            chip.className = 'recon-run-chip';
            chip.textContent = run.pipeline === 'splat' ? '3DGS' : 'MESH';
            top.append(name, chip);

            const meta = document.createElement('span');
            meta.className = 'recon-run-meta';
            const state = document.createElement('span');
            state.className = 'recon-run-state';
            state.dataset.state = run.state;
            state.textContent = RUN_STATE_TEXT[run.state];
            meta.append(state);
            const detail = runDetail(run);
            if (detail) {
                const rest = document.createElement('span');
                rest.className = 'recon-run-detail';
                rest.textContent = detail;
                meta.append(rest);
            }

            select.append(top, meta);
            row.append(select);

            const controls = runControls(run, handlers.hasFolder(run.id));
            if (controls.length > 0) {
                const actions = document.createElement('div');
                actions.className = 'recon-run-actions';
                for (const action of controls) {
                    const ui = RUN_ACTION_UI[action];
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = `recon-button ${ui.wide ?
                        'recon-run-text-action' : 'recon-run-action'}`;
                    if (ui.danger) button.classList.add('recon-run-danger');
                    button.textContent = ui.label;
                    button.title = ui.title;
                    button.setAttribute('aria-label', ui.title);
                    button.addEventListener('click', () => handlers.onAction(run.id, action));
                    actions.append(button);
                }
                row.append(actions);
            }

            if (run.percent > 0 && run.percent < 100) {
                const bar = document.createElement('div');
                bar.className = 'recon-run-bar';
                const fill = document.createElement('i');
                fill.style.width = `${Math.min(100, run.percent)}%`;
                bar.append(fill);
                row.append(bar);
            }

            this.runList.appendChild(row);
        }
        const running = runs.filter(run => run.state === 'running').length;
        const parked = runs.some(run => run.state === 'waiting-slot');
        this.runsNote.textContent = parked && cap !== null ?
            `Gói đăng ký hiện tại chỉ cho phép ${cap} luồng cùng lúc` :
            running > 0 ? `${running} luồng đang chạy` : '';
        this.runsPanel.hidden = runs.length === 0;
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

    resetStartLabel() {
        this.startButton.textContent = this.pipeline === 'splat' ?
            'Create Gaussian Splat' :
            'Create textured mesh';
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
        this.resetStartLabel();
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
export type { PanelTab };
