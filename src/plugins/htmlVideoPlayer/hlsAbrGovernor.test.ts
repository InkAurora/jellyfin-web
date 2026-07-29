import { describe, expect, it } from 'vitest';

import {
    HlsAbrGovernor,
    type HlsAbrFragmentSample,
    type HlsAbrSnapshot
} from './hlsAbrGovernor';

const levels = [
    420_000,
    720_000,
    1_500_000,
    3_000_000,
    6_000_000,
    10_000_000,
    20_000_000
].map((bitrate, index) => ({ bitrate, index }));

function createGovernor(options: { initialBandwidthEstimate?: number; nowMs?: number } = {}) {
    return new HlsAbrGovernor({
        initialBandwidthEstimate: options.initialBandwidthEstimate,
        levels,
        nowMs: options.nowMs || 0
    });
}

function createFragmentSample(options: {
    bandwidth?: number;
    durationSeconds?: number;
    level?: number;
    nowMs: number;
    ttfbMs?: number;
}): HlsAbrFragmentSample {
    const bandwidth = options.bandwidth || 30_000_000;
    const payloadDurationMs = 1_000;
    const ttfbMs = options.ttfbMs ?? 100;
    const loadedBytes = bandwidth * payloadDurationMs / 8_000;

    return {
        durationSeconds: options.durationSeconds || 3,
        isMain: true,
        level: options.level ?? 4,
        loadedBytes,
        loadingEndMs: options.nowMs,
        loadingFirstMs: options.nowMs - payloadDurationMs,
        loadingStartMs: options.nowMs - payloadDurationMs - ttfbMs,
        nowMs: options.nowMs
    };
}

function createSnapshot(options: Partial<HlsAbrSnapshot> & { nowMs: number }): HlsAbrSnapshot {
    return {
        bufferSeconds: 15,
        currentLevel: 4,
        hlsBandwidthEstimate: 30_000_000,
        playbackRate: 1,
        segmentDurationSeconds: 3,
        ...options
    };
}

describe('HlsAbrGovernor startup', () => {
    it('caps unknown connections at the configured startup bitrate', () => {
        const governor = createGovernor();

        expect(governor.initialCapLevel).toBe(4);
    });

    it('uses a conservative fraction of a trusted estimate', () => {
        const governor = createGovernor({ initialBandwidthEstimate: 16_000_000 });

        expect(governor.initialCapLevel).toBe(5);
    });

    it('clamps estimates below and above the ladder', () => {
        const slowGovernor = createGovernor({ initialBandwidthEstimate: 100_000 });
        const fastGovernor = createGovernor({ initialBandwidthEstimate: 1_000_000_000 });

        expect(slowGovernor.initialCapLevel).toBe(0);
        expect(fastGovernor.initialCapLevel).toBe(6);
    });

    it('does not expose an unsafe level hidden before a lower-bitrate variant', () => {
        const governor = new HlsAbrGovernor({
            initialBandwidthEstimate: 6_000_000,
            levels: [420_000, 6_000_000, 1_500_000, 10_000_000]
                .map((bitrate, index) => ({ bitrate, index })),
            nowMs: 0
        });

        expect(governor.initialCapLevel).toBe(0);
    });
});

