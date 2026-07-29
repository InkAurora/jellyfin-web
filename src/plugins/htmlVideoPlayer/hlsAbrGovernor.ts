const DEFAULT_INITIAL_BITRATE = 6_000_000;
const BANDWIDTH_SAMPLE_WINDOW_MS = 60_000;
const BUFFER_SAMPLE_WINDOW_MS = 15_000;
const MIN_BUFFER_SAMPLE_INTERVAL_MS = 750;
const FAST_EWMA_HALF_LIFE_SECONDS = 6;
const SLOW_EWMA_HALF_LIFE_SECONDS = 30;
const STARTUP_UP_HOLD_MS = 10_000;
const STEADY_UP_HOLD_MS = 30_000;
const BASE_RECOVERY_HOLD_MS = 30_000;
const MAX_RECOVERY_HOLD_MS = 120_000;
const UP_BUFFER_SLOPE_MIN = -0.05;
const DOWN_BUFFER_SLOPE_MAX = -0.15;
const STARTUP_UP_VOTES = 2;
const STEADY_UP_VOTES = 3;
const PREVENTIVE_DOWN_VOTES = 2;
const PROBATION_TARGET_FRAGMENTS = 2;
const PROBATION_MAX_FRAGMENTS = 4;
const PROBE_START_MAX_FRAGMENTS = 2;
const REFILL_EVIDENCE_MIN_MAX_AGE_MS = 5_000;
const REFILL_EVIDENCE_MAX_AGE_SEGMENTS = 2;
const REFILL_VISIBLE_DELTA_FRACTION = 0.5;
const UP_LOAD_FACTOR = 0.7;
const DOWN_LOAD_FACTOR = 0.8;

export type HlsAbrPhase = 'startup' | 'steady' | 'probation' | 'recovery' | 'stopped';

export interface HlsAbrLevel {
    bitrate: number;
    index: number;
}

export interface HlsAbrGovernorOptions {
    configuredBufferCapSeconds?: number;
    initialBandwidthEstimate?: number;
    initialBitrate?: number;
    levels: HlsAbrLevel[];
    nowMs: number;
}

export interface HlsAbrFragmentSample {
    aborted?: boolean;
    durationSeconds: number;
    isInitSegment?: boolean;
    isMain: boolean;
    level: number;
    loadedBytes: number;
    loadingEndMs: number;
    loadingFirstMs: number;
    loadingStartMs: number;
    nowMs: number;
}

export interface HlsAbrSnapshot {
    bufferSeconds: number;
    configuredBufferCapSeconds?: number;
    currentLevel: number;
    hlsBandwidthEstimate?: number;
    isEmergency?: boolean;
    isEnded?: boolean;
    isLive?: boolean;
    isPaused?: boolean;
    isSeeking?: boolean;
    isWaiting?: boolean;
    nativeEmergencyLevel?: number;
    nowMs: number;
    playbackRate?: number;
    segmentDurationSeconds: number;
}

export interface HlsAbrDecision {
    capLevel: number;
    forceLevel?: number;
    phase: HlsAbrPhase;
    probeLevel?: number;
    reason: string;
}

export interface HlsAbrState {
    bandwidthEstimate: number;
    bufferSlope: number;
    capLevel: number;
    confidence: number;
    hardCapLevel: number;
    highBufferSeconds: number;
    lastLoadedLevel: number;
    lowBufferSeconds: number;
    lastRefillCredits: number;
    phase: HlsAbrPhase;
    pendingRefillFragments: number;
    predictedCurrentLoadSeconds: number;
    probationLevel: number;
    probationProbePending: boolean;
    recoveryRemainingSeconds: number;
    restoreCapLevel: number;
    serviceBandwidthEstimate: number;
    ttfbEstimateMs: number;
    upHoldRemainingSeconds: number;
    upTargetLevel: number;
    upVotes: number;
}

interface BandwidthSample {
    level: number;
    mediaDurationSeconds: number;
    nowMs: number;
    payloadRate: number;
    serviceRate: number;
    ttfbMs: number;
}

interface BufferSample {
    bufferSeconds: number;
    nowMs: number;
}

interface BufferThresholds {
    critical: number;
    high: number;
    low: number;
    target: number;
}

interface UpshiftEvidence {
    bufferIncreased: boolean;
    newFragmentCount: number;
    previousBufferSeconds?: number;
}

interface CorrelatedRefillEvidence {
    hasCappedBufferRefillEvidence: boolean;
    hasPendingFragments: boolean;
    hasSafeRefillEvidence: boolean;
    invalidated: boolean;
    voteCredits: number;
}

interface EstimatorState {
    confidence: number;
    downCapacity: number;
    serviceCapacity: number;
    ttfbMs: number;
    upCapacity: number;
}

function clamp(value: number, minimum: number, maximum: number) {
    return Math.min(Math.max(value, minimum), maximum);
}

function isPositiveFinite(value: number | undefined): value is number {
    return Number.isFinite(value) && (value || 0) > 0;
}

function normalizeLevels(levels: HlsAbrLevel[]) {
    return levels
        .filter(level => Number.isInteger(level.index) && level.index >= 0 && isPositiveFinite(level.bitrate))
        .sort((first, second) => first.index - second.index);
}

function percentile(values: number[], fraction: number) {
    if (!values.length) {
        return 0;
    }

    const sorted = [...values].sort((first, second) => first - second);
    const index = clamp(Math.ceil(sorted.length * fraction) - 1, 0, sorted.length - 1);
    return sorted[index];
}

function minimumPositive(values: Array<number | undefined>) {
    const positiveValues = values.filter(isPositiveFinite);
    return positiveValues.length ? Math.min(...positiveValues) : 0;
}

function updateEwma(current: number, sample: number, weightSeconds: number, halfLifeSeconds: number) {
    if (!isPositiveFinite(current)) {
        return sample;
    }

    const alpha = 1 - Math.exp((-Math.LN2 * weightSeconds) / halfLifeSeconds);
    return (alpha * sample) + ((1 - alpha) * current);
}

function getBufferSlope(samples: BufferSample[]) {
    if (samples.length < 2) {
        return 0;
    }

    const originMs = samples[0].nowMs;
    const xValues = samples.map(sample => (sample.nowMs - originMs) / 1000);
    const xMean = xValues.reduce((sum, value) => sum + value, 0) / xValues.length;
    const yMean = samples.reduce((sum, sample) => sum + sample.bufferSeconds, 0) / samples.length;
    let numerator = 0;
    let denominator = 0;

    for (let index = 0; index < samples.length; index++) {
        const xDelta = xValues[index] - xMean;
        numerator += xDelta * (samples[index].bufferSeconds - yMean);
        denominator += xDelta * xDelta;
    }

    return denominator > 0 ? numerator / denominator : 0;
}

