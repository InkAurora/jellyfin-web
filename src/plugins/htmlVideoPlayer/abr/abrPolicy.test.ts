import { describe, expect, it } from 'vitest';

import type { AbrFragmentSample } from './abrEstimator';
import {
    AbrPolicy,
    DEFAULT_ABR_TUNING,
    getAbrBufferThresholds,
    type AbrContext,
    type AbrPolicyOptions
} from './abrPolicy';

const levels = [
    420_000,
    720_000,
    1_500_000,
    3_000_000,
    6_000_000,
    10_000_000,
    20_000_000
].map((bitrate, index) => ({ bitrate, index }));

// Segment 3 s, cap 30 s, VOD: low 10 s, high 20 s.
const { high: HIGH_BUFFER, low: LOW_BUFFER } = getAbrBufferThresholds(3, 30, false);

function createPolicy(options: Partial<AbrPolicyOptions> = {}) {
    return new AbrPolicy({ levels, ...options });
}

function createContext(options: Partial<AbrContext> = {}): AbrContext {
    return {
        bufferCapSeconds: 30,
        bufferSeconds: 25,
        isLive: false,
        maxLevel: 6,
        minLevel: 0,
        nowMs: 0,
        playbackRate: 1,
        segmentDurationSeconds: 3,
        ...options
    };
}

function createFragmentSample(options: {
    bandwidth: number;
    durationSeconds?: number;
    level?: number;
    nowMs?: number;
}): AbrFragmentSample {
    const durationSeconds = options.durationSeconds || 3;
    const mediaBitrate = levels[options.level ?? 4].bitrate;
    const nowMs = options.nowMs ?? 10_000;
    const loadedBytes = mediaBitrate * durationSeconds / 8;
    const payloadDurationMs = loadedBytes * 8_000 / options.bandwidth;

    return {
        declaredBitrate: mediaBitrate,
        durationSeconds,
        loadedBytes,
        loadingEndMs: nowMs,
        loadingFirstMs: nowMs - payloadDurationMs,
        loadingStartMs: nowMs - payloadDurationMs
    };
}

/** Feeds samples whose payload rate is the wanted bandwidth, with VBR 1 and no TTFB. */
function feedBandwidth(policy: AbrPolicy, bandwidth: number, count = 1) {
    for (let index = 0; index < count; index++) {
        expect(policy.recordFragment(createFragmentSample({ bandwidth }))).toBe(true);
    }
}

/** A policy that is playing the given level and sees the given bandwidth. */
function createPlayingPolicy(level: number, bandwidth: number, options: Partial<AbrPolicyOptions> = {}) {
    const policy = createPolicy(options);
    feedBandwidth(policy, bandwidth);
    policy.recordFragmentLoading(level, 0);
    return policy;
}

/** An up-switch followed by a quick down-switch. Returns the time of the down-switch. */
function failUpSwitch(policy: AbrPolicy, upAtMs: number, gapMs = 5_000) {
    policy.recordFragmentLoading(4, upAtMs);
    policy.recordFragmentLoading(3, upAtMs + gapMs);
    return upAtMs + gapMs;
}

describe('getAbrBufferThresholds', () => {
    it('gives the expected VOD thresholds for 3 s segments', () => {
        expect(HIGH_BUFFER).toBeCloseTo(20, 6);
        expect(LOW_BUFFER).toBeCloseTo(10, 6);
    });

    it('gives lower thresholds for live streams', () => {
        const { high, low } = getAbrBufferThresholds(3, 0, true);

        expect(high).toBeCloseTo(6, 6);
        expect(low).toBeCloseTo(3.75, 6);
    });

    it('scales with long segments', () => {
        const { high, low } = getAbrBufferThresholds(10, 0, false);

        expect(high).toBeCloseTo(38.25, 6);
        expect(low).toBeCloseTo(22.95, 6);
    });

    it('is limited by the buffer cap of the player', () => {
        const { high, low } = getAbrBufferThresholds(3, 10, false);

        expect(high).toBeCloseTo(8.5, 6);
        expect(low).toBeCloseTo(5.1, 6);
    });

    it('treats segments shorter than 1 s as 1 s', () => {
        expect(getAbrBufferThresholds(0.1, 30, false)).toEqual(getAbrBufferThresholds(1, 30, false));
    });

    it('keeps low below high', () => {
        for (const isLive of [false, true]) {
            for (const segment of [1, 3, 6, 10]) {
                for (const cap of [0, 6, 30, 90]) {
                    const { high, low } = getAbrBufferThresholds(segment, cap, isLive);

                    expect(low).toBeLessThan(high);
                }
            }
        }
    });
});

