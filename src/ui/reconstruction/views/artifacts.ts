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
        this.cacheUsageLabel = root.querySelector('.recon-cache-usage');
        this.clearCacheButton = root.querySelector('.recon-cache-clear');
    }
}

export { ArtifactsView };
