import { reconFetch } from './http';
import { readJson } from './utils';
import type { ReconstructionView } from './view';

const studioPlanUrl = (base: string, accountId?: string | null) => {
    const root = `${base.replace(/\/+$/, '')}/#plan`;
    return accountId ? `${root}?${new URLSearchParams({ account: accountId })}` : root;
};

class ReconstructionBilling {
    private balance = 0;
    private cap: number | null = null;
    private accountId: string | null = null;
    private studioUrl: string | null = null;
    private studioOpened = false;
    private sessionGeneration = 0;

    constructor(
        private readonly view: ReconstructionView,
        private readonly onStudioReturn: () => Promise<void>
    ) {
        for (const link of [view.buyCreditsLink, view.studioLink]) {
            link.addEventListener('click', () => {
                this.studioOpened = true;
            });
        }
    }

    get currentBalance() {
        return this.balance;
    }

    setBalance(balance: number) {
        this.balance = Number(balance);
        this.view.creditValue.textContent = this.balance.toLocaleString();
    }

    beginSession() {
        this.sessionGeneration++;
    }

    endSession() {
        this.sessionGeneration++;
        this.cap = null;
        this.accountId = null;
        this.studioOpened = false;
        this.setBalance(0);
        this.renderStudioLinks();
    }

    get concurrentCap() {
        return this.cap;
    }

    async refreshCredits() {
        const generation = this.sessionGeneration;
        try {
            const response = await reconFetch('/api/reconstruction/credits', { cache: 'no-store' });
            const data = await readJson<{ balance: number; concurrent?: number; account_id?: string }>(response);
            if (generation !== this.sessionGeneration) return null;
            this.setBalance(data.balance);
            if (typeof data.concurrent === 'number') this.cap = data.concurrent;
            if (data.account_id) {
                this.accountId = data.account_id;
                this.renderStudioLinks();
            }
            return this.balance;
        } catch {
            if (generation !== this.sessionGeneration) return null;
            this.view.creditValue.textContent = 'offline';
            return null;
        }
    }

    async loadStudio() {
        const generation = this.sessionGeneration;
        let studioUrl: string | null = null;
        try {
            const response = await reconFetch('/api/reconstruction/config', { cache: 'no-store' });
            const config = await readJson<{ studio_url?: string | null }>(response);
            if (config.studio_url && /^https?:\/\//i.test(config.studio_url)) studioUrl = config.studio_url;
        } catch {
            studioUrl = null;
        }
        if (generation !== this.sessionGeneration) return;
        this.studioUrl = studioUrl;
        this.renderStudioLinks();
    }

    async returnFromStudio() {
        if (!this.studioOpened) return;
        this.studioOpened = false;
        const before = this.balance;
        const balance = await this.refreshCredits();
        if (balance !== null && balance !== before) await this.onStudioReturn();
    }

    showCreditShortfall() {
        this.view.studioLink.hidden = !this.studioUrl;
    }

    private renderStudioLinks() {
        const href = this.studioUrl ? studioPlanUrl(this.studioUrl, this.accountId) : null;
        for (const link of [this.view.buyCreditsLink, this.view.studioLink]) {
            if (href) link.href = href;
            else link.removeAttribute('href');
        }
        this.view.buyCreditsLink.hidden = !href;
        if (!href) this.view.studioLink.hidden = true;
    }
}

export { ReconstructionBilling, studioPlanUrl };