describe('AbrPolicy defaults', () => {
    it('exposes the documented tuning', () => {
        expect(DEFAULT_ABR_TUNING.baseDwellMs).toBe(10_000);
        expect(DEFAULT_ABR_TUNING.maxDwellMs).toBe(80_000);
        expect(DEFAULT_ABR_TUNING.failedUpWindowMs).toBe(30_000);
        expect(DEFAULT_ABR_TUNING.failedUpWindowSegments).toBe(6);
        expect(DEFAULT_ABR_TUNING.backoffDecayMs).toBe(120_000);
        expect(DEFAULT_ABR_TUNING.upFactor).toBe(0.7);
        expect(DEFAULT_ABR_TUNING.lowBufferFactor).toBe(0.7);
        expect(DEFAULT_ABR_TUNING.highBufferFactor).toBe(1);
        expect(DEFAULT_ABR_TUNING.maxStartFetchSeconds).toBe(2);
    });

    it('starts with no level and the base dwell time', () => {
        const state = createPolicy().getDebugState(0);

        expect(state.currentLevel).toBe(-1);
        expect(state.dwellSeconds).toBe(10);
        expect(state.failedUpSwitches).toBe(0);
        expect(state.lastReason).toBe('start');
        expect(state.samples).toBe(0);
    });

    it('reports multiple levels only when there is a choice', () => {
        expect(createPolicy().hasMultipleLevels).toBe(true);
        expect(createPolicy({ levels: levels.slice(0, 1) }).hasMultipleLevels).toBe(false);
    });

    it('returns -1 when there are no levels', () => {
        const policy = createPolicy({ levels: [] });

        expect(policy.chooseLevel(createContext())).toBe(-1);
        expect(policy.chooseStartLevel(createContext())).toBe(-1);
    });

    it('uses a custom tuning', () => {
        const policy = createPolicy({ tuning: { baseDwellMs: 5_000 } });

        expect(policy.getDebugState(0).dwellSeconds).toBe(5);
    });
});

