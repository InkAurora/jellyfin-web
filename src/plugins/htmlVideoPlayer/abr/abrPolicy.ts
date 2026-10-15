import { AbrEstimator, type AbrFragmentSample } from './abrEstimator';

const DEFAULT_INITIAL_BITRATE = 6_000_000;

export interface AbrTuning {
    /** How many times the dwell time grows after each failed up-switch. */
    backoffGrowth: number;
    /** After this long with no failed up-switch, the back-off goes down one step. */
    backoffDecayMs: number;
    baseDwellMs: number;
    /** The switch cost to assume before the first switch was measured. */
    defaultSwitchCostMs: number;
    /** Safety factor for the target of a down-switch, so one switch is enough. */
    downTargetFactor: number;
    /** A down-switch this soon after an up-switch counts as a failed up-switch. */
    failedUpWindowMs: number;
    /** The same window as a number of segments, for long segments. */
    failedUpWindowSegments: number;
    fastHalfLifeSeconds: number;
    /** Safety factors: a level is safe when fetch time <= segment time x factor. */
    highBufferFactor: number;
    lowBufferFactor: number;
    maxDwellMs: number;
    maxStartFetchSeconds: number;
    maxVbrRatio: number;
    midBufferFactor: number;
    slowHalfLifeSeconds: number;
    /** The dwell time is at least this many times the measured switch cost. */
    switchCostDwellMultiple: number;
    upFactor: number;
}

export const DEFAULT_ABR_TUNING: AbrTuning = {
    backoffDecayMs: 120_000,
    backoffGrowth: 2,
    baseDwellMs: 10_000,
    defaultSwitchCostMs: 1_000,
    downTargetFactor: 1,
    failedUpWindowMs: 30_000,
    failedUpWindowSegments: 6,
    fastHalfLifeSeconds: 3,
    highBufferFactor: 1,
    lowBufferFactor: 0.7,
    maxDwellMs: 80_000,
    maxStartFetchSeconds: 2,
    maxVbrRatio: 1.5,
    midBufferFactor: 0.85,
    slowHalfLifeSeconds: 10,
    switchCostDwellMultiple: 5,
    upFactor: 0.7
};

export interface AbrLevel {
    bitrate: number;
    index: number;
}

export interface AbrPolicyOptions {
    /** A measured bandwidth from an earlier session, in bits/s. */
    initialBandwidthEstimate?: number;
    /** A bitrate that is known to be safe, in bits/s. */
    initialBitrate?: number;
    levels: AbrLevel[];
    tuning?: Partial<AbrTuning>;
}

export interface AbrContext {
    bufferSeconds: number;
    /** The forward buffer limit of the player, 0 when not known. */
    bufferCapSeconds: number;
    /** Returns false when a switch between two levels must not happen (codec, HDR, frame rate). */
    isSwitchAllowed?: (fromLevel: number, toLevel: number) => boolean;
    isLive: boolean;
    maxLevel: number;
    minLevel: number;
    nowMs: number;
    playbackRate: number;
    segmentDurationSeconds: number;
}

export interface AbrBufferThresholds {
    high: number;
    low: number;
}

export interface AbrDebugState {
    currentLevel: number;
    dwellRemainingSeconds: number;
    dwellSeconds: number;
    failedUpSwitches: number;
    lastReason: string;
    samples: number;
    switchCostMs: number;
    throughput: number;
    ttfbMs: number;
    vbr: number;
}

function isPositiveFinite(value: number | undefined): value is number {
    return Number.isFinite(value) && (value || 0) > 0;
}

function normalizeLevels(levels: AbrLevel[]) {
    return levels
        .filter(level => Number.isInteger(level.index) && level.index >= 0 && isPositiveFinite(level.bitrate))
        .sort((first, second) => first.index - second.index);
}

export function getAbrBufferThresholds(
    segmentDurationSeconds: number,
    bufferCapSeconds: number,
    isLive: boolean
): AbrBufferThresholds {
    const segment = Math.max(segmentDurationSeconds, 1);
    const requestedTarget = isLive ?
        Math.min(Math.max(3 * segment, 6), 18) :
        Math.min(Math.max(8 * segment, 24), 45);
    const target = bufferCapSeconds > 0 ? Math.min(requestedTarget, bufferCapSeconds) : requestedTarget;
    const high = isLive ?
        Math.min(Math.max(2 * segment, 4), target * 0.8) :
        Math.min(Math.max(6 * segment, 20), target * 0.85);
    const low = isLive ?
        Math.min(Math.max(1.25 * segment, 2.5), high * 0.65) :
        Math.min(Math.max(3 * segment, 10), high * 0.6);
    return { high, low };
}