describe('HlsAbrGovernor upshifts', () => {
    it('never upgrades from a small flat buffer', () => {
        const governor = createGovernor();
        governor.recordFragment(createFragmentSample({ nowMs: 1_000 }));
        governor.recordFragment(createFragmentSample({ nowMs: 2_000 }));

        expect(governor.observe(createSnapshot({ bufferSeconds: 2, nowMs: 12_000 }))).toBeNull();
        expect(governor.observe(createSnapshot({ bufferSeconds: 2, nowMs: 13_000 }))).toBeNull();
        expect(governor.getState().capLevel).toBe(4);
    });

    it('upgrades after repeated safe bandwidth and buffer votes', () => {
        const governor = createGovernor();
        governor.recordFragment(createFragmentSample({ nowMs: 1_000 }));
        governor.recordFragment(createFragmentSample({ nowMs: 2_000 }));

        expect(governor.observe(createSnapshot({ bufferSeconds: 14, nowMs: 12_000 }))).toBeNull();
        governor.recordFragment(createFragmentSample({ nowMs: 13_000 }));
        const decision = governor.observe(createSnapshot({ bufferSeconds: 15, nowMs: 13_000 }));

        expect(decision).toMatchObject({
            capLevel: 5,
            phase: 'probation',
            probeLevel: 5,
            reason: 'bandwidth-buffer-up'
        });
    });

    it('continues ramping when a capped on-demand buffer has a negative sawtooth slope', () => {
        const governor = createGovernor();
        for (let nowMs = 1_000; nowMs <= 4_000; nowMs += 1_000) {
            governor.recordFragment(createFragmentSample({ level: 4, nowMs }));
            governor.observe(createSnapshot({
                bufferSeconds: 24,
                currentLevel: 4,
                nowMs,
                segmentDurationSeconds: 4
            }));
        }

        governor.observe(createSnapshot({
            bufferSeconds: 30,
            configuredBufferCapSeconds: 60,
            currentLevel: 4,
            nowMs: 30_000,
            segmentDurationSeconds: 4
        }));
        expect(governor.getState()).toMatchObject({ capLevel: 4, phase: 'steady', upVotes: 0 });

        for (const [nowMs, bufferSeconds] of [
            [32_000, 28],
            [34_000, 26],
            [36_000, 24],
            [38_000, 22]
        ]) {
            governor.observe(createSnapshot({
                bufferSeconds,
                configuredBufferCapSeconds: 60,
                currentLevel: 4,
                nowMs,
                segmentDurationSeconds: 4
            }));
        }
        expect(governor.getState().bufferSlope).toBeLessThan(-0.5);

        for (const [nowMs, bufferSeconds] of [
            [39_000, 25],
            [40_000, 26]
        ]) {
            governor.recordFragment(createFragmentSample({ level: 4, nowMs }));
            expect(governor.observe(createSnapshot({
                bufferSeconds,
                configuredBufferCapSeconds: 60,
                currentLevel: 4,
                nowMs,
                segmentDurationSeconds: 4
            }))).toBeNull();
        }
        expect(governor.getState()).toMatchObject({ upTargetLevel: 5, upVotes: 2 });
        expect(governor.getState().bufferSlope).toBeLessThan(-0.05);

        governor.recordFragment(createFragmentSample({ level: 4, nowMs: 41_000 }));
        expect(governor.observe(createSnapshot({
            bufferSeconds: 27,
            configuredBufferCapSeconds: 60,
            currentLevel: 4,
            nowMs: 41_000,
            segmentDurationSeconds: 4
        }))).toMatchObject({
            capLevel: 5,
            phase: 'probation',
            probeLevel: 5,
            reason: 'bandwidth-buffer-up'
        });
    });

    it('keeps the negative-slope veto without positive capped-buffer refills', () => {
        const governor = createGovernor();
        for (let nowMs = 1_000; nowMs <= 4_000; nowMs += 1_000) {
            governor.recordFragment(createFragmentSample({ level: 4, nowMs }));
            governor.observe(createSnapshot({
                bufferSeconds: 24,
                currentLevel: 4,
                nowMs,
                segmentDurationSeconds: 4
            }));
        }

        governor.observe(createSnapshot({
            bufferSeconds: 40,
            configuredBufferCapSeconds: 60,
            currentLevel: 4,
            nowMs: 30_000,
            segmentDurationSeconds: 4
        }));
        for (const [nowMs, bufferSeconds] of [
            [32_000, 38],
            [34_000, 36],
            [36_000, 34],
            [38_000, 32]
        ]) {
            governor.observe(createSnapshot({
                bufferSeconds,
                configuredBufferCapSeconds: 60,
                currentLevel: 4,
                nowMs,
                segmentDurationSeconds: 4
            }));
        }

        for (const [nowMs, bufferSeconds] of [
            [39_000, 31.8],
            [40_000, 31.6],
            [41_000, 31.4]
        ]) {
            governor.recordFragment(createFragmentSample({ level: 4, nowMs }));
            expect(governor.observe(createSnapshot({
                bufferSeconds,
                configuredBufferCapSeconds: 60,
                currentLevel: 4,
                nowMs,
                segmentDurationSeconds: 4
            }))).toBeNull();
        }

        expect(governor.getState()).toMatchObject({
            capLevel: 4,
            phase: 'steady',
            upTargetLevel: 4,
            upVotes: 0
        });
        expect(governor.getState().bufferSlope).toBeLessThan(-0.05);
    });

    it('probes one safe rung when hls.js stays below the existing cap', () => {
        const governor = createGovernor();
        for (let nowMs = 1_000; nowMs <= 4_000; nowMs += 1_000) {
            governor.recordFragment(createFragmentSample({ level: 0, nowMs }));
        }

        expect(governor.observe(createSnapshot({
            bufferSeconds: 11,
            currentLevel: 0,
            nowMs: 30_000,
            segmentDurationSeconds: 4
        }))).toBeNull();
        expect(governor.getState()).toMatchObject({ capLevel: 4, lastLoadedLevel: 0, upTargetLevel: 0, upVotes: 0 });

        governor.recordFragment(createFragmentSample({ level: 0, nowMs: 46_000 }));
        expect(governor.observe(createSnapshot({
            bufferSeconds: 13,
            currentLevel: 0,
            nowMs: 46_000,
            segmentDurationSeconds: 4
        }))).toBeNull();
        governor.recordFragment(createFragmentSample({ level: 0, nowMs: 47_000 }));
        expect(governor.observe(createSnapshot({
            bufferSeconds: 14,
            currentLevel: 0,
            nowMs: 47_000,
            segmentDurationSeconds: 4
        }))).toMatchObject({
            capLevel: 4,
            phase: 'probation',
            probeLevel: 1,
            reason: 'native-lag-probe'
        });
    });

    it('restores a risk-reduced cap through bursty iPhone buffer refills', () => {
        const governor = createGovernor();
        expect(governor.observe(createSnapshot({
            bufferSeconds: 2,
            currentLevel: 4,
            isEmergency: true,
            nativeEmergencyLevel: 0,
            nowMs: 1_000,
            segmentDurationSeconds: 4
        }))).toMatchObject({ capLevel: 0, phase: 'recovery' });

        for (let nowMs = 2_000; nowMs <= 5_000; nowMs += 1_000) {
            governor.recordFragment(createFragmentSample({ level: 0, nowMs }));
            governor.observe(createSnapshot({
                bufferSeconds: 4 + ((nowMs - 2_000) / 1_000) * 3,
                currentLevel: 0,
                nowMs,
                segmentDurationSeconds: 4
            }));
        }

        for (let nowMs = 32_000, bufferSeconds = 30; bufferSeconds >= 10; nowMs += 2_000, bufferSeconds -= 2) {
            governor.observe(createSnapshot({
                bufferSeconds,
                currentLevel: 0,
                nowMs,
                segmentDurationSeconds: 4
            }));
        }
        expect(governor.getState()).toMatchObject({
            capLevel: 0,
            phase: 'startup',
            restoreCapLevel: 4
        });
        expect(governor.getState().bufferSlope).toBeLessThan(-0.5);

        governor.recordFragment(createFragmentSample({ level: 0, nowMs: 54_000 }));
        expect(governor.observe(createSnapshot({
            bufferSeconds: 13,
            currentLevel: 0,
            nowMs: 54_000,
            segmentDurationSeconds: 4
        }))).toBeNull();
        expect(governor.getState()).toMatchObject({ upTargetLevel: 1, upVotes: 1 });

        governor.recordFragment(createFragmentSample({ level: 0, nowMs: 54_500 }));
        expect(governor.observe(createSnapshot({
            bufferSeconds: 16,
            currentLevel: 0,
            nowMs: 54_500,
            segmentDurationSeconds: 4
        }))).toMatchObject({ capLevel: 1, probeLevel: 1, reason: 'bandwidth-buffer-up' });

        governor.recordFragment(createFragmentSample({ level: 1, nowMs: 55_500 }));
        governor.observe(createSnapshot({ bufferSeconds: 19, currentLevel: 1, nowMs: 55_500, segmentDurationSeconds: 4 }));
        governor.recordFragment(createFragmentSample({ level: 1, nowMs: 56_500 }));
        governor.observe(createSnapshot({ bufferSeconds: 22, currentLevel: 1, nowMs: 56_500, segmentDurationSeconds: 4 }));
        expect(governor.getState()).toMatchObject({ capLevel: 1, phase: 'startup', restoreCapLevel: 4 });

        governor.recordFragment(createFragmentSample({ level: 1, nowMs: 57_500 }));
        expect(governor.observe(createSnapshot({
            bufferSeconds: 25,
            currentLevel: 1,
            nowMs: 57_500,
            segmentDurationSeconds: 4
        }))).toMatchObject({ capLevel: 2, probeLevel: 2, reason: 'bandwidth-buffer-up' });
    });

    it('starts a safe restore during recovery when fresh fragments refill a draining buffer', () => {
        const governor = createGovernor();
        expect(governor.observe(createSnapshot({
            bufferSeconds: 2,
            currentLevel: 4,
            isEmergency: true,
            nativeEmergencyLevel: 0,
            nowMs: 1_000,
            segmentDurationSeconds: 4
        }))).toMatchObject({ capLevel: 0, phase: 'recovery' });

        for (let nowMs = 2_000; nowMs <= 9_000; nowMs += 1_000) {
            governor.recordFragment(createFragmentSample({ level: 0, nowMs }));
        }
        governor.observe(createSnapshot({
            bufferSeconds: 8,
            currentLevel: 0,
            nowMs: 9_000,
            segmentDurationSeconds: 4
        }));
        for (const [nowMs, bufferSeconds] of [
            [10_000, 24],
            [14_000, 20],
            [18_000, 16],
            [22_000, 13]
        ]) {
            governor.observe(createSnapshot({
                bufferSeconds,
                currentLevel: 0,
                nowMs,
                segmentDurationSeconds: 4
            }));
        }

        governor.recordFragment(createFragmentSample({ level: 0, nowMs: 25_000 }));
        expect(governor.observe(createSnapshot({
            bufferSeconds: 13.5,
            currentLevel: 0,
            nowMs: 25_000,
            segmentDurationSeconds: 4
        }))).toBeNull();
        expect(governor.getState()).toMatchObject({
            capLevel: 0,
            phase: 'recovery',
            restoreCapLevel: 4,
            upTargetLevel: 1,
            upVotes: 1
        });
        expect(governor.getState().bufferSlope).toBeLessThan(-0.05);

        governor.observe(createSnapshot({
            bufferSeconds: 13.5,
            currentLevel: 0,
            nowMs: 25_500,
            segmentDurationSeconds: 4
        }));
        expect(governor.getState()).toMatchObject({ upTargetLevel: 1, upVotes: 1 });

        governor.recordFragment(createFragmentSample({ level: 0, nowMs: 26_000 }));
        expect(governor.observe(createSnapshot({
            bufferSeconds: 13.5,
            currentLevel: 0,
            nowMs: 26_000,
            segmentDurationSeconds: 4
        }))).toMatchObject({
            capLevel: 1,
            phase: 'probation',
            probeLevel: 1,
            reason: 'bandwidth-buffer-up'
        });
    });

    it('restores after a mobile waiting-to-refill cycle without renewing recovery', () => {
        const governor = createGovernor();
        expect(governor.observe(createSnapshot({
            bufferSeconds: 2,
            currentLevel: 4,
            isEmergency: true,
            nativeEmergencyLevel: 0,
            nowMs: 1_000,
            segmentDurationSeconds: 4
        }))).toMatchObject({ capLevel: 0, phase: 'recovery' });

        for (let nowMs = 2_000; nowMs <= 11_000; nowMs += 1_000) {
            governor.recordFragment(createFragmentSample({ level: 0, nowMs }));
        }
        governor.observe(createSnapshot({
            bufferSeconds: 8,
            currentLevel: 0,
            nowMs: 11_000,
            segmentDurationSeconds: 4
        }));

        expect(governor.observe(createSnapshot({
            bufferSeconds: 10,
            currentLevel: 0,
            isWaiting: true,
            nowMs: 24_000,
            segmentDurationSeconds: 4
        }))).toBeNull();
        expect(governor.getState()).toMatchObject({
            phase: 'recovery',
            recoveryRemainingSeconds: 7,
            upVotes: 0
        });

        governor.recordFragment(createFragmentSample({ level: 0, nowMs: 25_000 }));
        governor.observe(createSnapshot({
            bufferSeconds: 13,
            currentLevel: 0,
            nowMs: 25_000,
            segmentDurationSeconds: 4
        }));
        expect(governor.getState()).toMatchObject({
            recoveryRemainingSeconds: 6,
            upTargetLevel: 1,
            upVotes: 1
        });

        expect(governor.observe(createSnapshot({
            bufferSeconds: 13,
            currentLevel: 0,
            isWaiting: true,
            nowMs: 25_500,
            segmentDurationSeconds: 4
        }))).toBeNull();
        expect(governor.getState()).toMatchObject({
            recoveryRemainingSeconds: 5.5,
            upTargetLevel: 0,
            upVotes: 0
        });

        governor.recordFragment(createFragmentSample({ level: 0, nowMs: 26_000 }));
        governor.observe(createSnapshot({
            bufferSeconds: 14.5,
            currentLevel: 0,
            nowMs: 26_000,
            segmentDurationSeconds: 4
        }));
        expect(governor.getState()).toMatchObject({ upTargetLevel: 1, upVotes: 1 });

        governor.recordFragment(createFragmentSample({ level: 0, nowMs: 27_000 }));
        expect(governor.observe(createSnapshot({
            bufferSeconds: 16,
            currentLevel: 0,
            nowMs: 27_000,
            segmentDurationSeconds: 4
        }))).toMatchObject({
            capLevel: 1,
            phase: 'probation',
            probeLevel: 1,
            reason: 'bandwidth-buffer-up'
        });
    });

    it('pairs delayed iOS buffer visibility with its completed refill fragments', () => {
        const governor = createGovernor();
        expect(governor.observe(createSnapshot({
            bufferSeconds: 2,
            currentLevel: 4,
            isEmergency: true,
            nativeEmergencyLevel: 0,
            nowMs: 1_000,
            segmentDurationSeconds: 4
        }))).toMatchObject({ capLevel: 0, phase: 'recovery' });

        for (let nowMs = 2_000; nowMs <= 13_000; nowMs += 1_000) {
            governor.recordFragment(createFragmentSample({ level: 0, nowMs }));
            governor.observe(createSnapshot({
                bufferSeconds: 8,
                currentLevel: 0,
                nowMs,
                segmentDurationSeconds: 4
            }));
        }

        for (const [nowMs, bufferSeconds] of [
            [32_000, 30],
            [34_000, 28],
            [38_000, 24],
            [42_000, 20],
            [46_000, 16],
            [50_000, 12],
            [52_000, 10]
        ]) {
            governor.observe(createSnapshot({
                bufferSeconds,
                currentLevel: 0,
                nowMs,
                segmentDurationSeconds: 4
            }));
        }
        expect(governor.getState()).toMatchObject({
            capLevel: 0,
            phase: 'startup',
            restoreCapLevel: 4,
            upVotes: 0
        });

        governor.observe(createSnapshot({
            bufferSeconds: 10,
            currentLevel: 0,
            isWaiting: true,
            nowMs: 52_500,
            segmentDurationSeconds: 4
        }));
        for (let index = 0; index < 7; index++) {
            const nowMs = 53_000 + (index * 100);
            governor.recordFragment(createFragmentSample({ level: 0, nowMs }));
            expect(governor.observe(createSnapshot({
                bufferSeconds: 10,
                currentLevel: 0,
                nowMs,
                segmentDurationSeconds: 4
            }))).toBeNull();
        }
        expect(governor.getState()).toMatchObject({
            capLevel: 0,
            lastRefillCredits: 0,
            pendingRefillFragments: 7,
            upTargetLevel: 0,
            upVotes: 0
        });

        expect(governor.observe(createSnapshot({
            bufferSeconds: 30,
            currentLevel: 0,
            nowMs: 55_000,
            segmentDurationSeconds: 4
        }))).toMatchObject({
            capLevel: 1,
            phase: 'probation',
            probeLevel: 1,
            reason: 'bandwidth-buffer-up'
        });
        expect(governor.getState()).toMatchObject({
            lastRefillCredits: 5,
            pendingRefillFragments: 0
        });
    });

    it('expires stale iOS refill fragments before an unrelated buffer jump', () => {
        const governor = createGovernor();
        governor.observe(createSnapshot({
            bufferSeconds: 2,
            currentLevel: 4,
            isEmergency: true,
            nativeEmergencyLevel: 0,
            nowMs: 1_000,
            segmentDurationSeconds: 4
        }));
        for (let nowMs = 2_000; nowMs <= 13_000; nowMs += 1_000) {
            governor.recordFragment(createFragmentSample({ level: 0, nowMs }));
            governor.observe(createSnapshot({
                bufferSeconds: 8,
                currentLevel: 0,
                nowMs,
                segmentDurationSeconds: 4
            }));
        }
        governor.observe(createSnapshot({
            bufferSeconds: 10,
            currentLevel: 0,
            nowMs: 52_000,
            segmentDurationSeconds: 4
        }));
        for (let index = 0; index < 3; index++) {
            const nowMs = 53_000 + (index * 100);
            governor.recordFragment(createFragmentSample({ level: 0, nowMs }));
            governor.observe(createSnapshot({
                bufferSeconds: 10,
                currentLevel: 0,
                nowMs,
                segmentDurationSeconds: 4
            }));
        }
        expect(governor.getState()).toMatchObject({
            lastRefillCredits: 0,
            pendingRefillFragments: 3
        });

        expect(governor.observe(createSnapshot({
            bufferSeconds: 30,
            currentLevel: 0,
            nowMs: 65_000,
            segmentDurationSeconds: 4
        }))).toBeNull();
        expect(governor.getState()).toMatchObject({
            capLevel: 0,
            lastRefillCredits: 0,
            pendingRefillFragments: 0,
            upTargetLevel: 0,
            upVotes: 0
        });
    });

    it('bounds continuous stale iOS refill callbacks from the first callback', () => {
        const governor = createGovernor();
        governor.observe(createSnapshot({
            bufferSeconds: 2,
            currentLevel: 4,
            isEmergency: true,
            nativeEmergencyLevel: 0,
            nowMs: 1_000,
            segmentDurationSeconds: 4
        }));
        for (let nowMs = 2_000; nowMs <= 13_000; nowMs += 1_000) {
            governor.recordFragment(createFragmentSample({ level: 0, nowMs }));
            governor.observe(createSnapshot({
                bufferSeconds: 8,
                currentLevel: 0,
                nowMs,
                segmentDurationSeconds: 4
            }));
        }
        governor.observe(createSnapshot({
            bufferSeconds: 10,
            currentLevel: 0,
            nowMs: 52_000,
            segmentDurationSeconds: 4
        }));

        for (let nowMs = 53_000; nowMs <= 62_000; nowMs += 1_000) {
            governor.recordFragment(createFragmentSample({ level: 0, nowMs }));
            governor.observe(createSnapshot({
                bufferSeconds: 10,
                currentLevel: 0,
                nowMs,
                segmentDurationSeconds: 4
            }));
        }
        expect(governor.getState()).toMatchObject({ pendingRefillFragments: 1, upVotes: 0 });

        expect(governor.observe(createSnapshot({
            bufferSeconds: 30,
            currentLevel: 0,
            nowMs: 63_000,
            segmentDurationSeconds: 4
        }))).toBeNull();
        expect(governor.getState()).toMatchObject({
            capLevel: 0,
            lastRefillCredits: 1,
            pendingRefillFragments: 0,
            upTargetLevel: 1,
            upVotes: 1
        });
    });

    it('invalidates delayed refill evidence when playback rate changes', () => {
        const governor = createGovernor();
        governor.observe(createSnapshot({
            bufferSeconds: 2,
            currentLevel: 4,
            isEmergency: true,
            nativeEmergencyLevel: 0,
            nowMs: 1_000,
            segmentDurationSeconds: 4
        }));
        for (let nowMs = 2_000; nowMs <= 13_000; nowMs += 1_000) {
            governor.recordFragment(createFragmentSample({ level: 0, nowMs }));
            governor.observe(createSnapshot({
                bufferSeconds: 8,
                currentLevel: 0,
                nowMs,
                segmentDurationSeconds: 4
            }));
        }
        governor.observe(createSnapshot({
            bufferSeconds: 10,
            currentLevel: 0,
            nowMs: 52_000,
            segmentDurationSeconds: 4
        }));
        for (let index = 0; index < 3; index++) {
            const nowMs = 53_000 + (index * 100);
            governor.recordFragment(createFragmentSample({ level: 0, nowMs }));
            governor.observe(createSnapshot({
                bufferSeconds: 10,
                currentLevel: 0,
                nowMs,
                segmentDurationSeconds: 4
            }));
        }
        expect(governor.getState()).toMatchObject({ pendingRefillFragments: 3 });

        expect(governor.observe(createSnapshot({
            bufferSeconds: 10,
            currentLevel: 0,
            nowMs: 54_000,
            playbackRate: 0.25,
            segmentDurationSeconds: 4
        }))).toBeNull();
        expect(governor.getState()).toMatchObject({
            capLevel: 0,
            lastRefillCredits: 0,
            pendingRefillFragments: 0,
            upTargetLevel: 0,
            upVotes: 0
        });
    });

    it('does not restore a reduced cap when refill service cannot sustain the next rung', () => {
        const governor = createGovernor();
        governor.observe(createSnapshot({
            bufferSeconds: 2,
            currentLevel: 4,
            isEmergency: true,
            nativeEmergencyLevel: 0,
            nowMs: 1_000,
            segmentDurationSeconds: 4
        }));

        for (let nowMs = 2_000; nowMs <= 5_000; nowMs += 1_000) {
            governor.recordFragment(createFragmentSample({ bandwidth: 1_000_000, level: 0, nowMs }));
            governor.observe(createSnapshot({
                bufferSeconds: 13,
                currentLevel: 0,
                hlsBandwidthEstimate: 1_000_000,
                nowMs,
                segmentDurationSeconds: 4
            }));
        }

        governor.recordFragment(createFragmentSample({ bandwidth: 1_000_000, level: 0, nowMs: 54_000 }));
        expect(governor.observe(createSnapshot({
            bufferSeconds: 16,
            currentLevel: 0,
            hlsBandwidthEstimate: 1_000_000,
            nowMs: 54_000,
            segmentDurationSeconds: 4
        }))).toBeNull();
        expect(governor.getState()).toMatchObject({ capLevel: 0, restoreCapLevel: 4, upTargetLevel: 0, upVotes: 0 });
    });

    it('validates probation with target fragments, not lower in-flight fragments', () => {
        const governor = createGovernor();
        governor.recordFragment(createFragmentSample({ level: 4, nowMs: 1_000 }));
        governor.recordFragment(createFragmentSample({ level: 4, nowMs: 2_000 }));
        governor.observe(createSnapshot({ bufferSeconds: 14, currentLevel: 4, nowMs: 12_000 }));
        governor.recordFragment(createFragmentSample({ level: 4, nowMs: 13_000 }));
        expect(governor.observe(createSnapshot({ bufferSeconds: 15, currentLevel: 4, nowMs: 13_000 })))
            .toMatchObject({ capLevel: 5, probeLevel: 5 });

        governor.recordFragment(createFragmentSample({ level: 4, nowMs: 14_000 }));
        governor.observe(createSnapshot({ bufferSeconds: 16, currentLevel: 4, nowMs: 14_000 }));
        expect(governor.getState()).toMatchObject({ phase: 'probation', probationLevel: 5 });

        governor.recordFragment(createFragmentSample({ level: 5, nowMs: 15_000 }));
        governor.observe(createSnapshot({ bufferSeconds: 18, currentLevel: 5, nowMs: 15_000 }));
        governor.recordFragment(createFragmentSample({ level: 5, nowMs: 16_000 }));
        governor.observe(createSnapshot({ bufferSeconds: 19, currentLevel: 5, nowMs: 16_000 }));
        expect(governor.getState()).toMatchObject({ capLevel: 5, phase: 'steady', probationLevel: -1 });
    });

    it('re-probes once when hls.js returns to the floor after a successful probe', () => {
        const governor = createGovernor();
        for (let nowMs = 1_000; nowMs <= 4_000; nowMs += 1_000) {
            governor.recordFragment(createFragmentSample({ level: 0, nowMs }));
        }

        governor.observe(createSnapshot({ bufferSeconds: 13, currentLevel: 0, nowMs: 46_000 }));
        governor.recordFragment(createFragmentSample({ level: 0, nowMs: 47_000 }));
        expect(governor.observe(createSnapshot({ bufferSeconds: 14, currentLevel: 0, nowMs: 47_000 })))
            .toMatchObject({ capLevel: 4, probeLevel: 1, reason: 'native-lag-probe' });

        governor.recordFragment(createFragmentSample({ level: 1, nowMs: 48_000 }));
        expect(governor.observe(createSnapshot({ bufferSeconds: 15, currentLevel: 1, nowMs: 48_000 }))).toBeNull();

        governor.recordFragment(createFragmentSample({ level: 0, nowMs: 49_000 }));
        expect(governor.observe(createSnapshot({ bufferSeconds: 16, currentLevel: 0, nowMs: 49_000 })))
            .toMatchObject({ capLevel: 4, probeLevel: 1, reason: 'probation-validation-probe' });

        governor.recordFragment(createFragmentSample({ level: 0, nowMs: 50_000 }));
        expect(governor.observe(createSnapshot({ bufferSeconds: 17, currentLevel: 0, nowMs: 50_000 }))).toBeNull();
        expect(governor.getState()).toMatchObject({ phase: 'probation', probationProbePending: true });

        governor.recordFragment(createFragmentSample({ level: 1, nowMs: 51_000 }));
        expect(governor.observe(createSnapshot({ bufferSeconds: 18, currentLevel: 1, nowMs: 51_000 }))).toBeNull();
        expect(governor.getState()).toMatchObject({ capLevel: 4, phase: 'steady', probationLevel: -1 });
    });

    it('restores a raised cap when its requested probe never starts', () => {
        const governor = createGovernor();
        governor.recordFragment(createFragmentSample({ level: 4, nowMs: 1_000 }));
        governor.recordFragment(createFragmentSample({ level: 4, nowMs: 2_000 }));
        governor.observe(createSnapshot({ bufferSeconds: 14, currentLevel: 4, nowMs: 12_000 }));
        governor.recordFragment(createFragmentSample({ level: 4, nowMs: 13_000 }));
        governor.observe(createSnapshot({ bufferSeconds: 15, currentLevel: 4, nowMs: 13_000 }));

        let decision = null;
        for (let nowMs = 14_000; nowMs <= 15_000; nowMs += 1_000) {
            governor.recordFragment(createFragmentSample({ level: 4, nowMs }));
            decision = governor.observe(createSnapshot({ bufferSeconds: 16, currentLevel: 4, nowMs }));
        }

        expect(decision).toMatchObject({ capLevel: 4, phase: 'steady', reason: 'probe-start-timeout' });
        expect(governor.getState()).toMatchObject({ capLevel: 4, probationLevel: -1 });
    });

    it('rolls back immediately when the player rejects a requested probe', () => {
        const governor = createGovernor();
        governor.recordFragment(createFragmentSample({ level: 4, nowMs: 1_000 }));
        governor.recordFragment(createFragmentSample({ level: 4, nowMs: 2_000 }));
        governor.observe(createSnapshot({ bufferSeconds: 14, currentLevel: 4, nowMs: 12_000 }));
        governor.recordFragment(createFragmentSample({ level: 4, nowMs: 13_000 }));
        expect(governor.observe(createSnapshot({ bufferSeconds: 15, currentLevel: 4, nowMs: 13_000 })))
            .toMatchObject({ capLevel: 5, probeLevel: 5 });
        expect(governor.getState()).toMatchObject({ probationProbePending: true });

        expect(governor.rejectProbe(5, 14_000)).toMatchObject({
            capLevel: 4,
            phase: 'steady',
            reason: 'probe-rejected'
        });
        expect(governor.getState()).toMatchObject({ capLevel: 4, probationLevel: -1, probationProbePending: false });
    });

    it('rolls back a raised pending probe when playback pauses', () => {
        const governor = createGovernor();
        governor.recordFragment(createFragmentSample({ level: 4, nowMs: 1_000 }));
        governor.recordFragment(createFragmentSample({ level: 4, nowMs: 2_000 }));
        governor.observe(createSnapshot({ bufferSeconds: 14, currentLevel: 4, nowMs: 12_000 }));
        governor.recordFragment(createFragmentSample({ level: 4, nowMs: 13_000 }));
        expect(governor.observe(createSnapshot({ bufferSeconds: 15, currentLevel: 4, nowMs: 13_000 })))
            .toMatchObject({ capLevel: 5, probeLevel: 5 });

        expect(governor.observe(createSnapshot({
            bufferSeconds: 15,
            currentLevel: 4,
            isPaused: true,
            nowMs: 14_000
        }))).toMatchObject({
            capLevel: 4,
            forceLevel: 4,
            phase: 'steady',
            reason: 'probation-paused'
        });
        expect(governor.getState()).toMatchObject({
            capLevel: 4,
            probationLevel: -1,
            probationProbePending: false
        });

        expect(governor.observe(createSnapshot({ bufferSeconds: 15, currentLevel: 4, nowMs: 15_000 }))).toBeNull();
        expect(governor.getState()).toMatchObject({ capLevel: 4, phase: 'startup' });
    });

    it('rolls back an unvalidated raised cap when seeking resets probation', () => {
        const governor = createGovernor();
        governor.recordFragment(createFragmentSample({ level: 4, nowMs: 1_000 }));
        governor.recordFragment(createFragmentSample({ level: 4, nowMs: 2_000 }));
        governor.observe(createSnapshot({ bufferSeconds: 14, currentLevel: 4, nowMs: 12_000 }));
        governor.recordFragment(createFragmentSample({ level: 4, nowMs: 13_000 }));
        governor.observe(createSnapshot({ bufferSeconds: 15, currentLevel: 4, nowMs: 13_000 }));
        expect(governor.confirmProbe(5)).toBe(true);

        expect(governor.resetForSeek(14_000)).toMatchObject({
            capLevel: 4,
            forceLevel: 4,
            reason: 'probation-seeking'
        });
        expect(governor.getState()).toMatchObject({
            capLevel: 4,
            phase: 'startup',
            probationLevel: -1,
            probationProbePending: false
        });
    });

    it('cancels a pending probe that exceeds a new decoder hard cap', () => {
        const governor = createGovernor();
        governor.recordFragment(createFragmentSample({ level: 4, nowMs: 1_000 }));
        governor.recordFragment(createFragmentSample({ level: 4, nowMs: 2_000 }));
        governor.observe(createSnapshot({ bufferSeconds: 14, currentLevel: 4, nowMs: 12_000 }));
        governor.recordFragment(createFragmentSample({ level: 4, nowMs: 13_000 }));
        governor.observe(createSnapshot({ bufferSeconds: 15, currentLevel: 4, nowMs: 13_000 }));
        expect(governor.getState()).toMatchObject({ capLevel: 5, probationLevel: 5, probationProbePending: true });

        expect(governor.setHardCap(4)).toMatchObject({ capLevel: 4, phase: 'steady', reason: 'hard-cap' });
        expect(governor.getState()).toMatchObject({
            capLevel: 4,
            hardCapLevel: 4,
            probationLevel: -1,
            probationProbePending: false
        });
    });

    it('allows the adjacent 720 Kbps to 1.5 Mbps rung after safety checks', () => {
        const governor = new HlsAbrGovernor({
            initialBandwidthEstimate: 2_000_000,
            levels: levels.slice(0, 3),
            nowMs: 0
        });
        governor.recordFragment(createFragmentSample({ bandwidth: 10_000_000, level: 1, nowMs: 1_000 }));
        governor.recordFragment(createFragmentSample({ bandwidth: 10_000_000, level: 1, nowMs: 2_000 }));

        governor.observe(createSnapshot({ bufferSeconds: 14, currentLevel: 1, nowMs: 12_000 }));
        governor.recordFragment(createFragmentSample({ bandwidth: 10_000_000, level: 1, nowMs: 13_000 }));
        expect(governor.observe(createSnapshot({ bufferSeconds: 15, currentLevel: 1, nowMs: 13_000 }))).toMatchObject({
            capLevel: 2,
            probeLevel: 2,
            reason: 'bandwidth-buffer-up'
        });
    });

    it('does not count duplicate observe bursts as additional upshift votes', () => {
        const governor = createGovernor();
        governor.recordFragment(createFragmentSample({ nowMs: 1_000 }));
        governor.recordFragment(createFragmentSample({ nowMs: 2_000 }));

        expect(governor.observe(createSnapshot({ bufferSeconds: 14, nowMs: 12_000 }))).toBeNull();
        expect(governor.observe(createSnapshot({ bufferSeconds: 15, nowMs: 12_100 }))).toBeNull();
        expect(governor.getState().capLevel).toBe(4);
        governor.recordFragment(createFragmentSample({ nowMs: 13_000 }));
        expect(governor.observe(createSnapshot({ bufferSeconds: 15, nowMs: 13_000 }))).toMatchObject({ capLevel: 5 });
    });

    it('does not let polling ticks count or erase fragment-backed votes', () => {
        const governor = createGovernor();
        governor.recordFragment(createFragmentSample({ nowMs: 1_000 }));
        governor.recordFragment(createFragmentSample({ nowMs: 2_000 }));

        expect(governor.observe(createSnapshot({ bufferSeconds: 14, nowMs: 12_000 }))).toBeNull();
        expect(governor.observe(createSnapshot({ bufferSeconds: 15, nowMs: 13_000 }))).toBeNull();
        expect(governor.observe(createSnapshot({ bufferSeconds: 12, nowMs: 14_000 }))).toBeNull();
        expect(governor.getState().capLevel).toBe(4);

        governor.recordFragment(createFragmentSample({ nowMs: 15_000 }));
        expect(governor.observe(createSnapshot({ bufferSeconds: 16, nowMs: 15_000 })))
            .toMatchObject({ capLevel: 5, reason: 'bandwidth-buffer-up' });
    });

    it('does not let poll-only bandwidth changes erase fragment votes', () => {
        const governor = createGovernor();
        governor.recordFragment(createFragmentSample({ nowMs: 1_000 }));
        governor.recordFragment(createFragmentSample({ nowMs: 2_000 }));

        expect(governor.observe(createSnapshot({ bufferSeconds: 14, nowMs: 12_000 }))).toBeNull();
        expect(governor.getState()).toMatchObject({ upTargetLevel: 5, upVotes: 1 });
        expect(governor.observe(createSnapshot({
            bufferSeconds: 15,
            hlsBandwidthEstimate: 8_000_000,
            nowMs: 13_000
        }))).toBeNull();
        expect(governor.getState()).toMatchObject({ upTargetLevel: 5, upVotes: 1 });

        governor.recordFragment(createFragmentSample({ nowMs: 14_000 }));
        expect(governor.observe(createSnapshot({ bufferSeconds: 16, nowMs: 14_000 })))
            .toMatchObject({ capLevel: 5, reason: 'bandwidth-buffer-up' });
    });

    it('keeps fast-filled playback in startup long enough to ramp', () => {
        const governor = createGovernor({ initialBandwidthEstimate: 100_000 });
        for (let nowMs = 1_000; nowMs <= 4_000; nowMs += 1_000) {
            governor.recordFragment(createFragmentSample({ level: 0, nowMs }));
        }

        expect(governor.observe(createSnapshot({ bufferSeconds: 22, currentLevel: 0, nowMs: 4_000 }))).toBeNull();
        expect(governor.getState()).toMatchObject({ capLevel: 0, phase: 'startup' });

        governor.recordFragment(createFragmentSample({ level: 0, nowMs: 10_000 }));
        expect(governor.observe(createSnapshot({ bufferSeconds: 22, currentLevel: 0, nowMs: 10_000 }))).toBeNull();
        governor.recordFragment(createFragmentSample({ level: 0, nowMs: 11_000 }));
        expect(governor.observe(createSnapshot({ bufferSeconds: 22, currentLevel: 0, nowMs: 11_000 })))
            .toMatchObject({ capLevel: 1, phase: 'probation', probeLevel: 1, reason: 'bandwidth-buffer-up' });
    });

    it('does not upgrade when next level lacks safety margin', () => {
        const governor = createGovernor();
        governor.recordFragment(createFragmentSample({ bandwidth: 8_000_000, nowMs: 1_000 }));
        governor.recordFragment(createFragmentSample({ bandwidth: 8_000_000, nowMs: 2_000 }));

        governor.observe(createSnapshot({ bufferSeconds: 14, hlsBandwidthEstimate: 8_000_000, nowMs: 12_000 }));
        governor.recordFragment(createFragmentSample({ bandwidth: 8_000_000, nowMs: 13_000 }));
        const decision = governor.observe(createSnapshot({ bufferSeconds: 15, hlsBandwidthEstimate: 8_000_000, nowMs: 13_000 }));

        expect(decision).toBeNull();
        expect(governor.getState().capLevel).toBe(4);
    });

    it('lets a floor emergency cancel an active upward probe', () => {
        const governor = createGovernor({ initialBandwidthEstimate: 100_000 });
        for (let nowMs = 1_000; nowMs <= 4_000; nowMs += 1_000) {
            governor.recordFragment(createFragmentSample({ level: 0, nowMs }));
        }
        governor.observe(createSnapshot({ bufferSeconds: 22, currentLevel: 0, nowMs: 10_000 }));
        governor.recordFragment(createFragmentSample({ level: 0, nowMs: 11_000 }));
        expect(governor.observe(createSnapshot({ bufferSeconds: 22, currentLevel: 0, nowMs: 11_000 })))
            .toMatchObject({ capLevel: 1, phase: 'probation', probeLevel: 1 });

        expect(governor.observe(createSnapshot({ bufferSeconds: 2, currentLevel: 0, isWaiting: true, nowMs: 12_000 })))
            .toMatchObject({ capLevel: 0, phase: 'recovery', reason: 'emergency' });
        expect(governor.getState()).toMatchObject({ probationLevel: -1, upVotes: 0 });
    });
});