describe('AbrPolicy start level', () => {
    it('picks a level that is safe for the initial bitrate', () => {
        const policy = createPolicy({ initialBitrate: 6_000_000 });

        expect(policy.chooseStartLevel(createContext())).toBeLessThanOrEqual(4);
    });

    it('uses the same rule for the first chooseLevel call', () => {
        const policy = createPolicy({ initialBitrate: 6_000_000 });
        const context = createContext();

        expect(policy.chooseLevel(context)).toBe(policy.chooseStartLevel(context));
        expect(policy.chooseLevel(context)).toBeLessThanOrEqual(4);
    });

    it('does not commit a level by itself', () => {
        const policy = createPolicy();

        policy.chooseLevel(createContext());

        expect(policy.getDebugState(0).currentLevel).toBe(-1);
    });

    it('limits the start fetch to 2 s, so long segments start lower', () => {
        const shortSegments = createPolicy({ initialBitrate: 6_000_000 })
            .chooseStartLevel(createContext({ segmentDurationSeconds: 3 }));
        const longSegments = createPolicy({ initialBitrate: 6_000_000 })
            .chooseStartLevel(createContext({ segmentDurationSeconds: 6 }));

        expect(longSegments).toBeLessThan(shortSegments);
    });

    it('keeps the predicted start fetch under the maximum', () => {
        // Seed is 6 Mbit/s / 0.7. A 3 s segment must arrive within 2 s.
        const seed = 6_000_000 / 0.7;
        const level = createPolicy({ initialBitrate: 6_000_000 })
            .chooseStartLevel(createContext({ segmentDurationSeconds: 3 }));

        expect((3 * levels[level].bitrate) / seed).toBeLessThanOrEqual(2);
        if (level < levels.length - 1) {
            expect((3 * levels[level + 1].bitrate) / seed).toBeGreaterThan(2);
        }
    });

    it('uses the initial bandwidth estimate as the seed when given', () => {
        const withoutEstimate = createPolicy({ initialBitrate: 6_000_000 }).chooseStartLevel(createContext());
        const fastEstimate = createPolicy({ initialBandwidthEstimate: 20_000_000 }).chooseStartLevel(createContext());
        const slowEstimate = createPolicy({ initialBandwidthEstimate: 1_000_000 }).chooseStartLevel(createContext());

        expect(fastEstimate).toBeGreaterThan(withoutEstimate);
        expect(slowEstimate).toBeLessThan(withoutEstimate);
        expect(slowEstimate).toBe(0);
    });

    it('reports the seed throughput before any sample', () => {
        expect(createPolicy({ initialBandwidthEstimate: 20_000_000 }).getDebugState(0).throughput).toBe(20_000_000);
        expect(createPolicy({ initialBitrate: 3_500_000 }).getDebugState(0).throughput).toBeCloseTo(5_000_000, 3);
    });

    it('uses measured throughput instead of the seed once a sample exists', () => {
        const policy = createPolicy({ initialBandwidthEstimate: 100_000_000 });
        feedBandwidth(policy, 3_000_000);

        expect(policy.getDebugState(0).throughput).toBeCloseTo(3_000_000, -2);
        expect(policy.chooseStartLevel(createContext())).toBeLessThanOrEqual(2);
    });

    it('respects the level limits', () => {
        const capped = createPolicy({ initialBandwidthEstimate: 100_000_000 })
            .chooseStartLevel(createContext({ maxLevel: 1 }));
        const raised = createPolicy({ initialBandwidthEstimate: 100_000 })
            .chooseStartLevel(createContext({ minLevel: 4 }));

        expect(capped).toBe(1);
        expect(raised).toBe(4);
    });
});

describe('AbrPolicy down-switches', () => {
    it('goes down at once, over several levels, when the level is not safe', () => {
        const policy = createPlayingPolicy(5, 3_000_000);

        expect(policy.chooseLevel(createContext())).toBeLessThanOrEqual(3);
    });

    it('goes down to the right level for the bandwidth', () => {
        const policy = createPlayingPolicy(5, 1_000_000);

        // 720 kbit/s is the highest level that fits in 1 Mbit/s.
        expect(policy.chooseLevel(createContext())).toBe(1);
    });

    it('does not commit the level by itself', () => {
        const policy = createPlayingPolicy(5, 3_000_000);

        const chosen = policy.chooseLevel(createContext());

        expect(policy.getDebugState(0).currentLevel).toBe(5);
        expect(policy.getDebugState(0).lastReason).toBe('down');

        policy.recordFragmentLoading(chosen, 1_000);

        expect(policy.getDebugState(1_000).currentLevel).toBe(chosen);
    });

    it('goes down without waiting for the dwell time', () => {
        const policy = createPlayingPolicy(4, 100_000_000);
        policy.recordFragmentLoading(5, 1_000);
        feedBandwidth(policy, 2_000_000, 30);

        expect(policy.chooseLevel(createContext({ nowMs: 1_001 }))).toBeLessThan(5);
    });

    it('keeps a safe level', () => {
        const policy = createPlayingPolicy(3, 6_000_000);

        // 3 Mbit/s over 6 Mbit/s with the factor 0.7 for an up-switch to 6 Mbit/s: 1.0, not safe.
        expect(policy.chooseLevel(createContext())).toBe(3);
    });

    it('goes down to level 0 when nothing is safe', () => {
        const policy = createPlayingPolicy(3, 100_000);

        expect(policy.chooseLevel(createContext())).toBe(0);
    });
});

