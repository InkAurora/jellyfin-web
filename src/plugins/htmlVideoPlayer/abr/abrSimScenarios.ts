/**
 * Simulator scenarios shared by the ABR scenario tests. Test helper only.
 */
import { getHlsAdaptiveBufferOptions } from '../hlsAbrOptions';
import { AbrPolicy, type AbrContext, type AbrTuning } from './abrPolicy';
import type { SimAlgorithm, SimContext, SimScenario } from './abrSimulator';

export const LADDER = [420_000, 720_000, 1_500_000, 3_000_000, 6_000_000, 10_000_000, 20_000_000];
export const HIGH_LADDER = [1_500_000, 3_000_000, 6_000_000, 10_000_000, 20_000_000, 40_000_000];
export const MBPS = 1_000_000;

export interface ScenarioCase {
    highBitrateBrowser?: boolean;
    scenario: SimScenario;
}

export function createPolicyAlgorithm(options: {
    highBitrateBrowser?: boolean;
    initialBandwidthEstimate?: number;
    levels: number[];
    tuning?: Partial<AbrTuning>;
}): SimAlgorithm & { policy: AbrPolicy } {
    const policy = new AbrPolicy({
        initialBandwidthEstimate: options.initialBandwidthEstimate,
        levels: options.levels.map((bitrate, index) => ({ bitrate, index })),
        tuning: options.tuning
    });
    let started = false;
    let seeking = false;

    function toContext(context: SimContext): AbrContext {
        return {
            bufferCapSeconds: context.bufferCapSeconds,
            bufferSeconds: context.bufferSeconds,
            isLive: context.isLive,
            maxLevel: context.levels.length - 1,
            minLevel: 0,
            nowMs: context.nowMs,
            playbackRate: context.playbackRate,
            segmentDurationSeconds: context.segmentDurationSeconds
        };
    }

    return {
        name: 'new',
        policy,
        getBufferCapSeconds(levelBitrate) {
            return getHlsAdaptiveBufferOptions({
                isHighBitrateBrowser: Boolean(options.highBitrateBrowser),
                maximumBitrate: levelBitrate,
                savedBufferLength: 0
            }).maxBufferLength;
        },
        chooseLevel(context) {
            return policy.chooseLevel(toContext(context));
        },
        onFragmentLoading(level, context) {
            policy.recordFragmentLoading(level, context.nowMs);
        },
        onFragmentLoaded(fragment) {
            policy.recordFragment(fragment);
        },
        onEmergency(newLevel, _failedLevel, context) {
            policy.recordEmergency(newLevel, context.nowMs);
        },
        onMediaEvent(event, context) {
            if (event === 'seeking') {
                seeking = true;
            } else if (event === 'playing') {
                started = true;
                seeking = false;
            } else if (event === 'waiting' && started && !seeking && !context.isPaused) {
                policy.recordStall(toContext(context));
            }
        }
    };
}

