import { describe, expect, it } from 'vitest';

import { getHlsAbrPlatformOptions } from './hlsAbrOptions';

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