describe('AbrPolicy safety factor', () => {
    // The fetch of level 4 takes 0.9 x the segment time.
    const bandwidth = 6_000_000 / 0.9;

    it('keeps the level at a high buffer (factor 1.0)', () => {
        const policy = createPlayingPolicy(4, bandwidth);

        expect(policy.chooseLevel(createContext({ bufferSeconds: HIGH_BUFFER }))).toBe(4);
        expect(policy.chooseLevel(createContext({ bufferSeconds: HIGH_BUFFER + 5 }))).toBe(4);
    });

    it('drops the level at a low buffer (factor 0.7)', () => {
        const policy = createPlayingPolicy(4, bandwidth);

        expect(policy.chooseLevel(createContext({ bufferSeconds: LOW_BUFFER - 1 }))).toBe(3);
    });

    it('uses a middle factor (0.85) between the thresholds', () => {
        const policy = createPlayingPolicy(4, bandwidth);
        const bufferSeconds = (LOW_BUFFER + HIGH_BUFFER) / 2;

        expect(policy.chooseLevel(createContext({ bufferSeconds }))).toBe(3);
    });

    it('keeps a level with a fetch of 0.8 x the segment time at a middle buffer', () => {
        const policy = createPlayingPolicy(4, 6_000_000 / 0.8);
        const bufferSeconds = (LOW_BUFFER + HIGH_BUFFER) / 2;

        expect(policy.chooseLevel(createContext({ bufferSeconds }))).toBe(4);
        expect(policy.chooseLevel(createContext({ bufferSeconds: LOW_BUFFER - 1 }))).toBe(3);
    });
});

describe('AbrPolicy up-switches', () => {
    it('goes up only one level at a time', () => {
        const policy = createPlayingPolicy(1, 100_000_000);

        expect(policy.chooseLevel(createContext())).toBe(2);
    });

    it('does not go up when the buffer is below the low threshold', () => {
        const policy = createPlayingPolicy(3, 100_000_000);

        expect(policy.chooseLevel(createContext({ bufferSeconds: LOW_BUFFER - 0.1 }))).toBe(3);
        expect(policy.chooseLevel(createContext({ bufferSeconds: LOW_BUFFER }))).toBe(4);
    });

    it('waits for the dwell time since the last switch', () => {
        const policy = createPlayingPolicy(3, 100_000_000);
        policy.recordFragmentLoading(4, 1_000);

        expect(policy.chooseLevel(createContext({ nowMs: 1_001 }))).toBe(4);
        expect(policy.chooseLevel(createContext({ nowMs: 10_999 }))).toBe(4);
        expect(policy.chooseLevel(createContext({ nowMs: 11_000 }))).toBe(5);
    });

    it('does not count a chooseLevel call as a switch', () => {
        const policy = createPlayingPolicy(3, 100_000_000);
        policy.recordFragmentLoading(4, 1_000);

        policy.chooseLevel(createContext({ nowMs: 20_000 }));

        expect(policy.chooseLevel(createContext({ nowMs: 20_001 }))).toBe(5);
        expect(policy.getDebugState(20_001).currentLevel).toBe(4);
    });

    it('goes up only when the next level is safe at factor 0.7', () => {
        // Level 5 (10 Mbit/s) takes 0.77 x the segment time at 13 Mbit/s: safe at 1.0, not at 0.7.
        const slow = createPlayingPolicy(4, 13_000_000);
        const fast = createPlayingPolicy(4, 15_000_000);

        expect(slow.chooseLevel(createContext())).toBe(4);
        expect(fast.chooseLevel(createContext())).toBe(5);
    });

    it('stays at the top level', () => {
        const policy = createPlayingPolicy(6, 100_000_000);

        expect(policy.chooseLevel(createContext())).toBe(6);
    });
});