function getBufferThresholds(segmentDuration: number, configuredCap: number, isLive = false) {
    const safeSegmentDuration = Math.max(segmentDuration, 1);
    const requestedTarget = isLive ?
        clamp(3 * safeSegmentDuration, 6, 18) :
        clamp(8 * safeSegmentDuration, 24, 45);
    const target = configuredCap > 0 ? Math.min(requestedTarget, configuredCap) : requestedTarget;
    const high = isLive ?
        Math.min(Math.max(2 * safeSegmentDuration, 4), target * 0.8) :
        Math.min(Math.max(6 * safeSegmentDuration, 20), target * 0.85);
    const low = isLive ?
        Math.min(Math.max(1.25 * safeSegmentDuration, 2.5), high * 0.65) :
        Math.min(Math.max(3 * safeSegmentDuration, 10), high * 0.6);
    const critical = isLive ?
        Math.min(Math.max(0.75 * safeSegmentDuration, 1.5), low * 0.5) :
        Math.min(Math.max(1.5 * safeSegmentDuration, 4), low * 0.5);

    return { critical, high, low, target };
}

export class HlsAbrGovernor {
    private bandwidthSamples: BandwidthSample[] = [];
    private bufferSamples: BufferSample[] = [];
    private configuredBufferCapSeconds: number;
    private downVotes = 0;
    private fastPayloadEstimate = 0;
    private fragmentCount = 0;
    private hardCapIsExplicit = false;
    private hardCapLevel: number;
    private lastLoadedLevel = -1;
    private lastObservedFragmentCount = 0;
    private lastRefillCredits = 0;
    private lastRiskAt: number;
    private lastSampleAt = 0;
    private lastSnapshot: HlsAbrSnapshot | undefined;
    private levels: HlsAbrLevel[];
    private paused = false;
    private pendingRefillBaselineSeconds = 0;
    private pendingRefillFragmentCount = 0;
    private pendingRefillPlaybackRate = 0;
    private pendingRefillStartedAt = 0;
    private phase: HlsAbrPhase = 'startup';
    private policyCapLevel: number;
    private previousCapLevel: number;
    private probationLevel = -1;
    private probationProbePending = false;
    private probationRaisedCap = false;
    private probationStartFragmentCount = 0;
    private probationTargetFragments = 0;
    private probationValidationProbeIssued = false;
    private recoveryCount = 0;
    private restoreCapLevel = -1;
    private recoveryUntil = 0;
    private slowPayloadEstimate = 0;
    private stopped = false;
    private upTargetLevel: number;
    private upVotes = 0;

    constructor(options: HlsAbrGovernorOptions) {
        this.levels = normalizeLevels(options.levels);
        this.hardCapLevel = this.levels.length ? this.levels[this.levels.length - 1].index : -1;
        this.configuredBufferCapSeconds = options.configuredBufferCapSeconds || 0;
        this.lastRiskAt = options.nowMs;

        const startupBandwidth = isPositiveFinite(options.initialBandwidthEstimate) ?
            options.initialBandwidthEstimate * UP_LOAD_FACTOR :
            options.initialBitrate || DEFAULT_INITIAL_BITRATE;
        this.policyCapLevel = this.findLevelForBitrate(startupBandwidth);
        this.previousCapLevel = this.policyCapLevel;
        this.upTargetLevel = this.policyCapLevel;
    }

    get initialCapLevel() {
        return this.policyCapLevel;
    }

    get hasMultipleLevels() {
        return this.levels.length > 1;
    }

    updateLevels(levels: HlsAbrLevel[]): HlsAbrDecision | null {
        this.clearPendingRefillEvidence();
        const nextLevels = normalizeLevels(levels);
        if (!nextLevels.length) {
            this.levels = [];
            this.hardCapLevel = -1;
            this.lastLoadedLevel = -1;
            this.policyCapLevel = -1;
            this.previousCapLevel = -1;
            this.probationLevel = -1;
            this.restoreCapLevel = -1;
            this.upTargetLevel = -1;
            return null;
        }

        const oldHardCapLevel = this.hardCapLevel;
        const hardCapBitrate = this.getBitrate(this.hardCapLevel);
        const lastLoadedBitrate = this.getBitrate(this.lastLoadedLevel);
        const policyCapBitrate = this.getBitrate(this.policyCapLevel);
        const previousCapBitrate = this.getBitrate(this.previousCapLevel);
        const probationBitrate = this.getBitrate(this.probationLevel);
        const restoreCapBitrate = this.getBitrate(this.restoreCapLevel);
        const upTargetBitrate = this.getBitrate(this.upTargetLevel);

        this.levels = nextLevels;
        const nextHighestLevel = nextLevels[nextLevels.length - 1].index;
        this.hardCapLevel = this.hardCapIsExplicit ?
            Math.min(this.findLevelForBitrate(hardCapBitrate), oldHardCapLevel, nextHighestLevel) :
            nextHighestLevel;
        this.lastLoadedLevel = this.lastLoadedLevel >= 0 ? this.findLevelForBitrate(lastLoadedBitrate) : -1;
        this.policyCapLevel = Math.min(this.findLevelForBitrate(policyCapBitrate), this.hardCapLevel);
        this.previousCapLevel = Math.min(this.findLevelForBitrate(previousCapBitrate), this.hardCapLevel);
        this.probationLevel = this.probationLevel >= 0 ?
            Math.min(this.findLevelForBitrate(probationBitrate), this.hardCapLevel) :
            -1;
        this.restoreCapLevel = this.restoreCapLevel >= 0 ?
            Math.min(this.findLevelForBitrate(restoreCapBitrate), this.hardCapLevel) :
            -1;
        this.clearRestoreCapIfReached();
        this.upTargetLevel = Math.min(this.findLevelForBitrate(upTargetBitrate), this.hardCapLevel);
        return this.createDecision('levels-updated');
    }

    recordFragment(sample: HlsAbrFragmentSample) {
        if (!this.isValidFragmentSample(sample)) {
            return false;
        }

        const payloadDurationMs = sample.loadingEndMs - sample.loadingFirstMs;
        const serviceDurationMs = sample.loadingEndMs - sample.loadingStartMs;
        const loadedBits = sample.loadedBytes * 8;
        const payloadRate = (loadedBits * 1000) / payloadDurationMs;
        const serviceRate = (loadedBits * 1000) / serviceDurationMs;
        const ttfbMs = Math.max(sample.loadingFirstMs - sample.loadingStartMs, 0);
        const weightSeconds = clamp(serviceDurationMs / 1000, 0.05, 5);

        this.fastPayloadEstimate = updateEwma(
            this.fastPayloadEstimate,
            payloadRate,
            weightSeconds,
            FAST_EWMA_HALF_LIFE_SECONDS
        );
        this.slowPayloadEstimate = updateEwma(
            this.slowPayloadEstimate,
            payloadRate,
            weightSeconds,
            SLOW_EWMA_HALF_LIFE_SECONDS
        );
        this.bandwidthSamples.push({
            level: sample.level,
            mediaDurationSeconds: sample.durationSeconds,
            nowMs: sample.nowMs,
            payloadRate,
            serviceRate,
            ttfbMs
        });
        this.pruneBandwidthSamples(sample.nowMs);
        this.fragmentCount += 1;
        this.lastLoadedLevel = this.clampObservedLevel(sample.level);
        if (this.phase === 'probation'
            && this.probationProbePending
            && this.lastLoadedLevel >= this.probationLevel) {
            this.confirmProbe(this.lastLoadedLevel);
        }
        if (this.phase === 'probation'
            && !this.probationProbePending
            && this.lastLoadedLevel >= this.probationLevel) {
            this.probationTargetFragments += 1;
        }
        this.lastSampleAt = sample.nowMs;
        return true;
    }

