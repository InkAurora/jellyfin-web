interface HlsAbrPlatform {
    isIos: boolean;
    isSafari: boolean;
}

interface HlsAdaptiveBufferOptions {
    isHighBitrateBrowser: boolean;
    maximumBitrate: number;
    savedBufferLength: number;
}

interface HlsAbrGovernorSeedOptions {
    configuredSafeBitrate?: number;
    fallbackBitrate: number;
    learnedBandwidthEstimate?: number;
}

const DEFAULT_ADAPTIVE_BUFFER_SECONDS = 30;
const MAX_ADAPTIVE_BUFFER_SECONDS = 60;
const HIGH_BITRATE_BROWSER_BUFFER_SECONDS = 6;
const HIGH_BITRATE_BROWSER_THRESHOLD = 25_000_000;
const MAX_ADAPTIVE_FORWARD_BUFFER_BYTES = 256 * 1024 * 1024;

function isPositiveFinite(value: number | undefined): value is number {
    return Number.isFinite(value) && (value || 0) > 0;
}

export function getHlsAbrPlatformOptions(platform: HlsAbrPlatform) {
    return {
        capLevelOnFPSDrop: !(platform.isIos || platform.isSafari),
        // WebKit can report playable HEVC MMS renditions as supported but not
        // smooth. hls.js treats that advisory result as a hard ABR exclusion.
        useMediaCapabilities: !platform.isIos
    };
}

export function getHlsAdaptiveBufferOptions(options: HlsAdaptiveBufferOptions) {
    const requestedBufferLength = isPositiveFinite(options.savedBufferLength) ?
        options.savedBufferLength :
        DEFAULT_ADAPTIVE_BUFFER_SECONDS;
    let bufferLength = Math.min(requestedBufferLength, MAX_ADAPTIVE_BUFFER_SECONDS);

    if (isPositiveFinite(options.maximumBitrate)) {
        const byteBudgetSeconds = Math.max(
            Math.floor((MAX_ADAPTIVE_FORWARD_BUFFER_BYTES * 8) / options.maximumBitrate),
            1
        );
        bufferLength = Math.min(bufferLength, byteBudgetSeconds);

        if (options.isHighBitrateBrowser
            && options.maximumBitrate >= HIGH_BITRATE_BROWSER_THRESHOLD) {
            bufferLength = Math.min(bufferLength, HIGH_BITRATE_BROWSER_BUFFER_SECONDS);
        }
    }

    bufferLength = Math.max(bufferLength, 1);
    return {
        backBufferLength: bufferLength,
        liveBackBufferLength: bufferLength,
        maxBufferLength: bufferLength,
        maxBufferSize: MAX_ADAPTIVE_FORWARD_BUFFER_BYTES,
        maxMaxBufferLength: bufferLength
    };
}

export function getHlsAbrGovernorSeed(options: HlsAbrGovernorSeedOptions) {
    if (isPositiveFinite(options.learnedBandwidthEstimate)) {
        return { initialBandwidthEstimate: options.learnedBandwidthEstimate };
    }

    return {
        initialBitrate: isPositiveFinite(options.configuredSafeBitrate) ?
            options.configuredSafeBitrate :
            options.fallbackBitrate
    };
}
