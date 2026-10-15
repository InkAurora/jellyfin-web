import { describe, expect, it } from 'vitest';

import { AbrEstimator, type AbrFragmentSample } from './abrEstimator';

const SEED_THROUGHPUT = 8_000_000;

const tuning = {
    defaultSwitchCostMs: 1_000,
    fastHalfLifeSeconds: 3,
    maxVbrRatio: 1.5,
    slowHalfLifeSeconds: 10
};

function createEstimator(seed = SEED_THROUGHPUT) {
    return new AbrEstimator(seed, tuning);
}

function createFragmentSample(options: {
    bandwidth?: number;
    declaredBitrate?: number;
    durationSeconds?: number;
    isFirstAfterSwitch?: boolean;
    loadedBytes?: number;
    mediaBitrate?: number;
    nowMs?: number;
    ttfbMs?: number;
} = {}): AbrFragmentSample {
    const bandwidth = options.bandwidth || 10_000_000;
    const declaredBitrate = options.declaredBitrate ?? 1_000_000;
    const durationSeconds = options.durationSeconds || 3;
    const mediaBitrate = options.mediaBitrate ?? declaredBitrate;
    const loadedBytes = options.loadedBytes ?? mediaBitrate * durationSeconds / 8;
    const nowMs = options.nowMs ?? 10_000;
    const payloadDurationMs = loadedBytes * 8_000 / bandwidth;
    const ttfbMs = options.ttfbMs ?? 100;

    return {
        declaredBitrate,
        durationSeconds,
        isFirstAfterSwitch: options.isFirstAfterSwitch,
        loadedBytes,
        loadingEndMs: nowMs,
        loadingFirstMs: nowMs - payloadDurationMs,
        loadingStartMs: nowMs - payloadDurationMs - ttfbMs
    };
}

describe('AbrEstimator initial state', () => {
    it('reports the seed throughput before any sample', () => {
        const estimator = createEstimator();

        expect(estimator.throughput).toBe(SEED_THROUGHPUT);
    });

    it('starts with no TTFB, no VBR overhead and no samples', () => {
        const estimator = createEstimator();

        expect(estimator.ttfbMs).toBe(0);
        expect(estimator.vbr).toBe(1);
        expect(estimator.samples).toBe(0);
    });

    it('treats an invalid seed as zero throughput', () => {
        expect(createEstimator(0).throughput).toBe(0);
        expect(createEstimator(-5).throughput).toBe(0);
        expect(createEstimator(Number.NaN).throughput).toBe(0);
    });
});

describe('AbrEstimator sample validation', () => {
    it('accepts a normal sample', () => {
        const estimator = createEstimator();

        expect(estimator.record(createFragmentSample())).toBe(true);
        expect(estimator.samples).toBe(1);
    });

    it('rejects samples under 32 KiB and accepts exactly 32 KiB', () => {
        const estimator = createEstimator();

        expect(estimator.record(createFragmentSample({ loadedBytes: (32 * 1024) - 1 }))).toBe(false);
        expect(estimator.samples).toBe(0);
        expect(estimator.throughput).toBe(SEED_THROUGHPUT);

        expect(estimator.record(createFragmentSample({ loadedBytes: 32 * 1024 }))).toBe(true);
        expect(estimator.samples).toBe(1);
    });

    it('rejects samples with zero payload time', () => {
        const estimator = createEstimator();
        const sample = createFragmentSample();

        expect(estimator.record({ ...sample, loadingEndMs: sample.loadingFirstMs })).toBe(false);
        expect(estimator.samples).toBe(0);
        expect(estimator.throughput).toBe(SEED_THROUGHPUT);
    });

    it('rejects samples with negative payload time', () => {
        const estimator = createEstimator();
        const sample = createFragmentSample();

        expect(estimator.record({ ...sample, loadingEndMs: sample.loadingFirstMs - 10 })).toBe(false);
        expect(estimator.samples).toBe(0);
    });

    it('rejects samples where the first byte arrives before the load starts', () => {
        const estimator = createEstimator();
        const sample = createFragmentSample();

        expect(estimator.record({ ...sample, loadingStartMs: sample.loadingFirstMs + 1 })).toBe(false);
        expect(estimator.samples).toBe(0);
        expect(estimator.ttfbMs).toBe(0);
    });

    it('rejects samples with no media duration', () => {
        const estimator = createEstimator();
        const sample = createFragmentSample();

        expect(estimator.record({ ...sample, durationSeconds: 0 })).toBe(false);
        expect(estimator.samples).toBe(0);
    });
});