    observe(snapshot: HlsAbrSnapshot): HlsAbrDecision | null {
        if (this.stopped || !this.hasMultipleLevels) {
            return null;
        }

        this.lastSnapshot = snapshot;
        if (this.shouldSuppress(snapshot)) {
            let reason = 'probation-ended';
            if (snapshot.isPaused) {
                reason = 'probation-paused';
            } else if (snapshot.isSeeking) {
                reason = 'probation-seeking';
            }
            return this.cancelProbation(snapshot.nowMs, reason);
        }

        this.handleResume(snapshot);
        const normalizedBuffer = this.normalizeBuffer(snapshot);
        const previousBuffer = this.bufferSamples[this.bufferSamples.length - 1]?.bufferSeconds;
        const bufferIncreased = previousBuffer != null && normalizedBuffer > previousBuffer;
        const recordedBufferSample = this.recordBufferSample(snapshot.nowMs, normalizedBuffer);
        const newFragmentCount = Math.max(this.fragmentCount - this.lastObservedFragmentCount, 0);
        const hasNewFragment = newFragmentCount > 0;
        const hasFreshEvidence = recordedBufferSample || hasNewFragment;
        this.lastObservedFragmentCount = this.fragmentCount;
        const thresholds = this.getThresholds(snapshot);
        const slope = getBufferSlope(this.bufferSamples);
        const estimator = this.getEstimator(snapshot);
        const currentLevel = this.clampObservedLevel(snapshot.currentLevel);

        if (snapshot.isEmergency && Number.isInteger(snapshot.nativeEmergencyLevel)) {
            return this.adoptNativeEmergencyLevel(currentLevel, snapshot.nativeEmergencyLevel as number, snapshot);
        }

        if (snapshot.isWaiting || snapshot.isEmergency) {
            return this.downshift(currentLevel, estimator, snapshot, 'emergency');
        }

        if (this.phase === 'probation') {
            const probationDecision = this.evaluateProbation(
                currentLevel,
                normalizedBuffer,
                slope,
                estimator,
                snapshot,
                thresholds,
                hasNewFragment
            );
            if (probationDecision) {
                return probationDecision;
            }
        }

        const pressureDecision = this.evaluateBufferPressure(
            currentLevel,
            normalizedBuffer,
            slope,
            estimator,
            snapshot,
            thresholds,
            hasFreshEvidence
        );
        if (pressureDecision) {
            return pressureDecision;
        }

        this.advancePhase(normalizedBuffer, snapshot.nowMs, thresholds);
        return this.evaluateUpshift(
            currentLevel,
            normalizedBuffer,
            slope,
            estimator,
            snapshot,
            thresholds,
            {
                bufferIncreased,
                newFragmentCount,
                previousBufferSeconds: previousBuffer
            }
        );
    }

    confirmProbe(level: number) {
        if (this.phase !== 'probation'
            || !this.probationProbePending
            || level < this.probationLevel) {
            return false;
        }

        this.probationProbePending = false;
        this.probationStartFragmentCount = this.fragmentCount;
        return true;
    }

    rejectProbe(level: number, nowMs: number, reason = 'probe-rejected'): HlsAbrDecision | null {
        if (this.phase !== 'probation'
            || !this.probationProbePending
            || level !== this.probationLevel) {
            return null;
        }

        return this.cancelProbation(nowMs, reason);
    }

    cancelProbation(nowMs: number, reason = 'probation-cancelled'): HlsAbrDecision | null {
        if (this.phase !== 'probation') {
            return null;
        }

        if (this.probationRaisedCap && this.previousCapLevel < this.policyCapLevel) {
            this.policyCapLevel = this.previousCapLevel;
        }
        this.lastRiskAt = nowMs;
        this.upVotes = 0;
        this.upTargetLevel = this.lastLoadedLevel >= 0 ? this.lastLoadedLevel : this.policyCapLevel;
        this.clearProbation();
        this.clearRestoreCapIfReached();
        this.phase = this.isRestoringCap() ? 'startup' : 'steady';
        const decision = this.createDecision(reason);
        decision.forceLevel = Math.min(
            this.lastLoadedLevel >= 0 ? this.lastLoadedLevel : this.policyCapLevel,
            this.policyCapLevel
        );
        return decision;
    }

    setHardCap(level: number): HlsAbrDecision | null {
        const nextHardCap = Math.min(this.hardCapLevel, this.clampLevel(level));
        this.hardCapIsExplicit = true;
        this.hardCapLevel = nextHardCap;
        this.restoreCapLevel = Math.min(this.restoreCapLevel, nextHardCap);
        this.clearRestoreCapIfReached();
        this.upTargetLevel = Math.min(this.upTargetLevel, nextHardCap);
        const cancelledProbation = this.phase === 'probation' && this.probationLevel > nextHardCap;
        if (cancelledProbation) {
            this.phase = 'steady';
            this.clearProbation();
        }
        if (this.policyCapLevel <= nextHardCap) {
            return null;
        }

        this.policyCapLevel = nextHardCap;
        this.upVotes = 0;
        const decision = this.createDecision('hard-cap');
        if (cancelledProbation) {
            decision.forceLevel = Math.min(
                this.lastLoadedLevel >= 0 ? this.lastLoadedLevel : this.policyCapLevel,
                this.policyCapLevel
            );
        }
        return decision;
    }

    resetForSeek(nowMs: number): HlsAbrDecision | null {
        const decision = this.cancelProbation(nowMs, 'probation-seeking');
        this.bufferSamples = [];
        this.clearPendingRefillEvidence();
        this.downVotes = 0;
        this.lastLoadedLevel = -1;
        this.lastObservedFragmentCount = this.fragmentCount;
        this.upVotes = 0;
        this.upTargetLevel = this.policyCapLevel;
        this.phase = 'startup';
        this.clearProbation();
        this.lastRiskAt = nowMs;
        return decision;
    }

    stop() {
        this.stopped = true;
        this.phase = 'stopped';
        this.bandwidthSamples = [];
        this.bufferSamples = [];
        this.clearPendingRefillEvidence();
        this.clearProbation();
    }