describe('AbrPolicy back-off', () => {
    it('counts a down-switch soon after an up-switch as a failed up-switch', () => {
        const policy = createPlayingPolicy(3, 100_000_000);

        const now = failUpSwitch(policy, 10_000);
        const state = policy.getDebugState(now);

        expect(state.failedUpSwitches).toBe(1);
        expect(state.dwellSeconds).toBe(20);
    });

    it('doubles the dwell time with each failure, up to 80 s', () => {
        const policy = createPlayingPolicy(3, 100_000_000);

        let now = failUpSwitch(policy, 10_000);
        expect(policy.getDebugState(now)).toMatchObject({ dwellSeconds: 20, failedUpSwitches: 1 });

        now = failUpSwitch(policy, 20_000);
        expect(policy.getDebugState(now)).toMatchObject({ dwellSeconds: 40, failedUpSwitches: 2 });

        now = failUpSwitch(policy, 30_000);
        expect(policy.getDebugState(now)).toMatchObject({ dwellSeconds: 80, failedUpSwitches: 3 });

        now = failUpSwitch(policy, 40_000);
        expect(policy.getDebugState(now).dwellSeconds).toBe(80);
    });

    it('does not count a down-switch after the failed-up window', () => {
        const policy = createPlayingPolicy(3, 100_000_000);

        policy.recordFragmentLoading(4, 10_000);
        policy.recordFragmentLoading(3, 40_001);

        expect(policy.getDebugState(40_001)).toMatchObject({ dwellSeconds: 10, failedUpSwitches: 0 });
    });

    it('counts a down-switch exactly at the end of the failed-up window', () => {
        const policy = createPlayingPolicy(3, 100_000_000);

        policy.recordFragmentLoading(4, 10_000);
        policy.recordFragmentLoading(3, 40_000);

        expect(policy.getDebugState(40_000).failedUpSwitches).toBe(1);
    });

    it('does not count a down-switch that does not follow an up-switch', () => {
        const policy = createPlayingPolicy(5, 100_000_000);

        policy.recordFragmentLoading(4, 10_000);
        policy.recordFragmentLoading(3, 12_000);

        expect(policy.getDebugState(12_000).failedUpSwitches).toBe(0);
    });

    it('counts one failure for several down-switches after one up-switch', () => {
        const policy = createPlayingPolicy(3, 100_000_000);

        policy.recordFragmentLoading(4, 10_000);
        policy.recordFragmentLoading(3, 12_000);
        policy.recordFragmentLoading(2, 14_000);

        expect(policy.getDebugState(14_000).failedUpSwitches).toBe(1);
    });

    it('blocks the next up-switch for the longer dwell time', () => {
        const policy = createPlayingPolicy(3, 100_000_000);
        const now = failUpSwitch(policy, 10_000);

        expect(policy.chooseLevel(createContext({ nowMs: now + 19_999 }))).toBe(3);
        expect(policy.chooseLevel(createContext({ nowMs: now + 20_000 }))).toBe(4);
    });

    it('lowers the back-off one step per 120 s without a failure', () => {
        const policy = createPlayingPolicy(3, 100_000_000);

        failUpSwitch(policy, 10_000);
        failUpSwitch(policy, 20_000);
        const failedAt = failUpSwitch(policy, 30_000);

        expect(policy.getDebugState(failedAt)).toMatchObject({ dwellSeconds: 80, failedUpSwitches: 3 });
        expect(policy.getDebugState(failedAt + 119_999).failedUpSwitches).toBe(3);
        expect(policy.getDebugState(failedAt + 120_000)).toMatchObject({ dwellSeconds: 40, failedUpSwitches: 2 });
        expect(policy.getDebugState(failedAt + 240_000)).toMatchObject({ dwellSeconds: 20, failedUpSwitches: 1 });
        expect(policy.getDebugState(failedAt + 360_000)).toMatchObject({ dwellSeconds: 10, failedUpSwitches: 0 });
        expect(policy.getDebugState(failedAt + 480_000)).toMatchObject({ dwellSeconds: 10, failedUpSwitches: 0 });
    });

    it('adds a new failure on top of the decayed count', () => {
        const policy = createPlayingPolicy(3, 100_000_000);

        failUpSwitch(policy, 10_000);
        const failedAt = failUpSwitch(policy, 20_000);
        const later = failedAt + 120_000;

        policy.recordFragmentLoading(4, later);
        policy.recordFragmentLoading(3, later + 1_000);

        expect(policy.getDebugState(later + 1_000).failedUpSwitches).toBe(2);
    });
});

