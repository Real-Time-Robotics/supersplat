import artifactsSvg from '../svg/recon-artifacts.svg';
import createSvgIcon from '../svg/recon-create.svg';
import settingsSvg from '../svg/recon-settings.svg';
import { createSvg } from '../svg-element';

type DashboardTab = 'create' | 'artifacts' | 'settings';

const TABS: { tab: DashboardTab; label: string; hint: string; icon: string }[] = [
    {
        tab: 'create',
        label: 'Create',
        icon: createSvgIcon,
        hint: 'Turn photos into a model'
    },
    {
        tab: 'artifacts',
        label: 'Artifacts',
        icon: artifactsSvg,
        hint: 'Files a finished model produced'
    },
    {
        tab: 'settings',
        label: 'Settings',
        icon: settingsSvg,
        hint: 'Account and API key'
    }
];

/**
 * The dashboard chrome: topbar, credit strip, pricing popover, sidebar, and the stage
 * the tab panels mount into. The tab views are appended to {@link stage}.
 */
class DashboardShell {
    readonly root: HTMLElement;
    readonly title: HTMLElement;
    readonly closeButton: HTMLButtonElement;
    readonly creditValue: HTMLElement;
    readonly buyCreditsButton: HTMLButtonElement;
    readonly pricingPanel: HTMLElement;
    readonly pricingPacks: HTMLElement;
    readonly pricingNote: HTMLElement;
    readonly purchaseStatus: HTMLElement;
    readonly purchaseCheckoutLink: HTMLAnchorElement;
    readonly customCreditsInput: HTMLInputElement;
    readonly customPrice: HTMLElement;
    readonly tabButtons: HTMLButtonElement[];
    readonly stage: HTMLElement;
    private active: DashboardTab = 'create';

    constructor(host: HTMLElement) {
        const root = document.createElement('div');
        root.className = 'recon-dashboard blocks-shortcuts';
        root.innerHTML = `
            <header class="recon-topbar">
                <span class="recon-topbar-icon" aria-hidden="true">&#xE344;</span>
                <strong class="recon-topbar-title"></strong>
                <div class="recon-credit">
                    <i aria-hidden="true"></i>
                    <span>Credit: <strong class="recon-credit-value">—</strong></span>
                    <button class="recon-button recon-buy-credits" type="button"
                            aria-expanded="false">Buy Credit</button>
                </div>
                <button class="recon-topbar-close" type="button"
                        aria-label="Close Reconstruction" title="Close">&#xD7;</button>
            </header>
            <section class="recon-pricing" aria-hidden="true" aria-label="Buy PAYG credits">
                <div class="recon-section-heading">
                    <strong>Buy PAYG credits</strong>
                </div>
                <div class="recon-pricing-packs"><span>Loading pricing…</span></div>
                <div class="recon-custom-credits">
                    <label for="recon-custom-credits">Custom credits</label>
                    <div>
                        <input id="recon-custom-credits" type="number" min="100" max="1000000"
                               step="100" value="1000">
                        <span class="recon-custom-price">≈ $10.00</span>
                        <button class="recon-button recon-primary recon-custom-buy"
                                type="button">Buy</button>
                    </div>
                </div>
                <p class="recon-pricing-note"></p>
                <p class="recon-purchase-status" role="status"></p>
                <a class="recon-purchase-checkout" target="reconstruction-checkout"
                   rel="noopener" hidden>Reopen checkout ↗</a>
            </section>
            <div class="recon-main">
                <nav class="recon-sidebar" role="tablist" aria-label="Reconstruction">${
    TABS.map(({ tab, label, hint }) => `
                    <button class="recon-nav${tab === 'create' ? ' active' : ''}" type="button"
                            role="tab" data-tab="${tab}" title="${hint}"
                            aria-selected="${tab === 'create'}"
                            aria-controls="recon-${tab}-tab"><span
                            class="recon-nav-label">${label}</span></button>`).join('')}
                </nav>
                <div class="recon-stage"></div>
            </div>`;
        host.appendChild(root);

        this.root = root;
        this.title = root.querySelector('.recon-topbar-title');
        this.closeButton = root.querySelector('.recon-topbar-close');
        this.creditValue = root.querySelector('.recon-credit-value');
        this.buyCreditsButton = root.querySelector('.recon-buy-credits');
        this.pricingPanel = root.querySelector('.recon-pricing');
        this.pricingPacks = root.querySelector('.recon-pricing-packs');
        this.pricingNote = root.querySelector('.recon-pricing-note');
        this.purchaseStatus = root.querySelector('.recon-purchase-status');
        this.purchaseCheckoutLink = root.querySelector('.recon-purchase-checkout');
        this.customCreditsInput = root.querySelector('.recon-custom-credits input');
        this.customPrice = root.querySelector('.recon-custom-price');
        this.tabButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('.recon-nav'));
        this.stage = root.querySelector('.recon-stage');

        for (const button of this.tabButtons) {
            // Prepended rather than inlined in the template: the imported svg is a data
            // URI that has to be decoded and parsed, not dropped into innerHTML.
            const icon = TABS.find(entry => entry.tab === button.dataset.tab)?.icon;
            if (icon) {
                const glyph = createSvg(icon);
                glyph.classList.add('recon-nav-icon');
                glyph.setAttribute('aria-hidden', 'true');
                button.prepend(glyph);
            }
            button.addEventListener('click',
                () => this.setTab(button.dataset.tab as DashboardTab));
        }
    }

    setTab(tab: DashboardTab) {
        this.active = tab;
        for (const button of this.tabButtons) {
            const selected = button.dataset.tab === tab;
            button.classList.toggle('active', selected);
            button.setAttribute('aria-selected', String(selected));
        }
        for (const panel of Array.from(this.stage.children)) {
            (panel as HTMLElement).hidden = panel.id !== `recon-${tab}-tab`;
        }
    }

    get currentTab() {
        return this.active;
    }

    /**
     * Signed out there is no credit to read and no tab worth reaching, so the chrome is
     * withheld rather than shown disabled.
     */
    setSignedIn(signedIn: boolean) {
        this.root.classList.toggle('signed-in', signedIn);
    }
}

export { DashboardShell };
export type { DashboardTab };