    getState(): HlsAbrState {
        const snapshot = this.lastSnapshot;
        const segmentDuration = snapshot?.segmentDurationSeconds || 3;
        const thresholds = snapshot ?
            this.getThresholds(snapshot) :
            getBufferThresholds(segmentDuration, this.getConfiguredCap(snapshot));
        const slope = getBufferSlope(this.bufferSamples);
        const estimator = snapshot ? this.getEstimator(snapshot) : this.getEstimatorFallback();
        const currentLevel = this.clampObservedLevel(snapshot?.currentLevel ?? this.policyCapLevel);
        const nowMs = snapshot?.nowMs ?? this.lastSampleAt;
        const referenceLevel = this.lastLoadedLevel >= 0 ? this.lastLoadedLevel : currentLevel;
        const safeTarget = snapshot ?
            this.findSafeLevel(snapshot, estimator, UP_LOAD_FACTOR, true) :
            this.policyCapLevel;
        const upHoldMs = this.usesStartupUpshiftRules(referenceLevel, safeTarget) ?
            STARTUP_UP_HOLD_MS :
            STEADY_UP_HOLD_MS;

        return {
            bandwidthEstimate: estimator.upCapacity,
            bufferSlope: slope,
            capLevel: this.policyCapLevel,
            confidence: estimator.confidence,
            hardCapLevel: this.hardCapLevel,
            highBufferSeconds: thresholds.high,
            lastLoadedLevel: this.lastLoadedLevel,
            lastRefillCredits: this.lastRefillCredits,
            lowBufferSeconds: thresholds.low,
            phase: this.phase,
            pendingRefillFragments: this.pendingRefillFragmentCount,
            predictedCurrentLoadSeconds: this.predictLoadSeconds(currentLevel, segmentDuration, estimator.downCapacity, estimator.ttfbMs),
            probationLevel: this.probationLevel,
            probationProbePending: this.probationProbePending,
            recoveryRemainingSeconds: this.phase === 'recovery' ?
                Math.max(this.recoveryUntil - nowMs, 0) / 1000 :
                0,
            restoreCapLevel: this.restoreCapLevel,
            serviceBandwidthEstimate: estimator.serviceCapacity,
            ttfbEstimateMs: estimator.ttfbMs,
            upHoldRemainingSeconds: Math.max((this.lastRiskAt + upHoldMs) - nowMs, 0) / 1000,
            upTargetLevel: this.upTargetLevel,
            upVotes: this.upVotes
        };
    }

    private isValidFragmentSample(sample: HlsAbrFragmentSample) {
        return !this.stopped
            && sample.isMain
            && !sample.isInitSegment
            && !sample.aborted
            && Number.isInteger(sample.level)
            && sample.level >= 0
            && sample.loadedBytes >= 32 * 1024
            && isPositiveFinite(sample.durationSeconds)
            && sample.loadingFirstMs >= sample.loadingStartMs
            && sample.loadingEndMs > sample.loadingFirstMs;
    }

    private shouldSuppress(snapshot: HlsAbrSnapshot) {
        const suppressed = Boolean(snapshot.isPaused || snapshot.isSeeking || snapshot.isEnded);
        if (suppressed) {
            this.bufferSamples = [];
            this.clearPendingRefillEvidence();
            this.downVotes = 0;
            this.upVotes = 0;
            this.paused = Boolean(snapshot.isPaused);
        }
        return suppressed;
    }

    private handleResume(snapshot: HlsAbrSnapshot) {
        if (!this.paused) {
            return;
        }

        this.paused = false;
        this.bufferSamples = [];
        this.clearPendingRefillEvidence();
        this.lastRiskAt = snapshot.nowMs;
        this.phase = 'startup';
        this.clearProbation();
    }

    private normalizeBuffer(snapshot: HlsAbrSnapshot) {
        return Math.max(snapshot.bufferSeconds, 0) / this.getPlaybackRate(snapshot);
    }

    private recordBufferSample(nowMs: number, bufferSeconds: number) {
        const lastSample = this.bufferSamples[this.bufferSamples.length - 1];
        if (lastSample && nowMs - lastSample.nowMs < MIN_BUFFER_SAMPLE_INTERVAL_MS) {
            return false;
        }

        this.bufferSamples.push({ bufferSeconds, nowMs });
        const minimumTime = nowMs - BUFFER_SAMPLE_WINDOW_MS;
        this.bufferSamples = this.bufferSamples.filter(sample => sample.nowMs >= minimumTime);
        return true;
    }

    private getThresholds(snapshot: HlsAbrSnapshot) {
        const playbackRate = this.getPlaybackRate(snapshot);
        const configuredCap = this.getConfiguredCap(snapshot);
        return getBufferThresholds(
            snapshot.segmentDurationSeconds / playbackRate,
            configuredCap > 0 ? configuredCap / playbackRate : 0,
            Boolean(snapshot.isLive)
        );
    }

    private getPlaybackRate(snapshot: HlsAbrSnapshot) {
        return isPositiveFinite(snapshot.playbackRate) ? snapshot.playbackRate : 1;
    }

    private getConfiguredCap(snapshot: HlsAbrSnapshot | undefined) {
        const snapshotCap = snapshot?.configuredBufferCapSeconds || 0;
        return snapshotCap || this.configuredBufferCapSeconds;
    }

    private getEstimator(snapshot: HlsAbrSnapshot): EstimatorState {
        this.pruneBandwidthSamples(snapshot.nowMs);
        const payloadRates = this.bandwidthSamples.map(sample => sample.payloadRate);
        const serviceRates = this.bandwidthSamples.map(sample => sample.serviceRate);
        const ttfbValues = this.bandwidthSamples.map(sample => sample.ttfbMs);
        const hlsEstimate = snapshot.hlsBandwidthEstimate;
        const upCapacity = minimumPositive([
            this.slowPayloadEstimate,
            percentile(payloadRates, 0.25),
            hlsEstimate
        ]);
        const downCapacity = minimumPositive([
            this.fastPayloadEstimate,
            this.slowPayloadEstimate,
            hlsEstimate
        ]);

        return {
            confidence: this.bandwidthSamples.length,
            downCapacity,
            serviceCapacity: percentile(serviceRates, 0.25),
            ttfbMs: percentile(ttfbValues, 0.75),
            upCapacity
        };
    }

    private getEstimatorFallback(): EstimatorState {
        const payloadRates = this.bandwidthSamples.map(sample => sample.payloadRate);
        const serviceRates = this.bandwidthSamples.map(sample => sample.serviceRate);
        const ttfbValues = this.bandwidthSamples.map(sample => sample.ttfbMs);
        return {
            confidence: this.bandwidthSamples.length,
            downCapacity: minimumPositive([this.fastPayloadEstimate, this.slowPayloadEstimate]),
            serviceCapacity: percentile(serviceRates, 0.25),
            ttfbMs: percentile(ttfbValues, 0.75),
            upCapacity: minimumPositive([this.slowPayloadEstimate, percentile(payloadRates, 0.25)])
        };
    }