describe('HlsAbrGovernor downshifts', () => {
    it('skips directly to a sustainable level during an emergency', () => {
        const governor = createGovernor({ initialBandwidthEstimate: 40_000_000 });
        governor.recordFragment(createFragmentSample({ bandwidth: 4_000_000, level: 6, nowMs: 1_000 }));

        const decision = governor.observe(createSnapshot({
            bufferSeconds: 2,
            currentLevel: 6,
            hlsBandwidthEstimate: 4_000_000,
            isEmergency: true,
            nowMs: 2_000
        }));

        expect(decision).toMatchObject({
            capLevel: 2,
            forceLevel: 2,
            phase: 'recovery',
            reason: 'emergency'
        });
    });

    it('lets buffer pressure win over an otherwise valid upshift', () => {
        const governor = createGovernor();
        governor.recordFragment(createFragmentSample({ bandwidth: 4_000_000, nowMs: 1_000 }));
        governor.recordFragment(createFragmentSample({ bandwidth: 4_000_000, nowMs: 2_000 }));
        governor.recordFragment(createFragmentSample({ bandwidth: 4_000_000, nowMs: 3_000 }));
        governor.recordFragment(createFragmentSample({ bandwidth: 4_000_000, nowMs: 4_000 }));
        governor.observe(createSnapshot({ bufferSeconds: 22, hlsBandwidthEstimate: 4_000_000, nowMs: 30_000 }));
        governor.observe(createSnapshot({ bufferSeconds: 8, hlsBandwidthEstimate: 4_000_000, nowMs: 31_000 }));

        const decision = governor.observe(createSnapshot({
            bufferSeconds: 5,
            hlsBandwidthEstimate: 4_000_000,
            nowMs: 32_000
        }));

        expect(decision?.reason).toBe('buffer-pressure');
        expect(decision?.capLevel).toBeLessThan(4);
    });

    it('does not count duplicate observe bursts as additional downshift votes', () => {
        const governor = createGovernor();
        governor.recordFragment(createFragmentSample({ bandwidth: 4_000_000, nowMs: 1_000 }));
        governor.recordFragment(createFragmentSample({ bandwidth: 4_000_000, nowMs: 2_000 }));

        expect(governor.observe(createSnapshot({ bufferSeconds: 14, hlsBandwidthEstimate: 4_000_000, nowMs: 10_000 }))).toBeNull();
        expect(governor.observe(createSnapshot({ bufferSeconds: 10, hlsBandwidthEstimate: 4_000_000, nowMs: 11_000 }))).toBeNull();
        expect(governor.observe(createSnapshot({ bufferSeconds: 9, hlsBandwidthEstimate: 4_000_000, nowMs: 11_100 }))).toBeNull();
        expect(governor.observe(createSnapshot({ bufferSeconds: 8, hlsBandwidthEstimate: 4_000_000, nowMs: 12_000 })))
            .toMatchObject({ reason: 'buffer-pressure' });
    });

    it('rolls failed probation back to the previous cap without an extra rung', () => {
        const governor = createGovernor();
        governor.recordFragment(createFragmentSample({ nowMs: 1_000 }));
        governor.recordFragment(createFragmentSample({ nowMs: 2_000 }));
        governor.observe(createSnapshot({ bufferSeconds: 14, nowMs: 12_000 }));
        governor.recordFragment(createFragmentSample({ nowMs: 13_000 }));
        expect(governor.observe(createSnapshot({ bufferSeconds: 15, nowMs: 13_000 })))
            .toMatchObject({ capLevel: 5, phase: 'probation' });

        const decision = governor.observe(createSnapshot({
            bufferSeconds: 9,
            currentLevel: 4,
            hlsBandwidthEstimate: 4_000_000,
            nowMs: 14_000
        }));

        expect(decision).toMatchObject({ capLevel: 3, phase: 'recovery', reason: 'probation-failed' });
        expect(decision?.forceLevel).toBe(3);
        expect(governor.getState()).toMatchObject({ restoreCapLevel: 4 });
    });

    it('accepts an hls.js emergency target without downshifting it again', () => {
        const governor = createGovernor({ initialBandwidthEstimate: 40_000_000 });

        const decision = governor.observe(createSnapshot({
            bufferSeconds: 2,
            currentLevel: 6,
            isEmergency: true,
            nativeEmergencyLevel: 2,
            nowMs: 2_000
        }));

        expect(decision).toMatchObject({ capLevel: 2, phase: 'recovery', reason: 'emergency' });
        expect(decision?.forceLevel).toBeUndefined();
    });

    it('does not stack another hold after recovery', () => {
        const governor = createGovernor();
        for (let nowMs = 1_000; nowMs <= 4_000; nowMs += 1_000) {
            governor.recordFragment(createFragmentSample({ nowMs }));
        }

        expect(governor.observe(createSnapshot({ bufferSeconds: 22, nowMs: 30_000 }))).toBeNull();
        governor.recordFragment(createFragmentSample({ nowMs: 31_000 }));
        expect(governor.observe(createSnapshot({ bufferSeconds: 22, nowMs: 31_000 }))).toBeNull();
        governor.recordFragment(createFragmentSample({ nowMs: 32_000 }));
        expect(governor.observe(createSnapshot({ bufferSeconds: 22, nowMs: 32_000 })))
            .toMatchObject({ capLevel: 5, phase: 'probation' });

        expect(governor.observe(createSnapshot({
            bufferSeconds: 22,
            currentLevel: 5,
            isEmergency: true,
            nativeEmergencyLevel: 0,
            nowMs: 33_000
        }))).toMatchObject({ capLevel: 0, phase: 'recovery' });
        expect(governor.getState()).toMatchObject({
            recoveryRemainingSeconds: 30,
            upHoldRemainingSeconds: 10,
            upTargetLevel: 0,
            upVotes: 0
        });

        for (let nowMs = 34_000; nowMs <= 45_000; nowMs += 1_000) {
            governor.recordFragment(createFragmentSample({ level: 0, nowMs }));
        }
        expect(governor.observe(createSnapshot({ bufferSeconds: 45, currentLevel: 0, nowMs: 63_000 }))).toBeNull();
        expect(governor.getState()).toMatchObject({ recoveryRemainingSeconds: 0, upHoldRemainingSeconds: 0, upVotes: 1 });
        governor.recordFragment(createFragmentSample({ level: 0, nowMs: 64_000 }));
        expect(governor.observe(createSnapshot({ bufferSeconds: 45, currentLevel: 0, nowMs: 64_000 })))
            .toMatchObject({ capLevel: 1, phase: 'probation', probeLevel: 1, reason: 'bandwidth-buffer-up' });
    });

    it('does not force or back off when already at the floor', () => {
        const governor = createGovernor({ initialBandwidthEstimate: 100_000 });

        expect(governor.observe(createSnapshot({ currentLevel: 0, isWaiting: true, nowMs: 2_000 }))).toBeNull();
        expect(governor.getState()).toMatchObject({ capLevel: 0, phase: 'startup' });
    });

    it('does not renew recovery after redundant floor risk while restoring a cap', () => {
        const governor = createGovernor();
        expect(governor.observe(createSnapshot({
            bufferSeconds: 2,
            currentLevel: 4,
            isEmergency: true,
            nativeEmergencyLevel: 0,
            nowMs: 2_000
        }))).toMatchObject({ capLevel: 0, phase: 'recovery' });

        for (const nowMs of [20_000, 40_000, 60_000, 80_000]) {
            expect(governor.observe(createSnapshot({
                bufferSeconds: 10,
                currentLevel: 0,
                isWaiting: true,
                nowMs
            }))).toBeNull();
        }
        expect(governor.getState()).toMatchObject({
            phase: 'recovery',
            recoveryRemainingSeconds: 0,
            restoreCapLevel: 4,
            upTargetLevel: 0,
            upVotes: 0
        });

        for (let nowMs = 88_000; nowMs <= 99_000; nowMs += 1_000) {
            governor.recordFragment(createFragmentSample({ level: 0, nowMs }));
        }
        governor.recordFragment(createFragmentSample({ level: 0, nowMs: 100_000 }));
        expect(governor.observe(createSnapshot({
            bufferSeconds: 13,
            currentLevel: 0,
            nowMs: 100_000
        }))).toBeNull();
        expect(governor.getState()).toMatchObject({
            phase: 'startup',
            recoveryRemainingSeconds: 0,
            restoreCapLevel: 4,
            upHoldRemainingSeconds: 0,
            upVotes: 1
        });
        governor.recordFragment(createFragmentSample({ level: 0, nowMs: 101_000 }));
        expect(governor.observe(createSnapshot({
            bufferSeconds: 16,
            currentLevel: 0,
            nowMs: 101_000
        }))).toMatchObject({
            capLevel: 1,
            phase: 'probation',
            probeLevel: 1
        });
    });

    it('accounts for playback rate and can downshift an unsafe startup level', () => {
        const normalRate = createGovernor();
        const doubleRate = createGovernor();
        normalRate.recordFragment(createFragmentSample({ bandwidth: 10_000_000, nowMs: 1_000 }));
        doubleRate.recordFragment(createFragmentSample({ bandwidth: 10_000_000, nowMs: 1_000 }));

        expect(normalRate.observe(createSnapshot({
            bufferSeconds: 4,
            hlsBandwidthEstimate: 10_000_000,
            nowMs: 2_000,
            playbackRate: 1
        }))).toBeNull();
        expect(doubleRate.observe(createSnapshot({
            bufferSeconds: 4,
            hlsBandwidthEstimate: 10_000_000,
            nowMs: 2_000,
            playbackRate: 2
        }))).toMatchObject({ phase: 'recovery', reason: 'critical-buffer' });
    });
});

