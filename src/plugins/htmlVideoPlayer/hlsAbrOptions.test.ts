import { describe, expect, it } from 'vitest';

import {
    getHlsAbrGovernorSeed,
    getHlsAbrPlatformOptions,
    getHlsAdaptiveBufferOptions
} from './hlsAbrOptions';

describe('getHlsAbrPlatformOptions', () => {
    it('does not let unreliable iOS MediaCapabilities filter ABR levels', () => {
        const expectedOptions = {
            capLevelOnFPSDrop: false,
            useMediaCapabilities: false
        };

        expect(getHlsAbrPlatformOptions({
            isIos: true,
            isSafari: true
        })).toEqual(expectedOptions);

        expect(getHlsAbrPlatformOptions({
            isIos: true,
            isSafari: false
        })).toEqual(expectedOptions);
    });

    it('keeps MediaCapabilities enabled outside iOS', () => {
        expect(getHlsAbrPlatformOptions({
            isIos: false,
            isSafari: true
        })).toEqual({
            capLevelOnFPSDrop: false,
            useMediaCapabilities: true
        });

        expect(getHlsAbrPlatformOptions({
            isIos: false,
            isSafari: false
        })).toEqual({
            capLevelOnFPSDrop: true,
            useMediaCapabilities: true
        });
    });
});

describe('getHlsAdaptiveBufferOptions', () => {
    it('respects a smaller saved forward buffer', () => {
        expect(getHlsAdaptiveBufferOptions({
            isHighBitrateBrowser: false,
            maximumBitrate: 0,
            savedBufferLength: 12
        })).toMatchObject({
            backBufferLength: 12,
            maxBufferLength: 12,
            maxMaxBufferLength: 12
        });
    });

    it('keeps the high-bitrate browser safeguard', () => {
        expect(getHlsAdaptiveBufferOptions({
            isHighBitrateBrowser: true,
            maximumBitrate: 120_000_000,
            savedBufferLength: 0
        })).toEqual({
            backBufferLength: 6,
            liveBackBufferLength: 6,
            maxBufferLength: 6,
            maxBufferSize: 256 * 1024 * 1024,
            maxMaxBufferLength: 6
        });
    });

    it('bounds non-Chromium buffer time by a byte budget', () => {
        expect(getHlsAdaptiveBufferOptions({
            isHighBitrateBrowser: false,
            maximumBitrate: 120_000_000,
            savedBufferLength: 0
        })).toMatchObject({
            backBufferLength: 17,
            maxBufferLength: 17,
            maxMaxBufferLength: 17
        });
    });
});

describe('getHlsAbrGovernorSeed', () => {
    it('does not discount an already-safe detected bitrate again', () => {
        expect(getHlsAbrGovernorSeed({
            configuredSafeBitrate: 20_000_000,
            fallbackBitrate: 6_000_000
        })).toEqual({ initialBitrate: 20_000_000 });
    });

    it('prefers learned hls.js bandwidth when Auto is enabled during playback', () => {
        expect(getHlsAbrGovernorSeed({
            configuredSafeBitrate: 20_000_000,
            fallbackBitrate: 6_000_000,
            learnedBandwidthEstimate: 30_000_000
        })).toEqual({ initialBandwidthEstimate: 30_000_000 });
    });
});