    private pruneBandwidthSamples(nowMs: number) {
        const minimumTime = nowMs - BANDWIDTH_SAMPLE_WINDOW_MS;
        this.bandwidthSamples = this.bandwidthSamples
            .filter(sample => sample.nowMs >= minimumTime)
            .slice(-12);
    }

    private evaluateProbation(
        currentLevel: number,
        bufferSeconds: number,
        slope: number,
        estimator: EstimatorState,
        snapshot: HlsAbrSnapshot,
        thresholds: BufferThresholds,
        hasNewFragment: boolean
    ) {
        if (this.isProbationUnsafe(bufferSeconds, slope, estimator, snapshot, thresholds)) {
            return this.rollbackProbation(currentLevel, estimator, snapshot);
        }

        if (this.probationTargetFragments >= PROBATION_TARGET_FRAGMENTS) {
            this.completeProbation();
            return null;
        }

        if (this.probationProbePending) {
            return this.evaluatePendingProbe(snapshot.nowMs);
        }

        if (this.shouldIssueProbationValidationProbe(hasNewFragment)) {
            this.probationValidationProbeIssued = true;
            this.probationProbePending = true;
            this.probationStartFragmentCount = this.fragmentCount;
            const decision = this.createDecision('probation-validation-probe');
            decision.probeLevel = this.probationLevel;
            return decision;
        }

        if (this.fragmentCount - this.probationStartFragmentCount >= PROBATION_MAX_FRAGMENTS) {
            return this.timeoutProbation(currentLevel, snapshot.nowMs);
        }

        return null;
    }

    private isProbationUnsafe(
        bufferSeconds: number,
        slope: number,
        estimator: EstimatorState,
        snapshot: HlsAbrSnapshot,
        thresholds: BufferThresholds
    ) {
        const bufferIsUnsafe = bufferSeconds <= thresholds.low && slope <= DOWN_BUFFER_SLOPE_MAX;
        const targetIsSafe = this.probationLevel >= 0
            && this.isLevelSafe(this.probationLevel, snapshot, estimator, DOWN_LOAD_FACTOR, false);
        return bufferIsUnsafe || !targetIsSafe;
    }

    private completeProbation() {
        this.clearProbation();
        this.clearRestoreCapIfReached();
        this.phase = this.isRestoringCap() ? 'startup' : 'steady';
    }

    private evaluatePendingProbe(nowMs: number) {
        if (this.fragmentCount - this.probationStartFragmentCount >= PROBE_START_MAX_FRAGMENTS) {
            return this.rejectProbe(this.probationLevel, nowMs, 'probe-start-timeout');
        }
        return null;
    }

    private timeoutProbation(currentLevel: number, nowMs: number) {
        const shouldRestoreCap = this.probationRaisedCap && this.previousCapLevel < this.policyCapLevel;
        if (shouldRestoreCap) {
            this.policyCapLevel = this.previousCapLevel;
        }
        this.phase = 'steady';
        this.lastRiskAt = nowMs;
        this.upVotes = 0;
        this.upTargetLevel = this.lastLoadedLevel >= 0 ? this.lastLoadedLevel : currentLevel;
        this.clearProbation();
        return shouldRestoreCap ? this.createDecision('probation-timeout') : null;
    }

    private evaluateBufferPressure(
        currentLevel: number,
        bufferSeconds: number,
        slope: number,
        estimator: EstimatorState,
        snapshot: HlsAbrSnapshot,
        thresholds: BufferThresholds,
        hasFreshEvidence: boolean
    ) {
        const currentIsSafe = this.isLevelSafe(currentLevel, snapshot, estimator, DOWN_LOAD_FACTOR, false);
        const isCritical = bufferSeconds <= thresholds.critical
            && estimator.confidence > 0
            && (slope <= DOWN_BUFFER_SLOPE_MAX || !currentIsSafe);
        if (isCritical && hasFreshEvidence) {
            return this.downshift(currentLevel, estimator, snapshot, 'critical-buffer');
        }

        const hasPreventivePressure = bufferSeconds <= thresholds.low
            && slope <= DOWN_BUFFER_SLOPE_MAX
            && !currentIsSafe;
        if (!hasPreventivePressure) {
            this.downVotes = 0;
        } else if (hasFreshEvidence) {
            this.downVotes += 1;
        }
        if (this.downVotes >= PREVENTIVE_DOWN_VOTES) {
            return this.downshift(currentLevel, estimator, snapshot, 'buffer-pressure');
        }

        return null;
    }

    private advancePhase(bufferSeconds: number, nowMs: number, thresholds: BufferThresholds) {
        if (this.phase === 'recovery' && nowMs >= this.recoveryUntil && bufferSeconds >= thresholds.low) {
            this.phase = 'startup';
        }

        if (this.phase === 'startup'
            && !this.isRestoringCap()
            && this.fragmentCount >= 4
            && bufferSeconds >= thresholds.high
            && nowMs - this.lastRiskAt >= STEADY_UP_HOLD_MS) {
            this.phase = 'steady';
        }
    }

    private evaluateUpshift(
        currentLevel: number,
        bufferSeconds: number,
        slope: number,
        estimator: EstimatorState,
        snapshot: HlsAbrSnapshot,
        thresholds: BufferThresholds,
        evidence: UpshiftEvidence
    ) {
        const referenceLevel = this.lastLoadedLevel >= 0 ? this.lastLoadedLevel : currentLevel;
        if (this.phase === 'probation') {
            return this.rejectUpshift(true);
        }

        const safeTarget = this.findSafeLevel(snapshot, estimator, UP_LOAD_FACTOR, true);
        const refillEvidence = this.correlateRefillEvidence(
            referenceLevel,
            safeTarget,
            bufferSeconds,
            snapshot,
            thresholds,
            evidence
        );
        const policy = this.getUpshiftPolicy(
            referenceLevel,
            safeTarget,
            thresholds,
            refillEvidence
        );
        const resetUncorrelatedEvidence = this.shouldResetUncorrelatedRefillEvidence(
            evidence,
            refillEvidence
        );
        if (this.phase === 'recovery' && !policy.hasSafeRefillEvidence) {
            return this.rejectUpshift(resetUncorrelatedEvidence, referenceLevel);
        }
        // HLS pauses fetching at its forward-buffer cap. Poll samples then
        // resemble a drain even while completed fragments refill a safe,
        // high reservoir. Such refills may vote, but every other
        // confidence, capacity, hold, and probation guard still applies.
        if (this.hasUnsafeUpshiftSlope(slope, refillEvidence)) {
            return this.rejectUpshift(resetUncorrelatedEvidence, referenceLevel);
        }

        if (!this.canConsiderUpshift(bufferSeconds, estimator, snapshot.nowMs, policy)) {
            return this.rejectUpshift(
                evidence.newFragmentCount > 0
                    || refillEvidence.voteCredits > 0
                    || refillEvidence.invalidated,
                referenceLevel
            );
        }

        const voteCredits = this.getUpshiftVoteCredits(evidence, refillEvidence);
        if (voteCredits <= 0) {
            return null;
        }
        if (evidence.newFragmentCount > 0 && refillEvidence.voteCredits === 0) {
            this.clearPendingRefillEvidence();
        }

        const target = this.getNextUpshiftLevel(referenceLevel, safeTarget);
        const targetChanged = target !== this.upTargetLevel;
        this.upTargetLevel = target;
        if (targetChanged) {
            this.upVotes = 0;
        }
        if (target <= referenceLevel) {
            this.upVotes = 0;
        } else {
            this.upVotes += Math.min(voteCredits, policy.requiredVotes);
        }
        if (this.upVotes < policy.requiredVotes) {
            return null;
        }

        return this.beginUpshiftProbation(target);
    }