/**
 * Chooses the HLS level from the download speed and the buffer. There are no
 * phases: the level goes down when it is not safe, and goes up one level at a
 * time after a dwell time that grows after each failed up-switch.
 *
 * Every switch has a cost: Jellyfin restarts the transcoder, so the first
 * fragment of the new level comes late and the buffer goes down. The policy
 * measures that cost and only switches when the buffer can pay for it.
 */
export class AbrPolicy {
    private currentLevel = -1;
    private estimator: AbrEstimator;
    private failedUpSwitches = 0;
    private lastFailedUpAt = Number.NEGATIVE_INFINITY;
    private lastReason = 'start';
    private lastSwitchAt = Number.NEGATIVE_INFINITY;
    private lastUpSwitchAt = Number.NEGATIVE_INFINITY;
    private lastSegmentDurationSeconds = 0;
    private levels: AbrLevel[];
    private tuning: AbrTuning;

    constructor(options: AbrPolicyOptions) {
        this.tuning = { ...DEFAULT_ABR_TUNING, ...options.tuning };
        this.levels = normalizeLevels(options.levels);
        const seedThroughput = isPositiveFinite(options.initialBandwidthEstimate) ?
            options.initialBandwidthEstimate :
            (options.initialBitrate || DEFAULT_INITIAL_BITRATE) / this.tuning.upFactor;
        this.estimator = new AbrEstimator(seedThroughput, this.tuning);
    }

    get hasMultipleLevels() {
        return this.levels.length > 1;
    }

    updateLevels(levels: AbrLevel[]) {
        const currentBitrate = this.getBitrate(this.currentLevel);
        this.levels = normalizeLevels(levels);
        this.currentLevel = this.currentLevel >= 0 ? this.findLevelForBitrate(currentBitrate) : -1;
    }

    /** Called when the player starts to load a fragment. A level change here is a real switch. */
    recordFragmentLoading(level: number, nowMs: number) {
        if (level === this.currentLevel) {
            return;
        }

        const previousLevel = this.currentLevel;
        this.currentLevel = level;
        if (previousLevel < 0) {
            return;
        }

        this.lastSwitchAt = nowMs;
        if (level > previousLevel) {
            this.lastUpSwitchAt = nowMs;
        } else {
            this.noteDownSwitch(nowMs);
        }
    }

    recordFragment(sample: AbrFragmentSample) {
        return this.estimator.record(sample);
    }

    /**
     * A `waiting` event. It is a network problem only when the buffer is
     * almost empty. With a full buffer a lower level does not help.
     */
    recordStall(context: AbrContext) {
        const segment = context.segmentDurationSeconds / this.getPlaybackRate(context);
        if (context.bufferSeconds >= Math.max(segment, 1) || this.currentLevel < 0) {
            this.lastReason = 'stall-ignored';
            return false;
        }

        // The first fragment after a switch comes late because of the restart.
        // A new switch would only restart the transcoder again.
        const restartWindowMs = this.estimator.switchCostMs + (segment * 1000);
        if (context.nowMs - this.lastSwitchAt < restartWindowMs) {
            this.lastReason = 'stall-after-switch';
            return false;
        }

        this.switchDown(this.currentLevel - 1, context.nowMs, 'stall');
        return true;
    }

    /** hls.js stopped a slow fragment and switched down to the given level. */
    recordEmergency(level: number, nowMs: number) {
        if (this.currentLevel >= 0 && level >= this.currentLevel) {
            return;
        }

        this.switchDown(level, nowMs, 'emergency');
    }

