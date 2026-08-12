import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ReconstructionBilling } from './reconstruction-billing.ts';

const control = () => ({
    hidden: false,
    textContent: '',
    addEventListener: () => {},
    setAttribute: () => {}
});

const view = () => ({
    buyCreditsButton: control(),
    customCreditsInput: { ...control(), min: '', max: '', value: '', dataset: {} },
    creditValue: control(),
    purchaseCheckoutLink: control(),
    purchaseStatus: control(),
    query: () => control()
});

test('a credit response from an ended session cannot enter the next one', async () => {
    const originalFetch = globalThis.fetch;
    let answer = (_response: Response) => {};
    globalThis.fetch = (() => new Promise<Response>((resolve) => {
        answer = resolve;
    })) as typeof fetch;
    try {
        const fakeView = view();
        const billing = new ReconstructionBilling(fakeView as any, async () => {});
        billing.beginSession();
        const stale = billing.refreshCredits();
        await Promise.resolve();
        billing.endSession();
        billing.beginSession();
        answer(new Response(JSON.stringify({ balance: 900, concurrent: 4 }), {
            headers: { 'Content-Type': 'application/json' }
        }));

        assert.equal(await stale, null);
        assert.equal(billing.currentBalance, 0);
        assert.equal(billing.concurrentCap, null);
        assert.equal(fakeView.creditValue.textContent, '0');
    } finally {
        globalThis.fetch = originalFetch;
    }
});