    private shouldResetUncorrelatedRefillEvidence(
        evidence: UpshiftEvidence,
        refillEvidence: CorrelatedRefillEvidence
    ) {
        return refillEvidence.invalidated
            || (evidence.newFragmentCount > 0
                && !refillEvidence.hasPendingFragments
                && refillEvidence.voteCredits === 0);
    }

    private hasUnsafeUpshiftSlope(slope: number, refillEvidence: CorrelatedRefillEvidence) {
        return slope < UP_BUFFER_SLOPE_MIN
            && !refillEvidence.hasSafeRefillEvidence
            && !refillEvidence.hasCappedBufferRefillEvidence;
    }

    private getUpshiftVoteCredits(
        evidence: UpshiftEvidence,
        refillEvidence: CorrelatedRefillEvidence
    ) {
        const directFragmentCredit = evidence.newFragmentCount > 0 ? 1 : 0;
        return Math.max(directFragmentCredit, refillEvidence.voteCredits);
    }

    private correlateRefillEvidence(
        referenceLevel: number,
        safeTarget: number,
        bufferSeconds: number,
        snapshot: HlsAbrSnapshot,
        thresholds: BufferThresholds,
        evidence: UpshiftEvidence
    ): CorrelatedRefillEvidence {
        const playbackRate = this.getPlaybackRate(snapshot);
        const segmentDuration = Math.max(snapshot.segmentDurationSeconds / playbackRate, 1);
        const maximumAgeMs = Math.max(
            REFILL_EVIDENCE_MIN_MAX_AGE_MS,
            segmentDuration * REFILL_EVIDENCE_MAX_AGE_SEGMENTS * 1_000
        );
        const invalidated = this.invalidatePendingRefillEvidence(
            snapshot.nowMs,
            maximumAgeMs,
            playbackRate
        );

        const isRiskRecovery = this.isRestoringCap() && referenceLevel < safeTarget;
        const configuredBufferCap = this.getConfiguredCap(snapshot) / playbackRate;
        const canUseCappedEvidence = configuredBufferCap > 0 && !snapshot.isLive;
        if (!isRiskRecovery && !canUseCappedEvidence) {
            this.clearPendingRefillEvidence();
            return {
                hasCappedBufferRefillEvidence: false,
                hasPendingFragments: false,
                hasSafeRefillEvidence: false,
                invalidated,
                voteCredits: 0
            };
        }

        this.recordPendingRefillObservation(
            evidence,
            bufferSeconds,
            snapshot.nowMs,
            playbackRate,
            invalidated
        );
        const delayedCredits = this.getDelayedRefillCredits(
            bufferSeconds,
            segmentDuration
        );
        const directFragmentCredit = evidence.newFragmentCount > 0 ? 1 : 0;
        const safeRefillCredits = this.getSafeRefillCredits(
            isRiskRecovery,
            bufferSeconds,
            thresholds.low,
            directFragmentCredit,
            delayedCredits
        );
        const cappedRefillCredits = this.getCappedRefillCredits(
            canUseCappedEvidence,
            bufferSeconds,
            thresholds.high,
            evidence.bufferIncreased,
            directFragmentCredit,
            delayedCredits
        );
        const voteCredits = Math.max(safeRefillCredits, cappedRefillCredits);
        const hasSafeRefillEvidence = safeRefillCredits > 0;
        const hasCappedBufferRefillEvidence = cappedRefillCredits > 0;
        if (voteCredits > 0) {
            this.lastRefillCredits = voteCredits;
            this.clearPendingRefillEvidence();
        }

        return {
            hasCappedBufferRefillEvidence,
            hasPendingFragments: this.pendingRefillFragmentCount > 0,
            hasSafeRefillEvidence,
            invalidated,
            voteCredits
        };
    }

    private invalidatePendingRefillEvidence(
        nowMs: number,
        maximumAgeMs: number,
        playbackRate: number
    ) {
        const hasPendingFragments = this.pendingRefillFragmentCount > 0;
        const expired = hasPendingFragments
            && nowMs - this.pendingRefillStartedAt > maximumAgeMs;
        const playbackRateChanged = hasPendingFragments
            && playbackRate !== this.pendingRefillPlaybackRate;
        const invalidated = expired || playbackRateChanged;
        if (invalidated) {
            this.clearPendingRefillEvidence();
        }
        return invalidated;
    }

    private recordPendingRefillObservation(
        evidence: UpshiftEvidence,
        bufferSeconds: number,
        nowMs: number,
        playbackRate: number,
        useCurrentBufferAsBaseline: boolean
    ) {
        if (evidence.newFragmentCount <= 0) {
            return;
        }
        if (this.pendingRefillFragmentCount === 0) {
            this.pendingRefillBaselineSeconds = useCurrentBufferAsBaseline ?
                bufferSeconds :
                evidence.previousBufferSeconds ?? bufferSeconds;
            this.pendingRefillPlaybackRate = playbackRate;
            this.pendingRefillStartedAt = nowMs;
        }
        // A callback burst can expose several already-completed fragments
        // at once. Count the observation epoch, not every queued fragment;
        // delayed WebKit range updates still accumulate across distinct
        // FRAG_BUFFERED observations.
        this.pendingRefillFragmentCount += 1;
    }

    private getDelayedRefillCredits(bufferSeconds: number, segmentDuration: number) {
        const visibleDelta = Math.max(bufferSeconds - this.pendingRefillBaselineSeconds, 0);
        const minimumVisibleDelta = Math.max(
            segmentDuration * REFILL_VISIBLE_DELTA_FRACTION,
            0.5
        );
        if (visibleDelta < minimumVisibleDelta) {
            return 0;
        }

        const inferredAddedFragments = Math.max(
            1,
            Math.floor((visibleDelta + (segmentDuration * 0.25)) / segmentDuration)
        );
        return Math.min(this.pendingRefillFragmentCount, inferredAddedFragments);
    }

    private getSafeRefillCredits(
        isRiskRecovery: boolean,
        bufferSeconds: number,
        lowBufferSeconds: number,
        directFragmentCredit: number,
        delayedCredits: number
    ) {
        if (!isRiskRecovery || bufferSeconds < lowBufferSeconds) {
            return 0;
        }
        return Math.max(directFragmentCredit, delayedCredits);
    }

