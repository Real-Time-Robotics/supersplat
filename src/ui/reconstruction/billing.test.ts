import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ReconstructionBilling, studioPlanUrl } from './billing.ts';

const control = () => {
    const clicks: (() => void)[] = [];
    return {
        hidden: false,
        textContent: '',
        href: '',
        clicks,
        addEventListener: (_type: string, listener: () => void) => clicks.push(listener),
        removeAttribute: () => {}
    };
};

const view = () => ({
    buyCreditsLink: control(),
    studioLink: control(),
    creditValue: control()
});

const reply = (body: unknown) => new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' }
});

test('the Studio plan link names the account only when it is known', () => {
    assert.equal(studioPlanUrl('https://studio.test/'), 'https://studio.test/#plan');
    assert.equal(studioPlanUrl('https://studio.test', 'acc 1'), 'https://studio.test/#plan?account=acc+1');
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
        answer(reply({ balance: 900, concurrent: 4 }));

        assert.equal(await stale, null);
        assert.equal(billing.currentBalance, 0);
        assert.equal(billing.concurrentCap, null);
        assert.equal(fakeView.creditValue.textContent, '0');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('returning from Studio refreshes the balance once', async () => {
    const originalFetch = globalThis.fetch;
    const balances = [500, 1500];
    let fetches = 0;
    globalThis.fetch = (async () => reply({ balance: balances[fetches++], account_id: 'acc-1' })) as typeof fetch;
    try {
        const fakeView = view();
        let returns = 0;
        const billing = new ReconstructionBilling(fakeView as any, async () => {
            returns++;
        });
        billing.beginSession();
        await billing.refreshCredits();
        await billing.returnFromStudio();
        assert.equal(fetches, 1);

        fakeView.buyCreditsLink.clicks.forEach(listener => listener());
        await billing.returnFromStudio();
        await billing.returnFromStudio();

        assert.equal(fetches, 2);
        assert.equal(returns, 1);
        assert.equal(fakeView.creditValue.textContent, (1500).toLocaleString());
    } finally {
        globalThis.fetch = originalFetch;
    }
});