    chooseLevel(context: AbrContext) {
        if (!this.levels.length) {
            return -1;
        }

        this.lastSegmentDurationSeconds = context.segmentDurationSeconds;
        if (this.currentLevel < 0) {
            return this.chooseStartLevel(context);
        }

        const current = this.clampToContext(this.currentLevel, context);
        const factor = this.getSafetyFactor(context);
        let target = current;
        if (!this.isLevelSafe(current, context, factor)) {
            const downTarget = this.findHighestSafeLevel(
                context,
                Math.min(factor, this.tuning.downTargetFactor),
                current - 1
            );
            if (this.isDownSwitchWorthIt(current, downTarget, context)) {
                target = downTarget;
                this.lastReason = 'down';
            } else {
                this.lastReason = 'down-deferred';
            }
        } else {
            const next = this.findNextUpLevel(current, context);
            if (next >= 0 && this.canSwitchUp(next, context)) {
                target = next;
                this.lastReason = 'up';
            }
        }

        return this.clampToContext(target, context);
    }

    chooseStartLevel(context: AbrContext) {
        if (!this.levels.length) {
            return -1;
        }

        // The first fragment must arrive fast, so the video starts quickly.
        this.lastReason = 'start';
        const playbackRate = this.getPlaybackRate(context);
        const startFactor = Math.min(
            this.tuning.upFactor,
            this.tuning.maxStartFetchSeconds * playbackRate / Math.max(context.segmentDurationSeconds, 0.001)
        );
        return this.clampToContext(
            this.findHighestSafeLevel(context, startFactor, Number.POSITIVE_INFINITY),
            context
        );
    }

    getBufferThresholds(context: AbrContext) {
        const playbackRate = this.getPlaybackRate(context);
        return getAbrBufferThresholds(
            context.segmentDurationSeconds / playbackRate,
            context.bufferCapSeconds > 0 ? context.bufferCapSeconds / playbackRate : 0,
            context.isLive
        );
    }

    getDebugState(nowMs: number): AbrDebugState {
        const dwellMs = this.getDwellMs(nowMs);
        return {
            currentLevel: this.currentLevel,
            dwellRemainingSeconds: Math.max(this.lastSwitchAt + dwellMs - nowMs, 0) / 1000,
            dwellSeconds: dwellMs / 1000,
            failedUpSwitches: this.getActiveFailedUpSwitches(nowMs),
            lastReason: this.lastReason,
            samples: this.estimator.samples,
            switchCostMs: this.estimator.switchCostMs,
            throughput: this.estimator.throughput,
            ttfbMs: this.estimator.ttfbMs,
            vbr: this.estimator.vbr
        };
    }

    private canSwitchUp(level: number, context: AbrContext) {
        const { low } = this.getBufferThresholds(context);
        const buffer = this.getBufferSeconds(context);
        // After the restart wait and one fetch, at least one segment must be left.
        const margin = context.segmentDurationSeconds / this.getPlaybackRate(context);
        return buffer >= low
            && buffer - this.getSwitchSeconds(level, context) >= margin
            && context.nowMs - this.lastSwitchAt >= this.getDwellMs(context.nowMs)
            && this.isLevelSafe(level, context, this.tuning.upFactor);
    }

    /**
     * A down-switch restarts the transcoder too. It is worth it when the
     * buffer can pay for the restart, when the new level still gets its first
     * fragment sooner, or when the current level cannot keep up at all.
     */
    private isDownSwitchWorthIt(current: number, target: number, context: AbrContext) {
        if (target >= current) {
            return false;
        }

        const segment = context.segmentDurationSeconds / this.getPlaybackRate(context);
        const switchSeconds = this.getSwitchSeconds(target, context);
        const stayFetchSeconds = this.getFetchSeconds(current, context);
        return this.getBufferSeconds(context) - switchSeconds >= segment
            || switchSeconds < stayFetchSeconds
            || stayFetchSeconds > segment;
    }

    /** Seconds until the first fragment arrives after a switch to the level. */
    private getSwitchSeconds(level: number, context: AbrContext) {
        return (this.estimator.switchCostMs / 1000) + this.getFetchSeconds(level, context);
    }

    private getFetchSeconds(level: number, context: AbrContext) {
        return this.estimator.predictFetchSeconds(this.getBitrate(level), context.segmentDurationSeconds);
    }

    private getSafetyFactor(context: AbrContext) {
        const { high, low } = this.getBufferThresholds(context);
        const buffer = this.getBufferSeconds(context);
        if (buffer < low) {
            return this.tuning.lowBufferFactor;
        }
        if (buffer < high) {
            return this.tuning.midBufferFactor;
        }
        return this.tuning.highBufferFactor;
    }

