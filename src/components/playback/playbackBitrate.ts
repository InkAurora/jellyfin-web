const DETECTED_BITRATE_CACHE_DURATION_MS = 60 * 60 * 1_000;

interface BitrateCache {
    lastDetectedBitrate?: unknown;
    lastDetectedBitrateTime?: unknown;
}

interface PlaybackBitrateSeedOptions {
    apiClient?: BitrateCache | null;
    isAutomaticBitrateEnabled: boolean;
    maxBitrate?: number | null;
    nowMs?: number;
    supportsAdaptiveBitrate?: boolean;
}

interface PlaybackBitrateSeed {
    initialBandwidthEstimate?: number | null;
    initialMaxStreamingBitrate?: number | null;
}

export function getRecentDetectedBitrate(apiClient?: BitrateCache | null, nowMs = Date.now()) {
    const bitrate = Number(apiClient?.lastDetectedBitrate);
    const detectedAt = Number(apiClient?.lastDetectedBitrateTime);
    const ageMs = nowMs - detectedAt;

    if (Number.isFinite(bitrate) && bitrate > 0
        && Number.isFinite(detectedAt) && detectedAt > 0
        && ageMs >= 0 && ageMs <= DETECTED_BITRATE_CACHE_DURATION_MS) {
        return bitrate;
    }

    return null;
}

export function getPlaybackBitrateSeed(options: PlaybackBitrateSeedOptions): PlaybackBitrateSeed {
    if (!options.isAutomaticBitrateEnabled) {
        return { initialMaxStreamingBitrate: options.maxBitrate };
    }

    if (!options.supportsAdaptiveBitrate) {
        return { initialBandwidthEstimate: options.maxBitrate };
    }

    const detectedBitrate = getRecentDetectedBitrate(options.apiClient, options.nowMs);
    return detectedBitrate ? { initialBandwidthEstimate: detectedBitrate } : {};
}