describe('HlsAbrGovernor sampling and lifecycle', () => {
    it('uses attainable live buffer thresholds for upshifts', () => {
        const liveGovernor = createGovernor();
        const vodGovernor = createGovernor();
        for (const governor of [liveGovernor, vodGovernor]) {
            governor.recordFragment(createFragmentSample({ nowMs: 1_000 }));
            governor.recordFragment(createFragmentSample({ nowMs: 2_000 }));
        }

        expect(liveGovernor.observe(createSnapshot({ bufferSeconds: 8, isLive: true, nowMs: 12_000 }))).toBeNull();
        liveGovernor.recordFragment(createFragmentSample({ nowMs: 13_000 }));
        expect(liveGovernor.observe(createSnapshot({ bufferSeconds: 8, isLive: true, nowMs: 13_000 })))
            .toMatchObject({ capLevel: 5 });
        expect(vodGovernor.observe(createSnapshot({ bufferSeconds: 8, nowMs: 12_000 }))).toBeNull();
        vodGovernor.recordFragment(createFragmentSample({ nowMs: 13_000 }));
        expect(vodGovernor.observe(createSnapshot({ bufferSeconds: 8, nowMs: 13_000 }))).toBeNull();
    });

    it('includes TTFB in load prediction', () => {
        const governor = createGovernor();
        governor.recordFragment(createFragmentSample({ nowMs: 3_000, ttfbMs: 2_000 }));

        governor.observe(createSnapshot({ nowMs: 4_000 }));
        const state = governor.getState();

        expect(state.ttfbEstimateMs).toBe(2_000);
        expect(state.predictedCurrentLoadSeconds).toBeGreaterThan(2);
    });

    it('ignores non-main, aborted, init, tiny, and invalid samples', () => {
        const governor = createGovernor();
        const validSample = createFragmentSample({ nowMs: 1_000 });

        governor.recordFragment({ ...validSample, isMain: false });
        governor.recordFragment({ ...validSample, aborted: true });
        governor.recordFragment({ ...validSample, isInitSegment: true });
        governor.recordFragment({ ...validSample, loadedBytes: 1_000 });
        governor.recordFragment({ ...validSample, loadingEndMs: validSample.loadingFirstMs });

        expect(governor.getState().confidence).toBe(0);
    });

    it('suppresses changes while paused, seeking, or ended', () => {
        const governor = createGovernor();
        governor.recordFragment(createFragmentSample({ nowMs: 1_000 }));

        expect(governor.observe(createSnapshot({ isPaused: true, isWaiting: true, nowMs: 2_000 }))).toBeNull();
        expect(governor.observe(createSnapshot({ isSeeking: true, isWaiting: true, nowMs: 3_000 }))).toBeNull();
        expect(governor.observe(createSnapshot({ isEnded: true, isWaiting: true, nowMs: 4_000 }))).toBeNull();
    });

    it('remaps ladder updates without losing estimates, recovery, or hard caps', () => {
        const governor = createGovernor();
        governor.recordFragment(createFragmentSample({ nowMs: 1_000 }));
        expect(governor.setHardCap(4)).toBeNull();
        expect(governor.observe(createSnapshot({
            bufferSeconds: 2,
            currentLevel: 4,
            isEmergency: true,
            nativeEmergencyLevel: 2,
            nowMs: 2_000
        }))).toMatchObject({ capLevel: 2, phase: 'recovery' });

        const updatedLevels = levels
            .filter((level) => level.index !== 1)
            .map((level, index) => ({ ...level, index }));
        expect(governor.updateLevels(updatedLevels)).toMatchObject({
            capLevel: 1,
            phase: 'recovery',
            reason: 'levels-updated'
        });
        expect(governor.getState()).toMatchObject({
            capLevel: 1,
            confidence: 1,
            hardCapLevel: 3,
            recoveryRemainingSeconds: 30,
            restoreCapLevel: 3,
            upTargetLevel: 1
        });

        const uncappedGovernor = createGovernor({ initialBandwidthEstimate: 40_000_000 });
        uncappedGovernor.updateLevels([...levels, { bitrate: 30_000_000, index: levels.length }]);
        expect(uncappedGovernor.getState()).toMatchObject({ capLevel: 6, hardCapLevel: 7 });

        const explicitlyCappedGovernor = createGovernor({ initialBandwidthEstimate: 40_000_000 });
        expect(explicitlyCappedGovernor.setHardCap(levels.length - 1)).toBeNull();
        explicitlyCappedGovernor.updateLevels([...levels, { bitrate: 30_000_000, index: levels.length }]);
        expect(explicitlyCappedGovernor.getState()).toMatchObject({ capLevel: 6, hardCapLevel: 6 });
    });

    it('applies decoder hard caps and stops cleanly', () => {
        const governor = createGovernor();

        expect(governor.setHardCap(2)).toMatchObject({ capLevel: 2, reason: 'hard-cap' });
        expect(governor.setHardCap(4)).toBeNull();
        expect(governor.getState().hardCapLevel).toBe(2);
        governor.stop();

        expect(governor.observe(createSnapshot({ isEmergency: true, nowMs: 2_000 }))).toBeNull();
        expect(governor.getState().phase).toBe('stopped');
    });

    it('clamps a pending restore target to a later decoder hard cap', () => {
        const governor = createGovernor();
        governor.observe(createSnapshot({
            bufferSeconds: 2,
            currentLevel: 4,
            isEmergency: true,
            nativeEmergencyLevel: 0,
            nowMs: 2_000
        }));

        expect(governor.getState()).toMatchObject({ capLevel: 0, restoreCapLevel: 4 });
        expect(governor.setHardCap(2)).toBeNull();
        expect(governor.getState()).toMatchObject({ capLevel: 0, hardCapLevel: 2, restoreCapLevel: 2 });
    });
});
