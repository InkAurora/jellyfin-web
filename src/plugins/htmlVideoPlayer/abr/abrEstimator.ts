const MIN_SAMPLE_BYTES = 32 * 1024;
const MIN_SAMPLE_WEIGHT_SECONDS = 0.05;
const TTFB_WINDOW_SIZE = 8;
const TTFB_PERCENTILE = 0.75;
const VBR_SMOOTHING = 0.2;
const MIN_VBR_RATIO = 1;

export interface AbrEstimatorTuning {
    fastHalfLifeSeconds: number;
    maxVbrRatio: number;
    slowHalfLifeSeconds: number;
}

export interface AbrFragmentSample {
    /** Declared bitrate of the level that served the fragment. */
    declaredBitrate: number;
    durationSeconds: number;
    /** The first fragment after a level switch can include a one-time transcoder restart. */
    isFirstAfterSwitch?: boolean;
    loadedBytes: number;
    loadingEndMs: number;
    loadingFirstMs: number;
    loadingStartMs: number;
}

function isPositiveFinite(value: number | undefined): value is number {
    return Number.isFinite(value) && (value || 0) > 0;
}

function percentile(values: number[], fraction: number) {
    if (!values.length) {
        return 0;
    }

    const sorted = [...values].sort((first, second) => first - second);
    const index = Math.min(Math.max(Math.ceil(sorted.length * fraction) - 1, 0), sorted.length - 1);
    return sorted[index];
}

function updateEwma(current: number, sample: number, weightSeconds: number, halfLifeSeconds: number) {
    if (!isPositiveFinite(current)) {
        return sample;
    }

    const alpha = 1 - Math.exp((-Math.LN2 * weightSeconds) / halfLifeSeconds);
    return (alpha * sample) + ((1 - alpha) * current);
}

/**
 * Estimates network throughput, server delay (TTFB) and how much larger the
 * segments are than their declared bitrate. All numbers are in bits/s or ms.
 */
export class AbrEstimator {
    private fastThroughput = 0;
    private seedThroughput: number;
    private slowThroughput = 0;
    private ttfbSamples: number[] = [];
    private vbrRatio = MIN_VBR_RATIO;
    private sampleCount = 0;

    constructor(seedThroughput: number, private tuning: AbrEstimatorTuning) {
        this.seedThroughput = isPositiveFinite(seedThroughput) ? seedThroughput : 0;
    }

    get throughput() {
        if (!this.sampleCount) {
            return this.seedThroughput;
        }

        return Math.min(this.fastThroughput, this.slowThroughput);
    }

    get ttfbMs() {
        return percentile(this.ttfbSamples, TTFB_PERCENTILE);
    }

    get vbr() {
        return this.vbrRatio;
    }

    get samples() {
        return this.sampleCount;
    }

    record(sample: AbrFragmentSample) {
        const payloadMs = sample.loadingEndMs - sample.loadingFirstMs;
        const ttfbMs = sample.loadingFirstMs - sample.loadingStartMs;
        if (!Number.isFinite(sample.loadedBytes)
            || sample.loadedBytes < MIN_SAMPLE_BYTES
            || !isPositiveFinite(sample.durationSeconds)
            || !isPositiveFinite(payloadMs)
            || !Number.isFinite(ttfbMs)
            || ttfbMs < 0) {
            return false;
        }

        const loadedBits = sample.loadedBytes * 8;
        const payloadRate = (loadedBits * 1000) / payloadMs;
        // Weight by media time, not download time. With download-time weights a
        // fast link gives tiny weights, and the slow average almost never moves.
        const weightSeconds = Math.max(sample.durationSeconds, MIN_SAMPLE_WEIGHT_SECONDS);
        this.fastThroughput = updateEwma(this.fastThroughput, payloadRate, weightSeconds, this.tuning.fastHalfLifeSeconds);
        this.slowThroughput = updateEwma(this.slowThroughput, payloadRate, weightSeconds, this.tuning.slowHalfLifeSeconds);
        this.sampleCount += 1;

        if (!sample.isFirstAfterSwitch) {
            this.ttfbSamples.push(ttfbMs);
            if (this.ttfbSamples.length > TTFB_WINDOW_SIZE) {
                this.ttfbSamples.shift();
            }
        }

        if (isPositiveFinite(sample.declaredBitrate)) {
            // Content complexity is shared by all levels, so one ratio is enough.
            const ratio = loadedBits / sample.durationSeconds / sample.declaredBitrate;
            const smoothed = (VBR_SMOOTHING * ratio) + ((1 - VBR_SMOOTHING) * this.vbrRatio);
            this.vbrRatio = Math.min(Math.max(smoothed, MIN_VBR_RATIO), this.tuning.maxVbrRatio);
        }

        return true;
    }

    /** Predicted seconds to fetch one segment of the given declared bitrate. */
    predictFetchSeconds(bitrate: number, segmentDurationSeconds: number) {
        const throughput = this.throughput;
        if (!isPositiveFinite(throughput) || !isPositiveFinite(bitrate)) {
            return Number.POSITIVE_INFINITY;
        }

        return (this.ttfbMs / 1000) + ((segmentDurationSeconds * bitrate * this.vbrRatio) / throughput);
    }
}