describe('AbrPolicy failed-up window and segment duration', () => {
    it('does not count a down-switch 31 s after an up-switch with 3 s segments', () => {
        const policy = createPlayingPolicy(3, 100_000_000);
        policy.chooseLevel(createContext({ segmentDurationSeconds: 3 }));

        policy.recordFragmentLoading(4, 10_000);
        policy.recordFragmentLoading(3, 41_000);

        expect(policy.getDebugState(41_000).failedUpSwitches).toBe(0);
    });

    it('counts a down-switch 31 s after an up-switch with 6 s segments', () => {
        const policy = createPlayingPolicy(3, 100_000_000);
        policy.chooseLevel(createContext({ segmentDurationSeconds: 6 }));

        policy.recordFragmentLoading(4, 10_000);
        policy.recordFragmentLoading(3, 41_000);

        expect(policy.getDebugState(41_000)).toMatchObject({ dwellSeconds: 20, failedUpSwitches: 1 });
    });

    it('limits the window to 6 segments', () => {
        const policy = createPlayingPolicy(3, 100_000_000);
        policy.chooseLevel(createContext({ segmentDurationSeconds: 6 }));

        policy.recordFragmentLoading(4, 10_000);
        policy.recordFragmentLoading(3, 46_001);

        expect(policy.getDebugState(46_001).failedUpSwitches).toBe(0);
    });
});

describe('AbrPolicy stalls', () => {
    it('ignores a stall when the buffer holds at least one segment', () => {
        const policy = createPlayingPolicy(4, 100_000_000);

        expect(policy.recordStall(createContext({ bufferSeconds: 3, nowMs: 5_000 }))).toBe(false);

        const state = policy.getDebugState(5_000);
        expect(state.currentLevel).toBe(4);
        expect(state.lastReason).toBe('stall-ignored');
        expect(state.dwellRemainingSeconds).toBe(0);
    });

    it('ignores a stall before a level was chosen', () => {
        const policy = createPolicy();

        expect(policy.recordStall(createContext({ bufferSeconds: 0 }))).toBe(false);
        expect(policy.getDebugState(0).currentLevel).toBe(-1);
    });

    it('goes down one level and starts the dwell when the buffer is under one segment', () => {
        const policy = createPlayingPolicy(4, 100_000_000);

        expect(policy.recordStall(createContext({ bufferSeconds: 2, nowMs: 5_000 }))).toBe(true);

        const state = policy.getDebugState(5_000);
        expect(state.currentLevel).toBe(3);
        expect(state.lastReason).toBe('stall');
        expect(state.dwellRemainingSeconds).toBe(10);
    });

    it('blocks an up-switch during the dwell time after a stall', () => {
        const policy = createPlayingPolicy(4, 100_000_000);
        policy.recordStall(createContext({ bufferSeconds: 2, nowMs: 5_000 }));

        expect(policy.chooseLevel(createContext({ nowMs: 14_999 }))).toBe(3);
        expect(policy.chooseLevel(createContext({ nowMs: 15_000 }))).toBe(4);
    });

    it('counts a stall soon after an up-switch as a failed up-switch', () => {
        const policy = createPlayingPolicy(3, 100_000_000);
        policy.recordFragmentLoading(4, 1_000);

        policy.recordStall(createContext({ bufferSeconds: 0, nowMs: 4_000 }));

        expect(policy.getDebugState(4_000)).toMatchObject({ currentLevel: 3, failedUpSwitches: 1 });
    });

    it('scales the one segment limit with the playback rate', () => {
        const policy = createPlayingPolicy(4, 100_000_000);

        // 3 s segments at 2x last 1.5 s.
        expect(policy.recordStall(createContext({ bufferSeconds: 1.5, playbackRate: 2 }))).toBe(false);
        expect(policy.recordStall(createContext({ bufferSeconds: 1.4, playbackRate: 2 }))).toBe(true);
    });

    it('does nothing harmful at level 0', () => {
        const policy = createPlayingPolicy(0, 100_000_000);

        expect(policy.recordStall(createContext({ bufferSeconds: 0, nowMs: 5_000 }))).toBe(true);

        const state = policy.getDebugState(5_000);
        expect(state.currentLevel).toBe(0);
        expect(state.dwellRemainingSeconds).toBe(0);
        expect(state.failedUpSwitches).toBe(0);
    });
});