describe('AbrEstimator throughput', () => {
    it('uses the first sample as both averages', () => {
        const estimator = createEstimator();

        estimator.record(createFragmentSample({ bandwidth: 5_000_000 }));

        expect(estimator.throughput).toBeCloseTo(5_000_000, -2);
    });

    it('falls quickly after a drop in rate', () => {
        const estimator = createEstimator();

        estimator.record(createFragmentSample({ bandwidth: 10_000_000 }));
        estimator.record(createFragmentSample({ bandwidth: 2_000_000 }));

        // 3 s weight with a 3 s half-life moves the fast average halfway.
        expect(estimator.throughput).toBeCloseTo(6_000_000, -2);
    });

    it('rises slower than the fast average after a rise in rate', () => {
        const estimator = createEstimator();

        estimator.record(createFragmentSample({ bandwidth: 2_000_000 }));
        estimator.record(createFragmentSample({ bandwidth: 10_000_000 }));

        const fastAverage = 6_000_000;
        expect(estimator.throughput).toBeGreaterThan(2_000_000);
        expect(estimator.throughput).toBeLessThan(fastAverage);
        expect(estimator.throughput).toBeLessThan(10_000_000);
    });

    it('converges to a steady rate after many samples', () => {
        const estimator = createEstimator();

        estimator.record(createFragmentSample({ bandwidth: 2_000_000 }));
        for (let index = 0; index < 40; index++) {
            estimator.record(createFragmentSample({ bandwidth: 10_000_000 }));
        }

        expect(estimator.throughput).toBeCloseTo(10_000_000, -4);
    });

    it('still counts first-after-switch samples for throughput', () => {
        const estimator = createEstimator();

        estimator.record(createFragmentSample({ bandwidth: 5_000_000, isFirstAfterSwitch: true }));

        expect(estimator.samples).toBe(1);
        expect(estimator.throughput).toBeCloseTo(5_000_000, -2);
    });
});

describe('AbrEstimator TTFB', () => {
    it('uses the only sample as TTFB', () => {
        const estimator = createEstimator();

        estimator.record(createFragmentSample({ ttfbMs: 250 }));

        expect(estimator.ttfbMs).toBeCloseTo(250, 3);
    });

    it('reports the p75 of the samples', () => {
        const estimator = createEstimator();

        for (const ttfbMs of [100, 200, 300, 400, 500, 600, 700, 800]) {
            estimator.record(createFragmentSample({ ttfbMs }));
        }

        expect(estimator.ttfbMs).toBeCloseTo(600, 3);
    });

    it('is not moved by a single outlier', () => {
        const estimator = createEstimator();

        for (const ttfbMs of [100, 100, 100, 100, 100, 100, 100, 5_000]) {
            estimator.record(createFragmentSample({ ttfbMs }));
        }

        expect(estimator.ttfbMs).toBeCloseTo(100, 3);
    });

    it('only looks at the last 8 samples', () => {
        const estimator = createEstimator();

        for (let index = 0; index < 8; index++) {
            estimator.record(createFragmentSample({ ttfbMs: 1_000 }));
        }
        expect(estimator.ttfbMs).toBeCloseTo(1_000, 3);

        for (let index = 0; index < 8; index++) {
            estimator.record(createFragmentSample({ ttfbMs: 100 }));
        }

        // The old slow samples are out of the window.
        expect(estimator.ttfbMs).toBeCloseTo(100, 3);
        expect(estimator.samples).toBe(16);
    });

    it('ignores first-after-switch samples', () => {
        const estimator = createEstimator();

        estimator.record(createFragmentSample({ isFirstAfterSwitch: true, ttfbMs: 5_000 }));

        expect(estimator.ttfbMs).toBe(0);
        expect(estimator.samples).toBe(1);

        estimator.record(createFragmentSample({ ttfbMs: 150 }));

        expect(estimator.ttfbMs).toBeCloseTo(150, 3);
        expect(estimator.samples).toBe(2);
    });
});