    private getCappedRefillCredits(
        canUseCappedEvidence: boolean,
        bufferSeconds: number,
        highBufferSeconds: number,
        bufferIncreased: boolean,
        directFragmentCredit: number,
        delayedCredits: number
    ) {
        const hasVisibleRefill = bufferIncreased || delayedCredits > 0;
        if (!canUseCappedEvidence || bufferSeconds < highBufferSeconds || !hasVisibleRefill) {
            return 0;
        }

        const increasedDirectCredit = bufferIncreased ? directFragmentCredit : 0;
        return Math.max(increasedDirectCredit, delayedCredits);
    }

    private getUpshiftPolicy(
        referenceLevel: number,
        safeTarget: number,
        thresholds: BufferThresholds,
        refillEvidence: CorrelatedRefillEvidence
    ) {
        const useStartupRules = this.usesStartupUpshiftRules(referenceLevel, safeTarget);
        return {
            hasSafeRefillEvidence: refillEvidence.hasSafeRefillEvidence,
            hasCappedBufferRefillEvidence: refillEvidence.hasCappedBufferRefillEvidence,
            requiredBuffer: useStartupRules ? thresholds.low : thresholds.high,
            requiredConfidence: useStartupRules ? 2 : 4,
            requiredHold: useStartupRules ? STARTUP_UP_HOLD_MS : STEADY_UP_HOLD_MS,
            requiredVotes: useStartupRules ? STARTUP_UP_VOTES : STEADY_UP_VOTES
        };
    }

    private canConsiderUpshift(
        bufferSeconds: number,
        estimator: EstimatorState,
        nowMs: number,
        policy: ReturnType<HlsAbrGovernor['getUpshiftPolicy']>
    ) {
        return bufferSeconds >= policy.requiredBuffer
            && estimator.confidence >= policy.requiredConfidence
            && nowMs - this.lastRiskAt >= policy.requiredHold;
    }

    private usesStartupUpshiftRules(referenceLevel: number, safeTarget: number) {
        const isSelectorRecovery = referenceLevel < Math.min(this.policyCapLevel, safeTarget);
        const isRiskRecovery = this.isRestoringCap() && referenceLevel < safeTarget;
        return this.phase === 'startup' || isSelectorRecovery || isRiskRecovery;
    }

    private rejectUpshift(resetVotes: boolean, referenceLevel?: number) {
        if (resetVotes) {
            this.upVotes = 0;
            if (referenceLevel != null) {
                this.upTargetLevel = referenceLevel;
            }
        }
        return null;
    }

    private beginUpshiftProbation(target: number) {
        this.clearPendingRefillEvidence();
        this.previousCapLevel = this.policyCapLevel;
        const raisedCap = target > this.policyCapLevel;
        if (raisedCap) {
            this.policyCapLevel = target;
        }
        this.phase = 'probation';
        this.probationLevel = target;
        this.probationProbePending = true;
        this.probationRaisedCap = raisedCap;
        this.probationStartFragmentCount = this.fragmentCount;
        this.probationTargetFragments = 0;
        this.probationValidationProbeIssued = false;
        this.upVotes = 0;
        const decision = this.createDecision(raisedCap ? 'bandwidth-buffer-up' : 'native-lag-probe');
        decision.probeLevel = target;
        return decision;
    }

    private downshift(
        currentLevel: number,
        estimator: EstimatorState,
        snapshot: HlsAbrSnapshot,
        reason: string,
        maximumTarget = this.policyCapLevel
    ) {
        const safeLevel = this.findSafeLevel(snapshot, estimator, DOWN_LOAD_FACTOR, false);
        const target = this.findDownshiftTarget(currentLevel, Math.min(safeLevel, maximumTarget, this.policyCapLevel));
        if (target == null) {
            const floorRiskCap = Math.min(this.policyCapLevel, currentLevel);
            if (floorRiskCap < this.policyCapLevel) {
                this.markRestoreCap(this.getTrustedCapLevel());
                this.previousCapLevel = this.policyCapLevel;
                this.policyCapLevel = floorRiskCap;
                this.enterRecovery(snapshot.nowMs);
                return this.createDecision(reason);
            }
            this.noteRiskWithoutSwitch(snapshot.nowMs);
            return null;
        }

        if (target < this.policyCapLevel) {
            this.markRestoreCap(this.getTrustedCapLevel());
        }
        this.previousCapLevel = this.policyCapLevel;
        this.policyCapLevel = target;
        this.enterRecovery(snapshot.nowMs);
        const decision = this.createDecision(reason);
        decision.forceLevel = target;
        return decision;
    }

    private rollbackProbation(currentLevel: number, estimator: EstimatorState, snapshot: HlsAbrSnapshot) {
        const safeLevel = this.findSafeLevel(snapshot, estimator, DOWN_LOAD_FACTOR, false);
        const rollbackCeiling = this.probationRaisedCap ?
            this.previousCapLevel :
            Math.min(this.policyCapLevel, currentLevel);
        const target = this.clampLevel(Math.min(rollbackCeiling, safeLevel));
        if (target < this.policyCapLevel) {
            this.markRestoreCap(this.getTrustedCapLevel());
            this.previousCapLevel = this.policyCapLevel;
            this.policyCapLevel = target;
        }

        this.clearRestoreCapIfReached();
        this.enterRecovery(snapshot.nowMs);
        const decision = this.createDecision('probation-failed');
        if (target < currentLevel) {
            decision.forceLevel = target;
        }
        return decision;
    }

    private adoptNativeEmergencyLevel(currentLevel: number, nativeEmergencyLevel: number, snapshot: HlsAbrSnapshot) {
        const target = this.clampLevel(nativeEmergencyLevel);
        if (target >= currentLevel) {
            this.noteRiskWithoutSwitch(snapshot.nowMs);
            return null;
        }

        const nextPolicyCap = Math.min(this.policyCapLevel, target);
        if (this.phase === 'recovery' && nextPolicyCap === this.policyCapLevel) {
            return null;
        }

        if (nextPolicyCap < this.policyCapLevel) {
            this.markRestoreCap(this.getTrustedCapLevel());
        }
        this.previousCapLevel = this.policyCapLevel;
        this.policyCapLevel = nextPolicyCap;
        this.enterRecovery(snapshot.nowMs);
        return this.createDecision('emergency');
    }

    private noteRiskWithoutSwitch(nowMs: number) {
        if (this.phase === 'probation') {
            this.enterRecovery(nowMs);
            return;
        }

        // Repeated floor-level waiting/emergency events are common between
        // mobile HLS refill bursts. The cap cannot move lower, so renewing the
        // recovery window would permanently starve a trusted restore target.
        if (this.isRestoringCap()) {
            this.clearPendingRefillEvidence();
            this.downVotes = 0;
            this.upVotes = 0;
            this.upTargetLevel = this.policyCapLevel;
            return;
        }

        if (this.phase === 'recovery') {
            this.enterRecovery(nowMs);
            return;
        }

        this.clearPendingRefillEvidence();
        this.lastRiskAt = nowMs;
        this.downVotes = 0;
        this.upVotes = 0;
    }