describe('AbrPolicy emergencies', () => {
    it('lowers the current level to the given level', () => {
        const policy = createPlayingPolicy(5, 100_000_000);

        policy.recordEmergency(2, 1_000);

        const state = policy.getDebugState(1_000);
        expect(state.currentLevel).toBe(2);
        expect(state.lastReason).toBe('emergency');
    });

    it('blocks up-switches for the dwell time', () => {
        const policy = createPlayingPolicy(5, 100_000_000);
        policy.recordEmergency(2, 1_000);

        expect(policy.getDebugState(1_000).dwellRemainingSeconds).toBe(10);
        expect(policy.chooseLevel(createContext({ nowMs: 10_999 }))).toBe(2);
        expect(policy.chooseLevel(createContext({ nowMs: 11_000 }))).toBe(3);
    });

    it('ignores a level equal to or above the current level', () => {
        const policy = createPlayingPolicy(3, 100_000_000);

        policy.recordEmergency(3, 1_000);
        policy.recordEmergency(5, 2_000);

        const state = policy.getDebugState(2_000);
        expect(state.currentLevel).toBe(3);
        expect(state.lastReason).toBe('start');
        expect(state.dwellRemainingSeconds).toBe(0);
    });

    it('counts an emergency soon after an up-switch as a failed up-switch', () => {
        const policy = createPlayingPolicy(3, 100_000_000);
        policy.recordFragmentLoading(4, 1_000);

        policy.recordEmergency(2, 3_000);

        expect(policy.getDebugState(3_000)).toMatchObject({ currentLevel: 2, failedUpSwitches: 1 });
    });

    it('moves to the nearest known level when the level does not exist', () => {
        const policy = createPlayingPolicy(5, 100_000_000);

        policy.recordEmergency(-1, 1_000);

        expect(policy.getDebugState(1_000).currentLevel).toBe(0);
    });
});

describe('AbrPolicy level limits', () => {
    it('clamps the result to the max level (for example an FPS cap)', () => {
        const policy = createPlayingPolicy(5, 100_000_000);

        expect(policy.chooseLevel(createContext({ maxLevel: 3 }))).toBe(3);
    });

    it('does not go up past the max level', () => {
        const policy = createPlayingPolicy(3, 100_000_000);

        expect(policy.chooseLevel(createContext({ maxLevel: 3 }))).toBe(3);
        expect(policy.chooseLevel(createContext({ maxLevel: 4 }))).toBe(4);
    });

    it('clamps the result to the min level', () => {
        const policy = createPlayingPolicy(4, 100_000);

        expect(policy.chooseLevel(createContext({ minLevel: 2 }))).toBe(2);
    });

    it('does not choose a disallowed level for an up-switch', () => {
        const policy = createPlayingPolicy(3, 100_000_000);
        const calls: Array<[number, number]> = [];
        const isSwitchAllowed = (from: number, to: number) => {
            calls.push([from, to]);
            return to !== 4;
        };

        expect(policy.chooseLevel(createContext({ isSwitchAllowed }))).toBe(3);
        expect(calls).toContainEqual([3, 4]);
        expect(policy.chooseLevel(createContext())).toBe(4);
    });

    it('skips disallowed levels for a down-switch', () => {
        const policy = createPlayingPolicy(5, 5_000_000);
        const isSwitchAllowed = (_from: number, to: number) => to !== 3;

        expect(policy.chooseLevel(createContext())).toBe(3);
        expect(policy.chooseLevel(createContext({ isSwitchAllowed }))).toBe(2);
    });
});