describe('AbrEstimator VBR ratio', () => {
    it('stays at 1 when segments match the declared bitrate', () => {
        const estimator = createEstimator();

        estimator.record(createFragmentSample({ declaredBitrate: 2_000_000, mediaBitrate: 2_000_000 }));

        expect(estimator.vbr).toBeCloseTo(1, 6);
    });

    it('moves towards a larger segment with smoothing 0.2', () => {
        const estimator = createEstimator();

        estimator.record(createFragmentSample({ declaredBitrate: 1_000_000, mediaBitrate: 2_500_000 }));

        // 0.2 * 2.5 + 0.8 * 1
        expect(estimator.vbr).toBeCloseTo(1.3, 6);
    });

    it('never goes above the configured maximum', () => {
        const estimator = createEstimator();

        for (let index = 0; index < 50; index++) {
            estimator.record(createFragmentSample({ declaredBitrate: 1_000_000, mediaBitrate: 10_000_000 }));
        }

        expect(estimator.vbr).toBe(tuning.maxVbrRatio);
    });

    it('never goes below 1 when segments are smaller than declared', () => {
        const estimator = createEstimator();

        for (let index = 0; index < 10; index++) {
            estimator.record(createFragmentSample({ declaredBitrate: 2_000_000, mediaBitrate: 500_000 }));
        }

        expect(estimator.vbr).toBe(1);
    });

    it('comes back down towards 1 after larger segments', () => {
        const estimator = createEstimator();

        estimator.record(createFragmentSample({ declaredBitrate: 1_000_000, mediaBitrate: 2_500_000 }));
        const raised = estimator.vbr;
        estimator.record(createFragmentSample({ declaredBitrate: 1_000_000, mediaBitrate: 1_000_000 }));

        expect(estimator.vbr).toBeLessThan(raised);
        expect(estimator.vbr).toBeGreaterThanOrEqual(1);
    });

    it('ignores the VBR ratio when the declared bitrate is not known', () => {
        const estimator = createEstimator();

        estimator.record(createFragmentSample({ declaredBitrate: 0, mediaBitrate: 5_000_000 }));

        expect(estimator.vbr).toBe(1);
        expect(estimator.samples).toBe(1);
    });
});

describe('AbrEstimator fetch time prediction', () => {
    it('uses the seed throughput before any sample', () => {
        const estimator = createEstimator();

        // 3 s * 2 Mbit/s / 8 Mbit/s
        expect(estimator.predictFetchSeconds(2_000_000, 3)).toBeCloseTo(0.75, 6);
    });

    it('adds TTFB and scales by the VBR ratio', () => {
        const estimator = createEstimator();

        estimator.record(createFragmentSample({
            bandwidth: 8_000_000,
            declaredBitrate: 1_000_000,
            mediaBitrate: 2_500_000,
            ttfbMs: 200
        }));

        const expected = (estimator.ttfbMs / 1000) + ((3 * 4_000_000 * estimator.vbr) / estimator.throughput);
        expect(estimator.vbr).toBeCloseTo(1.3, 6);
        expect(estimator.ttfbMs).toBeCloseTo(200, 3);
        expect(estimator.predictFetchSeconds(4_000_000, 3)).toBeCloseTo(expected, 9);
        expect(estimator.predictFetchSeconds(4_000_000, 3)).toBeCloseTo(0.2 + ((3 * 4_000_000 * 1.3) / 8_000_000), 3);
    });

    it('scales linearly with the segment duration when TTFB is 0', () => {
        const estimator = createEstimator();

        expect(estimator.predictFetchSeconds(2_000_000, 6)).toBeCloseTo(2 * estimator.predictFetchSeconds(2_000_000, 3), 9);
    });

    it('returns Infinity when the throughput is 0', () => {
        const estimator = createEstimator(0);

        expect(estimator.predictFetchSeconds(2_000_000, 3)).toBe(Number.POSITIVE_INFINITY);
    });

    it('returns Infinity when the bitrate is 0', () => {
        const estimator = createEstimator();

        expect(estimator.predictFetchSeconds(0, 3)).toBe(Number.POSITIVE_INFINITY);
    });
});

describe('AbrEstimator switch cost', () => {
    it('uses the default switch cost before a switch was measured', () => {
        expect(createEstimator().switchCostMs).toBe(1_000);
    });

    it('counts the full TTFB of the first fragment when there is no normal TTFB yet', () => {
        const estimator = createEstimator();

        estimator.record(createFragmentSample({ isFirstAfterSwitch: true, ttfbMs: 5_000 }));

        expect(estimator.switchCostMs).toBe(5_000);
    });

    it('measures the extra TTFB of the first fragment after a switch', () => {
        const estimator = createEstimator();
        for (let index = 0; index < 4; index++) {
            estimator.record(createFragmentSample({ ttfbMs: 100 }));
        }

        estimator.record(createFragmentSample({ isFirstAfterSwitch: true, ttfbMs: 4_100 }));

        expect(estimator.switchCostMs).toBe(4_000);
        expect(estimator.ttfbMs).toBe(100);
    });

    it('smooths later measurements', () => {
        const estimator = createEstimator();
        estimator.record(createFragmentSample({ ttfbMs: 100 }));
        estimator.record(createFragmentSample({ isFirstAfterSwitch: true, ttfbMs: 4_100 }));

        estimator.record(createFragmentSample({ isFirstAfterSwitch: true, ttfbMs: 2_100 }));

        expect(estimator.switchCostMs).toBe(3_000);
    });

    it('never gives a negative switch cost', () => {
        const estimator = createEstimator();
        estimator.record(createFragmentSample({ ttfbMs: 300 }));

        estimator.record(createFragmentSample({ isFirstAfterSwitch: true, ttfbMs: 50 }));

        expect(estimator.switchCostMs).toBe(0);
    });
});
