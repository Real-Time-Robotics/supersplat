import { reconFetch } from './reconstruction-http';
import { CheckoutStatus, PricingCatalog } from './reconstruction-types';
import { delay, messageOf, readJson } from './reconstruction-utils';
import { ReconstructionView } from './reconstruction-view';

class ReconstructionBilling {
    private balance = 0;
    private cap: number | null = null;
    private pricingLoaded = false;
    private checkoutPollId = 0;

    constructor(
        private readonly view: ReconstructionView,
        private readonly onCheckoutComplete: () => Promise<void>
    ) {
        view.buyCreditsButton.addEventListener('click', () => this.togglePricing());
        view.query('.recon-custom-buy').addEventListener('click', () => this.purchaseCustomCredits());
        view.customCreditsInput.addEventListener('input', () => this.updateCustomPrice());
    }

    get currentBalance() {
        return this.balance;
    }

    setBalance(balance: number) {
        this.balance = Number(balance);
        this.view.creditValue.textContent = this.balance.toLocaleString();
    }

    cancelPolling() {
        this.checkoutPollId++;
    }

    /** The account's concurrent-job cap, as last published by the control plane. */
    get concurrentCap() {
        return this.cap;
    }

    async refreshCredits() {
        try {
            const response = await reconFetch('/api/reconstruction/credits', { cache: 'no-store' });
            const data = await readJson<{ balance: number; concurrent?: number }>(response);
            this.setBalance(data.balance);
            if (typeof data.concurrent === 'number') this.cap = data.concurrent;
            return this.balance;
        } catch {
            this.view.creditValue.textContent = 'offline';
            return null;
        }
    }

    async showCreditShortfall(creditsNeeded: number) {
        this.view.pricingPanel.classList.add('open');
        this.view.pricingPanel.setAttribute('aria-hidden', 'false');
        this.view.buyCreditsButton.setAttribute('aria-expanded', 'true');
        if (!this.pricingLoaded) await this.loadPricing();
        const minCredits = Number(this.view.customCreditsInput.min || 100);
        const maxCredits = Number(this.view.customCreditsInput.max || 1_000_000);
        this.view.customCreditsInput.value = String(Math.min(maxCredits, Math.max(minCredits, creditsNeeded)));
        this.updateCustomPrice();
    }

    private async togglePricing() {
        const open = !this.view.pricingPanel.classList.contains('open');
        this.view.pricingPanel.classList.toggle('open', open);
        this.view.pricingPanel.setAttribute('aria-hidden', String(!open));
        this.view.buyCreditsButton.setAttribute('aria-expanded', String(open));
        if (open && !this.pricingLoaded) await this.loadPricing();
    }

    private async loadPricing() {
        try {
            const response = await reconFetch('/api/reconstruction/pricing', { cache: 'no-store' });
            const catalog = await readJson<PricingCatalog>(response);
            this.view.pricingPacks.textContent = '';
            for (const pack of catalog.packs) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'recon-button recon-price-pack';
                const credits = document.createElement('strong');
                credits.textContent = pack.credits_label || pack.credits.toLocaleString();
                const label = document.createElement('span');
                const price = pack.price_label || `$${((pack.price_cents || 0) / 100).toFixed(2)}`;
                label.textContent = `${price} · PAYG`;
                button.append(credits, label);
                button.addEventListener('click', () => this.purchaseCredits({ packCredits: pack.credits }, pack.credits));
                this.view.pricingPacks.appendChild(button);
            }
            this.view.pricingNote.textContent = catalog.note;
            this.view.customCreditsInput.min = String(catalog.custom_min_credits);
            this.view.customCreditsInput.max = String(catalog.custom_max_credits);
            this.view.customCreditsInput.dataset.unitUsd = String(catalog.credit_unit_usd);
            this.updateCustomPrice();
            this.pricingLoaded = true;
        } catch (error) {
            this.view.pricingPacks.textContent = messageOf(error);
        }
    }

    private updateCustomPrice() {
        const credits = Number(this.view.customCreditsInput.value);
        const unitUsd = Number(this.view.customCreditsInput.dataset.unitUsd || 0.01);
        this.view.customPrice.textContent = Number.isFinite(credits) ? `≈ $${(credits * unitUsd).toFixed(2)}` : '—';
    }

    private async purchaseCustomCredits() {
        const customCredits = Number(this.view.customCreditsInput.value);
        const min = Number(this.view.customCreditsInput.min || 100);
        const max = Number(this.view.customCreditsInput.max || 1_000_000);
        if (!Number.isInteger(customCredits) || customCredits < min || customCredits > max) {
            this.view.purchaseStatus.textContent = `Enter between ${min.toLocaleString()} and ${max.toLocaleString()} credits.`;
            return;
        }
        await this.purchaseCredits({ customCredits }, customCredits);
    }

    private async purchaseCredits(body: { packCredits?: number; customCredits?: number }, expectedCredits: number) {
        const balanceBefore = await this.refreshCredits() ?? this.balance;
        const popup = window.open('about:blank', `reconstruction-checkout-${Date.now()}`, 'popup,width=520,height=760');
        if (popup) popup.document.body.textContent = 'Creating checkout…';
        this.view.purchaseStatus.textContent = 'Creating checkout…';
        try {
            const response = await reconFetch('/api/reconstruction/checkout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const checkout = await readJson<{ id: string; url: string }>(response);
            this.view.purchaseCheckoutLink.href = checkout.url;
            this.view.purchaseCheckoutLink.hidden = false;
            if (popup) popup.location.href = checkout.url;
            this.view.purchaseStatus.textContent = `Waiting for ${expectedCredits.toLocaleString()} credits…`;
            await this.waitForCheckout(checkout.id, balanceBefore, popup);
            await this.onCheckoutComplete();
        } catch (error) {
            popup?.close();
            this.view.purchaseStatus.textContent = messageOf(error);
        }
    }

    private async waitForCheckout(checkoutId: string, balanceBefore: number, popup: Window | null) {
        const pollId = ++this.checkoutPollId;
        let paymentConfirmed = false;
        for (let attempt = 0; attempt < 150 && pollId === this.checkoutPollId; attempt++) {
            let checkout: CheckoutStatus | null = null;
            try {
                const response = await reconFetch(`/api/reconstruction/checkouts/${encodeURIComponent(checkoutId)}`, {
                    cache: 'no-store'
                });
                checkout = await readJson<CheckoutStatus>(response);
            } catch {
                // Balance remains a reliable fallback if checkout status is temporarily unavailable.
            }
            const balance = await this.refreshCredits();
            paymentConfirmed ||= checkout?.status === 'paid';
            if (balance != null && balance > balanceBefore) {
                if (popup && !popup.closed) popup.close();
                const received = balance - balanceBefore;
                this.view.purchaseStatus.textContent = `Received ${received.toLocaleString()} credits.`;
                this.view.purchaseCheckoutLink.hidden = true;
                return;
            }
            if (paymentConfirmed) {
                this.view.purchaseStatus.textContent = 'Payment confirmed. Waiting for the credit balance to update…';
            }
            if (checkout?.status === 'expired' || checkout?.status === 'failed') {
                throw new Error(`Checkout ended with status “${checkout.status}”.`);
            }
            await delay(2000);
        }
        if (pollId === this.checkoutPollId) {
            throw new Error('Checkout is still not complete. You can reopen the checkout or check your balance later.');
        }
    }
}

export { ReconstructionBilling };