describe('AbrPolicy playback rate', () => {
    it('halves the time budget at 2x', () => {
        // Level 4 takes 0.75 x the segment time at 8 Mbit/s.
        const policy = createPlayingPolicy(4, 8_000_000);
        const context = { bufferSeconds: 100 };

        expect(policy.chooseLevel(createContext({ ...context, playbackRate: 1 }))).toBe(4);
        expect(policy.chooseLevel(createContext({ ...context, playbackRate: 2 }))).toBe(3);
    });

    it('treats an invalid playback rate as 1x', () => {
        const policy = createPlayingPolicy(4, 8_000_000);

        expect(policy.chooseLevel(createContext({ playbackRate: 0 }))).toBe(4);
        expect(policy.chooseLevel(createContext({ playbackRate: Number.NaN }))).toBe(4);
    });

    it('uses the media buffer in wall clock time for the thresholds', () => {
        const policy = createPolicy();
        const normal = policy.getBufferThresholds(createContext({ playbackRate: 1 }));
        const fast = policy.getBufferThresholds(createContext({ playbackRate: 2 }));

        expect(normal).toEqual(getAbrBufferThresholds(3, 30, false));
        expect(fast).toEqual(getAbrBufferThresholds(1.5, 15, false));
    });

    it('starts lower at 2x', () => {
        const normal = createPolicy({ initialBandwidthEstimate: 20_000_000 }).chooseStartLevel(createContext());
        const fast = createPolicy({ initialBandwidthEstimate: 20_000_000 })
            .chooseStartLevel(createContext({ playbackRate: 2 }));

        expect(fast).toBeLessThanOrEqual(normal);
    });
});

describe('AbrPolicy updateLevels', () => {
    it('keeps the current level by bitrate when the list changes', () => {
        const policy = createPlayingPolicy(4, 100_000_000);

        policy.updateLevels([
            { bitrate: 1_000_000, index: 0 },
            { bitrate: 3_000_000, index: 1 },
            { bitrate: 6_000_000, index: 2 },
            { bitrate: 12_000_000, index: 3 }
        ]);

        expect(policy.getDebugState(0).currentLevel).toBe(2);
    });

    it('moves to the highest level that does not exceed the old bitrate', () => {
        const policy = createPlayingPolicy(4, 100_000_000);

        policy.updateLevels([
            { bitrate: 1_000_000, index: 0 },
            { bitrate: 5_000_000, index: 1 },
            { bitrate: 8_000_000, index: 2 }
        ]);

        expect(policy.getDebugState(0).currentLevel).toBe(1);
    });

    it('does not pick a level before one was chosen', () => {
        const policy = createPolicy();

        policy.updateLevels(levels.slice(0, 3));

        expect(policy.getDebugState(0).currentLevel).toBe(-1);
        expect(policy.chooseLevel(createContext({ maxLevel: 2 }))).toBeLessThanOrEqual(2);
    });

    it('chooses from the new list', () => {
        const policy = createPlayingPolicy(1, 100_000_000);

        policy.updateLevels(levels.slice(0, 2));

        expect(policy.chooseLevel(createContext({ maxLevel: 10 }))).toBe(1);
    });
});
