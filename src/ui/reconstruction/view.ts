import { ProgressVisual, ReconstructionProgress } from './progress';
import type { Run } from './run';
import type {
    JobHeartbeatEvent,
    JobProgressEvent,
    ReconstructionPipeline,
    StageEvent
} from './types';
import type { TransferRate } from './upload-rate';
import { ArtifactsView } from './views/artifacts';
import { AuthView } from './views/auth';
import { CreateView } from './views/create';
import { SettingsView } from './views/settings';
import { DashboardShell, type DashboardTab } from './views/shell';
import type { RunHandlers } from './views/upload-list';

type PanelTab = DashboardTab;

/**
 * Composition root for the reconstruction dashboard. Builds the shell and the three tab
 * views, then re-exposes the elements the behaviour modules (auth, billing, artifacts,
 * workflow) bind to. Those modules address the DOM through these fields and through
 * {@link query}, so every name here is contract.
 */
class ReconstructionView {
    private readonly shell: DashboardShell;
    private readonly auth: AuthView;
    private readonly create: CreateView;
    private readonly artifacts: ArtifactsView;
    private readonly settings: SettingsView;
    readonly progress: ReconstructionProgress;
    private pipeline: ReconstructionPipeline = 'splat';

    constructor(readonly root: HTMLElement) {
        this.shell = new DashboardShell(root);
        this.auth = new AuthView(this.shell.root);
        this.shell.root.insertBefore(this.auth.root,
            this.shell.root.querySelector('.recon-main'));

        this.create = new CreateView(this.shell.stage);
        this.artifacts = new ArtifactsView(this.shell.stage);
        this.settings = new SettingsView(this.shell.stage);
        this.progress = new ReconstructionProgress(root);

        this.shell.closeButton.addEventListener('click',
            () => root.dispatchEvent(new CustomEvent('reconClose', { bubbles: true })));

        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            root.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });
    }

    query<T extends HTMLElement = HTMLElement>(selector: string): T {
        return this.root.querySelector(selector) as T;
    }

    // -- shell ---------------------------------------------------------------

    get title() {
        return this.shell.title;
    }

    get creditValue() {
        return this.shell.creditValue;
    }

    get buyCreditsButton() {
        return this.shell.buyCreditsButton;
    }

    get pricingPanel() {
        return this.shell.pricingPanel;
    }

    get pricingPacks() {
        return this.shell.pricingPacks;
    }

    get pricingNote() {
        return this.shell.pricingNote;
    }

    get purchaseStatus() {
        return this.shell.purchaseStatus;
    }

    get purchaseCheckoutLink() {
        return this.shell.purchaseCheckoutLink;
    }

    get customCreditsInput() {
        return this.shell.customCreditsInput;
    }

    get customPrice() {
        return this.shell.customPrice;
    }

    // -- auth ----------------------------------------------------------------

    get authPanel() {
        return this.auth.root;
    }

    get appPanel() {
        return this.shell.root.querySelector<HTMLElement>('.recon-main');
    }

    get accountLabel() {
        return this.settings.accountLabel;
    }

    // -- create --------------------------------------------------------------

    get startButton() {
        return this.create.startButton;
    }

    get cancelButton() {
        return this.create.cancelButton;
    }

    get openPrimaryButton() {
        return this.create.openPrimaryButton;
    }

    get checkoutLink() {
        return this.create.checkoutLink;
    }

    get imageInput() {
        return this.create.imageInput;
    }

    get folderInput() {
        return this.create.folderInput;
    }

    get dropzone() {
        return this.create.dropzone;
    }

    get fileSummary() {
        return this.create.fileSummary;
    }

    get pipelineButtons() {
        return this.create.pipelineButtons;
    }

    get pipelineDescription() {
        return this.create.pipelineDescription;
    }

    get pipelineNote() {
        return this.create.pipelineNote;
    }

    get recentRuns() {
        return this.create.recentRuns;
    }

    /** Both tabs list datasets and both can refresh, so this is a set, not one button. */
    get refreshRunsButtons() {
        return [this.create.refreshRunsButton, this.artifacts.refreshButton];
    }

    get newRunButton() {
        return this.create.uploads.newRunButton;
    }

    // -- artifacts -----------------------------------------------------------

    /** The dataset/job tree in Artifacts, as opposed to the flat picker in Create. */
    get datasetTree() {
        return this.artifacts.treeList;
    }

    get artifactPanel() {
        return this.artifacts.artifactPanel;
    }

    get artifactTitle() {
        return this.artifacts.artifactTitle;
    }

    get artifactList() {
        return this.artifacts.artifactList;
    }

    get downloadCancelButton() {
        return this.artifacts.downloadCancel;
    }

    get cacheUsageLabel() {
        return this.artifacts.cacheUsageLabel;
    }

    get clearCacheButton() {
        return this.artifacts.clearCacheButton;
    }

    // -- behaviour -----------------------------------------------------------

    showCompose(run: Run | null) {
        this.create.showCompose(run === null);
        if (!run) return;
        this.create.runFixedTitle.textContent = run.runName || run.preset;
        this.create.runFixedDetail.textContent = [
            run.pipeline === 'splat' ? '3D Gaussian Splatting' : 'Photogrammetry',
            run.datasetId ? `dataset ${run.datasetId}` : 'chưa có dataset'
        ].join(' · ');
    }

    setTab(tab: PanelTab) {
        this.shell.setTab(tab);
    }

    renderRuns(runs: Run[], selectedId: string | null, cap: number | null,
        handlers: RunHandlers) {
        this.create.uploads.render(runs, selectedId, cap, handlers);
    }

    /** One upload progress tick, written into the run's row without rebuilding it. */
    setTransfer(runId: string, rate: TransferRate) {
        this.create.uploads.setTransfer(runId, rate);
    }

    /** One artifact download tick. */
    setDownload(title: string, detail: string, visual: ProgressVisual) {
        this.artifacts.setDownload(title, detail, visual);
    }

    hideDownload() {
        this.artifacts.hideDownload();
    }

    showAuth() {
        this.auth.root.hidden = false;
        this.appPanel.hidden = true;
        this.shell.setSignedIn(false);
    }

    showApp(accountLabel: string) {
        this.settings.accountLabel.textContent = accountLabel;
        this.auth.root.hidden = true;
        this.appPanel.hidden = false;
        this.shell.setSignedIn(true);
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
        this.create.startButton.textContent = this.pipeline === 'splat' ?
            'Create Gaussian Splat' :
            'Create textured mesh';
    }

    setPipeline(pipeline: ReconstructionPipeline) {
        this.pipeline = pipeline;
        for (const button of this.create.pipelineButtons) {
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
                'Credits are only held once the job starts. Completed artifacts remain available in Artifacts.';
        }
        this.resetStartLabel();
    }

    setBusy(busy: boolean, canStart: boolean) {
        this.create.startButton.disabled = busy || !canStart;
        this.create.imageInput.disabled = busy;
        this.create.folderInput.disabled = busy;
        for (const button of this.create.pipelineButtons) button.disabled = busy;
        for (const button of this.create.sourceButtons) button.disabled = busy;
        this.root.querySelectorAll<HTMLButtonElement>('.recon-run, .recon-use-dataset, .recon-delete-dataset')
        .forEach((button) => {
            button.disabled = busy;
        });
    }
}

export { ReconstructionView };
export type { PanelTab };
