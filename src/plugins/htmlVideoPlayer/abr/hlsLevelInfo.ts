import type { Level } from 'hls.js';

const DEFAULT_TARGET_DURATION_SECONDS = 3;

type LevelLike = Pick<Level, 'bitrate' | 'details'> & Partial<Pick<Level,
    'attrs' | 'codecSet' | 'fragmentError' | 'frameRate' | 'loadError' | 'supportedResult' | 'videoRange'>>;

interface HlsWithLevels {
    levels?: LevelLike[] | null;
}

export function getHlsLevelBitrate(level: Partial<LevelLike> | null | undefined) {
    const bitrate = level?.bitrate || level?.attrs?.BANDWIDTH || level?.attrs?.['AVERAGE-BANDWIDTH'];
    return parseInt(String(bitrate ?? ''), 10) || 0;
}

export function getHlsLevelTargetDuration(hls: HlsWithLevels | null | undefined, levelIndex: number) {
    const details = hls?.levels?.[levelIndex]?.details;
    const targetDuration = details?.targetduration || details?.fragments?.[0]?.duration;

    return Number.isFinite(targetDuration) && (targetDuration as number) > 0 ?
        targetDuration as number :
        DEFAULT_TARGET_DURATION_SECONDS;
}

/**
 * Returns false for a level switch that must not happen during playback:
 * a change of codec or HDR type, or an up-switch to a level that failed,
 * has a lower frame rate, or that the browser cannot play smoothly.
 */
export function isHlsLevelSwitchAllowed(from: LevelLike | undefined, to: LevelLike | undefined, isUpSwitch: boolean) {
    if (!to) {
        return false;
    }
    if (!from) {
        return true;
    }

    if ((from.codecSet && to.codecSet && from.codecSet !== to.codecSet)
        || (from.videoRange && to.videoRange && from.videoRange !== to.videoRange)) {
        return false;
    }

    if (!isUpSwitch) {
        return true;
    }

    return !((to.loadError || 0) > 0
        || (to.fragmentError || 0) > 0
        || ((from.frameRate || 0) > 0 && (to.frameRate || 0) > 0 && (from.frameRate as number) > (to.frameRate as number))
        || to.supportedResult?.decodingInfoResults?.some(result => result.supported === false || result.smooth === false));
}
