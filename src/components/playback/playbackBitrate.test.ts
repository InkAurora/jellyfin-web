import { describe, expect, it } from 'vitest';

import { getPlaybackBitrateSeed, getRecentDetectedBitrate } from './playbackBitrate';

const NOW_MS = 10_000_000;
const ONE_HOUR_MS = 60 * 60 * 1_000;

describe('getRecentDetectedBitrate', () => {
    it('accepts a positive estimate through the cache boundary', () => {
        expect(getRecentDetectedBitrate({
            lastDetectedBitrate: 20_000_000,
            lastDetectedBitrateTime: NOW_MS - ONE_HOUR_MS
        }, NOW_MS)).toBe(20_000_000);
    });

    it('rejects stale, future, and invalid estimates', () => {
        expect(getRecentDetectedBitrate({
            lastDetectedBitrate: 20_000_000,
            lastDetectedBitrateTime: NOW_MS - ONE_HOUR_MS - 1
        }, NOW_MS)).toBeNull();
        expect(getRecentDetectedBitrate({
            lastDetectedBitrate: 20_000_000,
            lastDetectedBitrateTime: NOW_MS + 1
        }, NOW_MS)).toBeNull();
        expect(getRecentDetectedBitrate({
            lastDetectedBitrate: 0,
            lastDetectedBitrateTime: NOW_MS
        }, NOW_MS)).toBeNull();
    });
});

describe('getPlaybackBitrateSeed', () => {
    it('seeds adaptive auto playback only from a recent detected bitrate', () => {
        expect(getPlaybackBitrateSeed({
            apiClient: {
                lastDetectedBitrate: 20_000_000,
                lastDetectedBitrateTime: NOW_MS - 1_000
            },
            isAutomaticBitrateEnabled: true,
            maxBitrate: 120_000_000,
            nowMs: NOW_MS,
            supportsAdaptiveBitrate: true
        })).toEqual({ initialBandwidthEstimate: 20_000_000 });

        expect(getPlaybackBitrateSeed({
            apiClient: {
                lastDetectedBitrate: 20_000_000,
                lastDetectedBitrateTime: NOW_MS - ONE_HOUR_MS - 1
            },
            isAutomaticBitrateEnabled: true,
            maxBitrate: 120_000_000,
            nowMs: NOW_MS,
            supportsAdaptiveBitrate: true
        })).toEqual({});
    });

    it('uses the selected maximum for non-adaptive auto playback', () => {
        expect(getPlaybackBitrateSeed({
            isAutomaticBitrateEnabled: true,
            maxBitrate: 8_000_000,
            supportsAdaptiveBitrate: false
        })).toEqual({ initialBandwidthEstimate: 8_000_000 });
    });

    it('uses a hard maximum when automatic bitrate is disabled', () => {
        expect(getPlaybackBitrateSeed({
            isAutomaticBitrateEnabled: false,
            maxBitrate: 8_000_000,
            supportsAdaptiveBitrate: true
        })).toEqual({ initialMaxStreamingBitrate: 8_000_000 });
    });
});
