import assert from 'node:assert';
import { describe, it } from 'node:test';

import { RateMeter, formatEtaShort, formatRate } from './upload-rate.ts';

/** A clock the test drives by hand, in ms, matching performance.now()'s unit. */
const clock = (start = 0) => {
    let time = start;
    return {
        now: () => time,
        advance: (ms: number) => {
            time += ms;
        }
    };
};

describe('RateMeter', () => {
    it('reports no rate until the window is wide enough to divide by', () => {
        const time = clock();
        const meter = new RateMeter(time.now);

        const first = meter.sample(0, 1000);
        assert.equal(first.bytesPerSecond, 0);
        assert.equal(first.etaSeconds, 0);

        time.advance(100);
        assert.equal(meter.sample(500, 1000).bytesPerSecond, 0);
    });

    it('derives rate and eta from the window once it is wide enough', () => {
        const time = clock();
        const meter = new RateMeter(time.now);

        meter.sample(0, 1000);
        time.advance(1000);
        const rate = meter.sample(400, 1000);

        assert.equal(rate.bytesPerSecond, 400);
        assert.equal(rate.etaSeconds, 1.5);
        assert.equal(rate.loaded, 400);
        assert.equal(rate.total, 1000);
    });

    it('drops samples older than the window so the rate tracks recent throughput', () => {
        const time = clock();
        const meter = new RateMeter(time.now);

        // 100 B/s for 10s, which is longer than the 8s window
        meter.sample(0, 100_000);
        for (let i = 1; i <= 10; i++) {
            time.advance(1000);
            meter.sample(i * 100, 100_000);
        }

        // then a 1s burst 10x faster; the stale slow samples must have aged out
        time.advance(1000);
        const rate = meter.sample(1000 + 1000, 100_000);

        assert.ok(rate.bytesPerSecond > 100,
            `expected the burst to lift the rate above 100 B/s, got ${rate.bytesPerSecond}`);
    });

    it('never reports a negative rate when loaded goes backwards', () => {
        const time = clock();
        const meter = new RateMeter(time.now);

        meter.sample(500, 1000);
        time.advance(1000);
        // a retried part can re-report from a lower offset
        assert.equal(meter.sample(200, 1000).bytesPerSecond, 0);
    });

    it('reports no eta once loaded has reached total', () => {
        const time = clock();
        const meter = new RateMeter(time.now);

        meter.sample(0, 1000);
        time.advance(1000);
        assert.equal(meter.sample(1000, 1000).etaSeconds, 0);
    });
});

describe('formatRate', () => {
    it('renders a per-second figure', () => {
        assert.equal(formatRate(2 * 1024 * 1024), '2.00 MB/s');
    });

    it('renders nothing when the rate is not known yet', () => {
        assert.equal(formatRate(0), '');
    });
});

describe('formatEtaShort', () => {
    it('renders seconds under a minute', () => {
        assert.equal(formatEtaShort(45), '45s');
    });

    it('rounds a sub-second remainder up to 1s rather than 0s', () => {
        assert.equal(formatEtaShort(0.2), '1s');
    });

    it('renders minutes and seconds under an hour', () => {
        assert.equal(formatEtaShort(80), '1m 20s');
    });

    it('carries a rounded-up remainder into the minute rather than reading 60s', () => {
        assert.equal(formatEtaShort(119.5), '2m 0s');
    });

    it('renders hours and minutes past an hour', () => {
        assert.equal(formatEtaShort(3 * 3600 + 25 * 60), '3h 25m');
    });

    it('renders nothing when the eta is unknown', () => {
        assert.equal(formatEtaShort(0), '');
        assert.equal(formatEtaShort(Infinity), '');
        assert.equal(formatEtaShort(-5), '');
    });
});
