/**
 * The Artifacts tab
 */
class ArtifactsView {
    readonly root: HTMLElement;
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
            <p class="recon-artifacts-empty">
                Open a model from a dataset in <strong>Create</strong> to see the files it
                produced.
            </p>
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
        this.artifactPanel = root.querySelector('.recon-artifacts');
        this.artifactTitle = root.querySelector('.recon-artifact-title');
        this.artifactList = root.querySelector('.recon-artifact-list');
        this.cacheUsageLabel = root.querySelector('.recon-cache-usage');
        this.clearCacheButton = root.querySelector('.recon-cache-clear');
    }
}

export { ArtifactsView };
