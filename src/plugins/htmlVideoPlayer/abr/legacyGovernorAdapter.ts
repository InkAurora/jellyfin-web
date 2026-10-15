/**
 * Runs the old HlsAbrGovernor in the ABR simulator, for comparison only.
 * It copies the wiring in plugin.js: the governor sets a level cap and
 * one-shot forced levels, and an hls.js-like rule picks the level below the cap.
 */
import { HlsAbrGovernor, type HlsAbrDecision } from '../hlsAbrGovernor';
import { getHlsAdaptiveBufferOptions } from '../hlsAbrOptions';
import type { SimAlgorithm, SimContext, SimFragment, SimMediaEvent } from './abrSimulator';

const TICK_MS = 2_000;
const SEEK_GRACE_MS = 10_000;
const DEFAULT_ESTIMATE = 6_000_000;
const FAST_HALF_LIFE_SECONDS = 3;
const SLOW_HALF_LIFE_SECONDS = 9;
const UP_FACTOR = 0.7;
const DOWN_FACTOR = 0.95;
const MAX_STARVATION_DELAY_SECONDS = 4;

/** A small copy of the hls.js EWMA bandwidth estimate and findBestLevel rule. */
class HlsJsLikeChooser {
    private fast = 0;
    private slow = 0;
    private ttfbMs = 100;

    constructor(private defaultEstimate: number) {}

    get estimate() {
        return this.fast && this.slow ? Math.min(this.fast, this.slow) : this.defaultEstimate;
    }

    sample(fragment: SimFragment) {
        const ttfb = fragment.loadingFirstMs - fragment.loadingStartMs;
        const durationMs = Math.max(fragment.loadingEndMs - fragment.loadingStartMs - Math.min(ttfb, this.ttfbMs), 1);
        const rate = fragment.loadedBytes * 8000 / durationMs;
        const weight = durationMs / 1000;
        this.fast = this.update(this.fast, rate, weight, FAST_HALF_LIFE_SECONDS);
        this.slow = this.update(this.slow, rate, weight, SLOW_HALF_LIFE_SECONDS);
        this.ttfbMs = (0.8 * this.ttfbMs) + (0.2 * ttfb);
    }

    reset(estimate: number) {
        this.fast = 0;
        this.slow = 0;
        this.defaultEstimate = estimate;
    }

    choose(context: SimContext, cap: number) {
        const starvation = context.bufferSeconds / context.playbackRate;
        for (let level = cap; level > 0; level--) {
            const factor = level > context.currentLevel ? UP_FACTOR : DOWN_FACTOR;
            const bandwidth = this.estimate * factor;
            const bitrate = context.levels[level];
            const fetchSeconds = (this.ttfbMs / 1000) + (context.segmentDurationSeconds * bitrate / bandwidth);
            if (bitrate <= bandwidth && fetchSeconds <= MAX_STARVATION_DELAY_SECONDS + starvation) {
                return level;
            }
        }
        return 0;
    }

    private update(current: number, sample: number, weight: number, halfLife: number) {
        if (!current) {
            return sample;
        }
        const alpha = 1 - Math.exp(-Math.LN2 * weight / halfLife);
        return (alpha * sample) + ((1 - alpha) * current);
    }
}