    private enterRecovery(nowMs: number) {
        this.clearPendingRefillEvidence();
        this.phase = 'recovery';
        this.clearProbation();
        this.lastRiskAt = nowMs;
        this.downVotes = 0;
        this.upVotes = 0;
        this.upTargetLevel = this.policyCapLevel;
        this.recoveryCount = nowMs < this.recoveryUntil + MAX_RECOVERY_HOLD_MS ?
            this.recoveryCount + 1 :
            1;
        const holdMultiplier = 2 ** Math.min(this.recoveryCount - 1, 2);
        this.recoveryUntil = nowMs + Math.min(BASE_RECOVERY_HOLD_MS * holdMultiplier, MAX_RECOVERY_HOLD_MS);
    }

    private findSafeLevel(snapshot: HlsAbrSnapshot, estimator: EstimatorState, factor: number, useUpCapacity: boolean) {
        const capacity = useUpCapacity ? estimator.upCapacity : estimator.downCapacity;
        let selectedLevel = this.levels[0]?.index ?? -1;

        for (const level of this.levels) {
            if (level.index > this.hardCapLevel) {
                break;
            }

            if (!this.isLevelSafe(level.index, snapshot, estimator, factor, useUpCapacity)) {
                break;
            }

            selectedLevel = level.index;
        }

        if (!isPositiveFinite(capacity)) {
            return Math.min(this.policyCapLevel, this.hardCapLevel);
        }

        return selectedLevel;
    }

    private isLevelSafe(
        levelIndex: number,
        snapshot: HlsAbrSnapshot,
        estimator: EstimatorState,
        factor: number,
        useUpCapacity: boolean
    ) {
        const bitrate = this.getBitrate(levelIndex);
        const capacity = useUpCapacity ? estimator.upCapacity : estimator.downCapacity;
        if (!isPositiveFinite(bitrate) || !isPositiveFinite(capacity)) {
            return false;
        }

        const playbackRate = this.getPlaybackRate(snapshot);
        const predictedLoad = this.predictLoadSeconds(
            levelIndex,
            snapshot.segmentDurationSeconds,
            capacity,
            estimator.ttfbMs
        );
        const serviceIsSafe = !isPositiveFinite(estimator.serviceCapacity)
            || bitrate * playbackRate <= estimator.serviceCapacity * factor;
        const loadDeadline = snapshot.segmentDurationSeconds / playbackRate;
        return predictedLoad <= loadDeadline * factor && serviceIsSafe;
    }

    private predictLoadSeconds(levelIndex: number, segmentDuration: number, capacity: number, ttfbMs: number) {
        const bitrate = this.getBitrate(levelIndex);
        if (!isPositiveFinite(bitrate) || !isPositiveFinite(capacity)) {
            return 0;
        }

        return (ttfbMs / 1000) + ((segmentDuration * bitrate) / capacity);
    }

    private getNextUpshiftLevel(referenceLevel: number, safeTarget: number) {
        const maximumTarget = Math.min(safeTarget, this.hardCapLevel);
        return this.levels.find(level => level.index > referenceLevel && level.index <= maximumTarget)?.index
            ?? Math.min(referenceLevel, this.hardCapLevel);
    }

    private findLevelForBitrate(maxBitrate: number) {
        let selectedLevel = this.levels[0]?.index ?? -1;
        for (const level of this.levels) {
            if (level.bitrate > maxBitrate) {
                break;
            }

            selectedLevel = level.index;
        }
        return selectedLevel;
    }

    private findDownshiftTarget(currentLevel: number, maximumTarget: number) {
        const currentPosition = this.levels.findIndex(level => level.index === currentLevel);
        if (currentPosition <= 0) {
            return null;
        }

        const currentBitrate = this.getBitrate(currentLevel);
        for (let position = currentPosition - 1; position >= 0; position--) {
            const candidate = this.levels[position];
            if (candidate.index > maximumTarget || candidate.index > this.hardCapLevel) {
                continue;
            }

            if (!isPositiveFinite(currentBitrate) || candidate.bitrate <= currentBitrate) {
                return candidate.index;
            }
        }

        return null;
    }

    private clampLevel(level: number) {
        if (!this.levels.length) {
            return -1;
        }

        const maximumLevel = Math.min(level, this.hardCapLevel);
        let selectedLevel = this.levels[0].index;
        for (const candidate of this.levels) {
            if (candidate.index > maximumLevel || candidate.index > this.hardCapLevel) {
                break;
            }

            selectedLevel = candidate.index;
        }
        return selectedLevel;
    }

    private clampObservedLevel(level: number) {
        if (!this.levels.length) {
            return -1;
        }

        let selectedLevel = this.levels[0].index;
        for (const candidate of this.levels) {
            if (candidate.index > level) {
                break;
            }

            selectedLevel = candidate.index;
        }
        return selectedLevel;
    }

    private clearProbation() {
        this.probationLevel = -1;
        this.probationProbePending = false;
        this.probationRaisedCap = false;
        this.probationStartFragmentCount = 0;
        this.probationTargetFragments = 0;
        this.probationValidationProbeIssued = false;
    }

    private clearPendingRefillEvidence() {
        this.pendingRefillBaselineSeconds = 0;
        this.pendingRefillFragmentCount = 0;
        this.pendingRefillPlaybackRate = 0;
        this.pendingRefillStartedAt = 0;
    }

    private shouldIssueProbationValidationProbe(hasNewFragment: boolean) {
        return hasNewFragment
            && this.probationTargetFragments === 1
            && this.lastLoadedLevel < this.probationLevel
            && !this.probationValidationProbeIssued;
    }

    private isRestoringCap() {
        return this.restoreCapLevel > this.policyCapLevel;
    }

    private getTrustedCapLevel() {
        return this.phase === 'probation' && this.probationRaisedCap ?
            this.previousCapLevel :
            this.policyCapLevel;
    }

    private markRestoreCap(level: number) {
        const target = Math.min(this.clampLevel(level), this.hardCapLevel);
        this.restoreCapLevel = Math.max(this.restoreCapLevel, target);
    }

    private clearRestoreCapIfReached() {
        if (this.restoreCapLevel >= 0 && this.policyCapLevel >= this.restoreCapLevel) {
            this.restoreCapLevel = -1;
        }
    }

    private getBitrate(levelIndex: number) {
        return this.levels.find(level => level.index === levelIndex)?.bitrate || 0;
    }

    private createDecision(reason: string): HlsAbrDecision {
        return {
            capLevel: this.policyCapLevel,
            phase: this.phase,
            reason
        };
    }
}
