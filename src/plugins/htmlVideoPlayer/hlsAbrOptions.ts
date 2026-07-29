interface HlsAbrPlatform {
    isIos: boolean;
    isSafari: boolean;
}

export function getHlsAbrPlatformOptions(platform: HlsAbrPlatform) {
    return {
        capLevelOnFPSDrop: !(platform.isIos || platform.isSafari),
        // WebKit can report playable HEVC MMS renditions as supported but not
        // smooth. hls.js treats that advisory result as a hard ABR exclusion.
        useMediaCapabilities: !platform.isIos
    };
}