export function createLegacyGovernorAlgorithm(options: {
    highBitrateBrowser?: boolean;
    initialBandwidthEstimate?: number;
    levels: number[];
}): SimAlgorithm {
    const governor = new HlsAbrGovernor({
        levels: options.levels.map((bitrate, index) => ({ bitrate, index })),
        nowMs: 0,
        ...(options.initialBandwidthEstimate ?
            { initialBandwidthEstimate: options.initialBandwidthEstimate } :
            { initialBitrate: DEFAULT_ESTIMATE })
    });
    const chooser = new HlsJsLikeChooser(options.initialBandwidthEstimate || DEFAULT_ESTIMATE);
    const manifestMaximum = Math.max(...options.levels);
    let cap = governor.initialCapLevel;
    let forcedLevel = -1;
    let pendingProbeLevel: number | undefined;
    let activeLevel: number | undefined;
    let seeking = false;
    let seekGraceUntil: number | undefined;
    let started = false;
    let nextTickMs = TICK_MS;

    function observe(context: SimContext, flags: {
        currentLevel?: number;
        isEmergency?: boolean;
        isWaiting?: boolean;
        nativeEmergencyLevel?: number;
    } = {}) {
        const level = [flags.currentLevel, context.currentLevel, 0]
            .find(candidate => Number.isInteger(candidate) && (candidate as number) >= 0) as number;
        applyDecision(governor.observe({
            bufferSeconds: context.bufferSeconds,
            configuredBufferCapSeconds: context.bufferCapSeconds,
            currentLevel: level,
            hlsBandwidthEstimate: chooser.estimate,
            isEmergency: Boolean(flags.isEmergency),
            isLive: context.isLive,
            isPaused: context.isPaused,
            isSeeking: context.isSeeking
                || seeking
                || (seekGraceUntil != null && context.nowMs < seekGraceUntil),
            isWaiting: Boolean(flags.isWaiting),
            nativeEmergencyLevel: flags.nativeEmergencyLevel,
            nowMs: context.nowMs,
            playbackRate: context.playbackRate,
            segmentDurationSeconds: context.segmentDurationSeconds
        }), context);
    }

    function cancelPendingProbe(maximumLevel: number) {
        if (pendingProbeLevel == null) {
            return;
        }
        const state = governor.getState();
        const fallback = [activeLevel, state.lastLoadedLevel, 0]
            .find(level => Number.isInteger(level) && (level as number) >= 0 && (level as number) <= maximumLevel);
        forcedLevel = fallback ?? Math.max(maximumLevel, 0);
        pendingProbeLevel = undefined;
    }

    function applyDecision(decision: HlsAbrDecision | null, context: SimContext) {
        if (!decision) {
            return;
        }

        const state = governor.getState();
        const stillExpected = state.probationProbePending && state.probationLevel === pendingProbeLevel;
        if (pendingProbeLevel != null && decision.probeLevel !== pendingProbeLevel && !stillExpected) {
            cancelPendingProbe(decision.capLevel);
        }

        cap = Math.min(Math.max(decision.capLevel, 0), context.levels.length - 1);
        if (decision.forceLevel != null) {
            forcedLevel = Math.min(Math.max(decision.forceLevel, 0), cap);
        }
        if (decision.probeLevel != null) {
            const probeLevel = Math.min(Math.max(decision.probeLevel, 0), cap);
            const active = activeLevel ?? governor.getState().lastLoadedLevel;
            if (active >= probeLevel && governor.confirmProbe(active, context.nowMs)) {
                return;
            }
            if (probeLevel > Math.max(active, context.currentLevel, 0)) {
                forcedLevel = probeLevel;
                pendingProbeLevel = probeLevel;
                return;
            }
            const rejected = governor.rejectProbe(probeLevel, context.nowMs);
            if (rejected) {
                cap = Math.min(Math.max(rejected.capLevel, 0), context.levels.length - 1);
            }
        }
    }

    function resetForSeek(context: SimContext) {
        const decision = governor.resetForSeek(context.nowMs);
        cancelPendingProbe(decision?.capLevel ?? governor.getState().capLevel);
        applyDecision(decision, context);
    }

    return {
        name: 'legacy',
        getBufferCapSeconds() {
            return getHlsAdaptiveBufferOptions({
                isHighBitrateBrowser: Boolean(options.highBitrateBrowser),
                maximumBitrate: manifestMaximum,
                savedBufferLength: 0
            }).maxBufferLength;
        },
        chooseLevel(context) {
            if (forcedLevel >= 0) {
                return Math.min(forcedLevel, cap);
            }
            return chooser.choose(context, cap);
        },
        onFragmentLoading(level, context) {
            activeLevel = level;
            if (level === forcedLevel) {
                forcedLevel = -1;
            }
            if (level === pendingProbeLevel && governor.confirmProbe(level, context.nowMs)) {
                pendingProbeLevel = undefined;
            }
        },
        onFragmentLoaded(fragment) {
            activeLevel = undefined;
            chooser.sample(fragment);
        },
        onFragmentBuffered(fragment, context) {
            governor.recordFragment({
                durationSeconds: fragment.durationSeconds,
                isMain: true,
                level: fragment.level,
                loadedBytes: fragment.loadedBytes,
                loadingEndMs: fragment.loadingEndMs,
                loadingFirstMs: fragment.loadingFirstMs,
                loadingStartMs: fragment.loadingStartMs,
                nowMs: context.nowMs
            });
            observe(context, { currentLevel: fragment.level });
        },
        onEmergency(newLevel, failedLevel, context) {
            forcedLevel = newLevel;
            chooser.reset(context.levels[newLevel]);
            observe(context, { currentLevel: failedLevel, isEmergency: true, nativeEmergencyLevel: newLevel });
        },
        onMediaEvent(event: SimMediaEvent, context) {
            switch (event) {
                case 'seeking':
                    seeking = true;
                    seekGraceUntil = undefined;
                    resetForSeek(context);
                    break;
                case 'seeked':
                    seeking = false;
                    seekGraceUntil = context.nowMs + SEEK_GRACE_MS;
                    resetForSeek(context);
                    break;
                case 'playing':
                    started = true;
                    if (seeking || seekGraceUntil != null) {
                        seeking = false;
                        seekGraceUntil = undefined;
                        resetForSeek(context);
                    }
                    observe(context);
                    break;
                case 'waiting':
                    if (started) {
                        observe(context, { isWaiting: true });
                    }
                    break;
                default:
                    observe(context);
            }
        },
        onTick(context) {
            if (context.nowMs >= nextTickMs) {
                nextTickMs = context.nowMs + TICK_MS;
                observe(context);
            }
        }
    };
}
