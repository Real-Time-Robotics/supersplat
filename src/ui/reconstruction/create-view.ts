import { UploadList } from './upload-list';

type ModelSource = 'upload' | 'dataset';

/**
 * The Create tab: pick a pipeline, pick a source, watch the ring, then the per-run list.
 */
class CreateView {
    readonly root: HTMLElement;
    readonly runFixed: HTMLElement;
    readonly runFixedTitle: HTMLElement;
    readonly runFixedDetail: HTMLElement;
    readonly composePanel: HTMLElement;
    readonly composeFooter: HTMLElement;
    readonly sourceButtons: HTMLButtonElement[];
    readonly pipelineButtons: HTMLButtonElement[];
    readonly pipelineDescription: HTMLElement;
    readonly pipelineNote: HTMLElement;
    readonly dropzone: HTMLDivElement;
    readonly folderInput: HTMLInputElement;
    readonly imageInput: HTMLInputElement;
    readonly fileSummary: HTMLElement;
    readonly recentRuns: HTMLElement;
    readonly refreshRunsButton: HTMLButtonElement;
    readonly startButton: HTMLButtonElement;
    readonly cancelButton: HTMLButtonElement;
    readonly openPrimaryButton: HTMLButtonElement;
    readonly checkoutLink: HTMLAnchorElement;
    readonly uploads: UploadList;
    private panes: HTMLElement[];

    constructor(host: HTMLElement) {
        const root = document.createElement('section');
        root.id = 'recon-create-tab';
        root.className = 'recon-tab-panel';
        root.setAttribute('role', 'tabpanel');
        root.innerHTML = `
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
                    <div class="recon-pipeline-options" role="radiogroup"
                         aria-label="Reconstruction pipeline">
                        <button class="recon-pipeline-card active" type="button" role="radio"
                                aria-checked="true" data-pipeline="splat">
                            <span class="recon-pipeline-mark">3DGS</span>
                            <span class="recon-pipeline-copy">
                                <strong>3D Gaussian Splatting</strong>
                                <small>Fast, editable scene for SuperSplat</small>
                            </span>
                            <span class="recon-pipeline-check" aria-hidden="true">&#10003;</span>
                        </button>
                        <button class="recon-pipeline-card" type="button" role="radio"
                                aria-checked="false" data-pipeline="photogrammetry">
                            <span class="recon-pipeline-mark">MESH</span>
                            <span class="recon-pipeline-copy">
                                <strong>Photogrammetry</strong>
                                <small>GPS-aligned mesh, orthophoto and DSM</small>
                            </span>
                            <span class="recon-pipeline-check" aria-hidden="true">&#10003;</span>
                        </button>
                    </div>
                </section>
                <section class="recon-source-picker" aria-labelledby="recon-source-heading">
                    <div class="recon-section-heading">
                        <strong id="recon-source-heading">Choose where the images come from</strong>
                    </div>
                    <div class="recon-source-options" role="radiogroup" aria-label="Image source">
                        <button class="recon-source-card active" type="button" role="radio"
                                aria-checked="true" data-source="upload"
                                aria-controls="recon-source-upload">
                            <span class="recon-source-copy">
                                <strong>Upload images</strong>
                                <small>Pick a folder or images from this device</small>
                            </span>
                            <span class="recon-source-check" aria-hidden="true">&#10003;</span>
                        </button>
                        <button class="recon-source-card" type="button" role="radio"
                                aria-checked="false" data-source="dataset"
                                aria-controls="recon-source-dataset">
                            <span class="recon-source-copy">
                                <strong>Use R2 dataset</strong>
                                <small>Reuse images already uploaded</small>
                            </span>
                            <span class="recon-source-check" aria-hidden="true">&#10003;</span>
                        </button>
                    </div>
                </section>
                <div class="recon-source-pane" id="recon-source-upload" data-source="upload">
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
                </div>
                <div class="recon-source-pane" id="recon-source-dataset" data-source="dataset" hidden>
                    <div class="recon-recent-heading">
                        <div>
                            <strong>Recent datasets</strong>
                            <span>Reuse source images, or delete a dataset you no longer need</span>
                        </div>
                        <button class="recon-button recon-refresh-runs" type="button"
                                aria-label="Refresh recent datasets">↻</button>
                    </div>
                    <div class="recon-recent-list"><span>Loading…</span></div>
                </div>
                <div class="recon-file-summary">No images selected</div>
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
            <footer class="recon-footer">
                <button class="recon-button recon-primary recon-start" type="button" disabled>Create Gaussian Splat</button>
                <p class="recon-note">Credits are only held once the job starts. Completed artifacts remain available in Artifacts.</p>
            </footer>`;
        host.appendChild(root);

        this.root = root;
        this.runFixed = root.querySelector('.recon-run-fixed');
        this.runFixedTitle = root.querySelector('.recon-run-fixed-title');
        this.runFixedDetail = root.querySelector('.recon-run-fixed-detail');
        this.composePanel = root.querySelector('.recon-compose');
        this.composeFooter = root.querySelector('.recon-footer');
        this.sourceButtons = Array.from(
            root.querySelectorAll<HTMLButtonElement>('.recon-source-card'));
        this.pipelineButtons = Array.from(
            root.querySelectorAll<HTMLButtonElement>('.recon-pipeline-card'));
        this.pipelineDescription = root.querySelector('.recon-pipeline-description');
        this.pipelineNote = root.querySelector('.recon-note');
        this.dropzone = root.querySelector('.recon-dropzone');
        this.folderInput = root.querySelector('.recon-folder-input');
        this.imageInput = root.querySelector('.recon-image-input');
        this.fileSummary = root.querySelector('.recon-file-summary');
        this.recentRuns = root.querySelector('.recon-recent-list');
        this.refreshRunsButton = root.querySelector('.recon-refresh-runs');
        this.startButton = root.querySelector('.recon-start');
        this.cancelButton = root.querySelector('.recon-cancel');
        this.openPrimaryButton = root.querySelector('.recon-open-primary');
        this.checkoutLink = root.querySelector('.recon-checkout');
        this.panes = Array.from(root.querySelectorAll<HTMLElement>('.recon-source-pane'));

        this.folderInput.setAttribute('webkitdirectory', '');
        root.querySelector('.recon-folder-button')
        .addEventListener('click', () => this.folderInput.click());
        root.querySelector('.recon-images-button')
        .addEventListener('click', () => this.imageInput.click());
        for (const button of this.sourceButtons) {
            button.addEventListener('click',
                () => this.setSource(button.dataset.source as ModelSource));
        }

        this.uploads = new UploadList(root);
        root.insertBefore(this.uploads.root, this.composeFooter);
    }

    /**
     * Swaps the picker only.
     */
    setSource(source: ModelSource) {
        for (const button of this.sourceButtons) {
            const selected = button.dataset.source === source;
            button.classList.toggle('active', selected);
            button.setAttribute('aria-checked', String(selected));
        }
        for (const pane of this.panes) pane.hidden = pane.dataset.source !== source;
    }

    /** A run in flight replaces the composer: its dataset and pipeline are already fixed. */
    showCompose(visible: boolean) {
        this.composePanel.hidden = !visible;
        this.composeFooter.hidden = !visible;
        this.runFixed.hidden = visible;
    }
}

export { CreateView };
export type { ModelSource };
