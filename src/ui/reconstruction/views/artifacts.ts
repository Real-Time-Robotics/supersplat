import type { ProgressVisual } from '../progress';

/**
 * The Artifacts tab: datasets, the jobs each one produced, and the files of whichever
 * job is open. Create only picks a dataset; the whole tree lives here.
 */
class ArtifactsView {
    readonly root: HTMLElement;
    readonly treeList: HTMLElement;
    readonly refreshButton: HTMLButtonElement;
    readonly artifactPanel: HTMLElement;
    readonly artifactTitle: HTMLElement;
    readonly artifactList: HTMLElement;
    readonly downloadPanel: HTMLElement;
    readonly downloadName: HTMLElement;
    readonly downloadStats: HTMLElement;
    readonly downloadBar: HTMLElement;
    readonly downloadCancel: HTMLButtonElement;
    readonly cacheUsageLabel: HTMLElement;
    readonly clearCacheButton: HTMLButtonElement;

    constructor(host: HTMLElement) {
        const root = document.createElement('section');
        root.id = 'recon-artifacts-tab';
        root.className = 'recon-tab-panel';
        root.setAttribute('role', 'tabpanel');
        root.hidden = true;
        root.innerHTML = `
            <div class="recon-recent-heading">
                <div>
                    <strong>Datasets and models</strong>
                    <span>Open a dataset to see its jobs, then a job to list its files</span>
                </div>
                <button class="recon-button recon-refresh-runs" type="button"
                        aria-label="Refresh datasets">↻</button>
            </div>
            <div class="recon-tree-list"><span>Loading…</span></div>
            <section class="recon-artifacts" hidden>
                <div class="recon-artifact-heading">
                    <strong>Available artifacts</strong>
                    <span class="recon-artifact-title"></span>
                </div>
                <div class="recon-download" data-mode="idle" hidden>
                    <div class="recon-download-head">
                        <strong class="recon-download-name"></strong>
                        <button class="recon-button recon-download-cancel" type="button"
                                hidden>Huỷ</button>
                    </div>
                    <span class="recon-download-bar"><i></i></span>
                    <span class="recon-download-stats"></span>
                </div>
                <div class="recon-artifact-list"></div>
            </section>
            <div class="recon-cache-row">
                <span class="recon-cache-usage">Bộ nhớ đệm: —</span>
                <button type="button" class="recon-cache-clear" disabled>Xoá tất cả</button>
            </div>`;
        host.appendChild(root);

        this.root = root;
        this.treeList = root.querySelector('.recon-tree-list');
        this.refreshButton = root.querySelector('.recon-refresh-runs');
        this.artifactPanel = root.querySelector('.recon-artifacts');
        this.artifactTitle = root.querySelector('.recon-artifact-title');
        this.artifactList = root.querySelector('.recon-artifact-list');
        this.downloadPanel = root.querySelector('.recon-download');
        this.downloadName = root.querySelector('.recon-download-name');
        this.downloadStats = root.querySelector('.recon-download-stats');
        this.downloadBar = root.querySelector('.recon-download-bar i');
        this.downloadCancel = root.querySelector('.recon-download-cancel');
        this.cacheUsageLabel = root.querySelector('.recon-cache-usage');
        this.clearCacheButton = root.querySelector('.recon-cache-clear');
    }

    setDownload(title: string, detail: string, visual: ProgressVisual) {
        this.downloadPanel.hidden = false;
        this.downloadPanel.dataset.mode = visual.mode;
        this.downloadName.textContent = title;
        this.downloadStats.textContent = detail;
        if (visual.mode === 'determinate') {
            this.downloadBar.style.width = `${Math.min(100, Math.max(0, visual.value))}%`;
        } else if (visual.mode === 'done') {
            this.downloadBar.style.width = '100%';
        } else if (visual.mode === 'idle') {
            this.downloadBar.style.width = '0%';
        }
    }

    hideDownload() {
        this.downloadPanel.hidden = true;
        this.downloadCancel.hidden = true;
    }
}

export { ArtifactsView };