    private isLevelSafe(level: number, context: AbrContext, factor: number) {
        const playbackRate = this.getPlaybackRate(context);
        return this.getFetchSeconds(level, context) <= (context.segmentDurationSeconds / playbackRate) * factor;
    }

    private findHighestSafeLevel(context: AbrContext, factor: number, maximumLevel: number) {
        let selected = this.levels[0].index;
        for (const level of this.levels) {
            if (level.index > maximumLevel) {
                break;
            }
            if (this.isLevelSafe(level.index, context, factor) && this.isSwitchAllowed(level.index, context)) {
                selected = level.index;
            }
        }
        return selected;
    }

    private findNextUpLevel(current: number, context: AbrContext) {
        const next = this.levels.find(level => level.index > current && level.index <= context.maxLevel);
        if (!next || !this.isSwitchAllowed(next.index, context)) {
            return -1;
        }
        return next.index;
    }

    private isSwitchAllowed(level: number, context: AbrContext) {
        if (this.currentLevel < 0 || level === this.currentLevel || !context.isSwitchAllowed) {
            return true;
        }
        return context.isSwitchAllowed(this.currentLevel, level);
    }

    private switchDown(level: number, nowMs: number, reason: string) {
        const target = this.clampToKnownLevel(level);
        this.lastReason = reason;
        if (target >= this.currentLevel) {
            return;
        }

        // The switch is real now, before the next fragment starts. The dwell
        // time then blocks an early return to the level that failed.
        this.currentLevel = target;
        this.lastSwitchAt = nowMs;
        this.noteDownSwitch(nowMs);
    }

    private noteDownSwitch(nowMs: number) {
        const windowMs = Math.max(
            this.tuning.failedUpWindowMs,
            this.lastSegmentDurationSeconds * this.tuning.failedUpWindowSegments * 1000
        );
        if (nowMs - this.lastUpSwitchAt <= windowMs) {
            this.failedUpSwitches = this.getActiveFailedUpSwitches(nowMs) + 1;
            this.lastFailedUpAt = nowMs;
            this.lastUpSwitchAt = Number.NEGATIVE_INFINITY;
        }
    }

    private getActiveFailedUpSwitches(nowMs: number) {
        const decaySteps = Math.floor((nowMs - this.lastFailedUpAt) / this.tuning.backoffDecayMs);
        return Math.max(this.failedUpSwitches - Math.max(decaySteps, 0), 0);
    }

    private getDwellMs(nowMs: number) {
        const growth = this.tuning.backoffGrowth ** this.getActiveFailedUpSwitches(nowMs);
        const backoffDwellMs = Math.min(this.tuning.baseDwellMs * growth, this.tuning.maxDwellMs);
        // A costly switch must pay for itself before the next one.
        return Math.max(backoffDwellMs, this.estimator.switchCostMs * this.tuning.switchCostDwellMultiple);
    }

    private getBufferSeconds(context: AbrContext) {
        return Math.max(context.bufferSeconds, 0) / this.getPlaybackRate(context);
    }

    private getPlaybackRate(context: AbrContext) {
        return isPositiveFinite(context.playbackRate) ? context.playbackRate : 1;
    }

    private clampToContext(level: number, context: AbrContext) {
        const minimum = Math.max(context.minLevel, this.levels[0].index);
        const maximum = Math.min(context.maxLevel, this.levels[this.levels.length - 1].index);
        return this.clampToKnownLevel(Math.min(Math.max(level, minimum), Math.max(maximum, minimum)));
    }

    private clampToKnownLevel(level: number) {
        let selected = this.levels[0].index;
        for (const candidate of this.levels) {
            if (candidate.index > level) {
                break;
            }
            selected = candidate.index;
        }
        return selected;
    }

    private findLevelForBitrate(bitrate: number) {
        let selected = this.levels[0]?.index ?? -1;
        for (const level of this.levels) {
            if (level.bitrate > bitrate) {
                break;
            }
            selected = level.index;
        }
        return selected;
    }

    private getBitrate(level: number) {
        return this.levels.find(candidate => candidate.index === level)?.bitrate || 0;
    }
}