/** A small seeded random number generator, so the traces are the same each run. */
export function mulberry32(seed: number) {
    let state = seed;
    return () => {
        state = (state + 0x6D2B79F5) | 0;
        let value = Math.imul(state ^ (state >>> 15), 1 | state);
        value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

export function randomWalkTrace(seed: number, minimum: number, maximum: number) {
    const random = mulberry32(seed);
    const values: number[] = [];
    let value = (minimum + maximum) / 2;
    for (let second = 0; second < 1_000; second++) {
        value *= Math.exp((random() - 0.5) * 0.5);
        if (random() < 0.03) {
            value *= 0.3;
        }
        value = Math.min(Math.max(value, minimum), maximum);
        values.push(value);
    }
    return (seconds: number) => values[Math.floor(seconds) % values.length];
}

export function every(startSeconds: number, intervalSeconds: number, endSeconds: number) {
    const times: number[] = [];
    for (let time = startSeconds; time < endSeconds; time += intervalSeconds) {
        times.push(time);
    }
    return times;
}

export function createCases(segmentDurationSeconds: number): Record<string, ScenarioCase> {
    const base = { levels: LADDER, segmentDurationSeconds, durationSeconds: 300 };
    return {
        '1 stable fast': { scenario: { ...base, name: 'stable fast', bandwidth: () => 60 * MBPS } },
        '2 stable slow': { scenario: { ...base, name: 'stable slow', bandwidth: () => 2.5 * MBPS } },
        '3 drop 30->3': {
            scenario: { ...base, name: 'drop', bandwidth: seconds => (seconds < 120 ? 30 : 3) * MBPS }
        },
        '4 rise 3->30': {
            scenario: { ...base, name: 'rise', bandwidth: seconds => (seconds < 60 ? 3 : 30) * MBPS }
        },
        '5 square wave': {
            scenario: {
                ...base,
                name: 'square',
                bandwidth: seconds => (Math.floor(seconds / 30) % 2 === 0 ? 25 : 4) * MBPS
            }
        },
        '6 random walk': {
            scenario: { ...base, name: 'random', bandwidth: randomWalkTrace(7, 1.5 * MBPS, 40 * MBPS) }
        },
        '7 slow transcode': {
            scenario: {
                ...base,
                name: 'slow transcode',
                bandwidth: () => 60 * MBPS,
                switchPenaltyMs: 1_500,
                transcodeSpeed: level => (LADDER[level] >= 10 * MBPS ? 0.9 : 3)
            }
        },
        '8 decoder stalls': {
            scenario: {
                ...base,
                name: 'decoder stalls',
                bandwidth: () => 60 * MBPS,
                decoderStalls: every(30, 20, 300)
            }
        },
        '9 failing top level': {
            scenario: {
                ...base,
                name: 'failing top',
                bandwidth: () => 60 * MBPS,
                switchPenaltyMs: 1_500,
                transcodeSpeed: level => (level === LADDER.length - 1 ? 0.85 : 4)
            }
        },
        '10 vbr spikes': {
            scenario: {
                ...base,
                name: 'vbr',
                bandwidth: () => 25 * MBPS,
                vbr: segment => (segment % 15 === 7 ? 2.5 : 1)
            }
        },
        '11 small cap, low level': {
            highBitrateBrowser: true,
            scenario: { ...base, levels: HIGH_LADDER, name: 'small cap', bandwidth: () => 5 * MBPS }
        },
        '12 seeks and pauses': {
            scenario: {
                ...base,
                name: 'seeks',
                bandwidth: () => 15 * MBPS,
                pauses: every(40, 40, 300).map(atSeconds => ({ atSeconds, durationSeconds: 5 })),
                seeks: every(20, 40, 300).map((atSeconds, index) => ({ atSeconds, toSeconds: 600 + (index * 120) }))
            }
        },
        '13 rate 2x': {
            scenario: { ...base, name: 'rate 2x', bandwidth: () => 20 * MBPS, playbackRate: 2 }
        },
        '14 live': {
            scenario: { ...base, name: 'live', bandwidth: () => 12 * MBPS, isLive: true }
        },
        '15 late buffer report': {
            scenario: {
                ...base,
                name: 'late buffer',
                bandwidth: seconds => (Math.floor(seconds / 30) % 2 === 0 ? 25 : 6) * MBPS,
                bufferReportDelayMs: 2_000
            }
        }
    };
}

function squareWave(periodSeconds: number, offsetSeconds: number, highMbps: number, lowMbps: number) {
    return (seconds: number) => (
        Math.floor((seconds + offsetSeconds) / (periodSeconds / 2)) % 2 === 0 ? highMbps : lowMbps
    ) * MBPS;
}

/**
 * Noisy networks give different results for each phase or seed. These groups
 * run many variants, so a comparison of averages is fair.
 */
export function createRobustGroups(segmentDurationSeconds: number): Record<string, SimScenario[]> {
    const base = { levels: LADDER, segmentDurationSeconds, durationSeconds: 600 };
    const phases: Array<[number, number]> = [];
    for (const period of [60, 120]) {
        for (const offset of [0, 13, 29]) {
            phases.push([period, offset]);
        }
    }
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
    return {
        'square wave': phases.map(([period, offset]) => ({
            ...base,
            name: `square ${period}+${offset}`,
            bandwidth: squareWave(period, offset, 25, 4)
        })),
        'late buffer report': phases.map(([period, offset]) => ({
            ...base,
            name: `late ${period}+${offset}`,
            bandwidth: squareWave(period, offset, 25, 6),
            bufferReportDelayMs: 2_000
        })),
        'random walk': seeds.map(seed => ({
            ...base,
            name: `random ${seed}`,
            bandwidth: randomWalkTrace(seed, 1.5 * MBPS, 40 * MBPS)
        }))
    };
}
