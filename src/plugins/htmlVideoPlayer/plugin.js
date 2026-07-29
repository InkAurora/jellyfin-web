import DOMPurify from 'dompurify';
import debounce from 'lodash-es/debounce';
import Screenfull from 'screenfull';

import { useCustomSubtitles } from 'apps/stable/features/playback/utils/subtitleStyles';
import subtitleAppearanceHelper from 'components/subtitlesettings/subtitleappearancehelper';
import { AppFeature } from 'constants/appFeature';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { currentSettings as userSettings } from 'scripts/settings/userSettings';
import { MediaError } from 'types/mediaError';

import browser from '../../scripts/browser';
import appSettings from '../../scripts/settings/appSettings';
import { appHost } from '../../components/apphost';
import loading from '../../components/loading/loading';
import dom from '../../utils/dom';
import { playbackManager } from '../../components/playback/playbackmanager';
import { appRouter } from '../../components/router/appRouter';
import {
    bindEventsToHlsPlayer,
    destroyHlsPlayer,
    destroyFlvPlayer,
    destroyCastPlayer,
    getCrossOriginValue,
    enableHlsJsPlayer,
    enableHlsJsPlayerForCodecs,
    applySrc,
    resetSrc,
    playWithPromise,
    onEndedInternal,
    saveVolume,
    seekOnPlaybackStart,
    onErrorInternal,
    handleHlsJsMediaError,
    getSavedVolume,
    isValidDuration,
    getBufferedRanges
} from '../../components/htmlMediaHelper';
import itemHelper from '../../components/itemHelper';
import globalize from '../../lib/globalize';
import profileBuilder, { canPlaySecondaryAudio } from '../../scripts/browserDeviceProfile';
import { getIncludeCorsCredentials } from '../../scripts/settings/webSettings';
import { setBackdropTransparency, TRANSPARENCY_LEVEL } from '../../components/backdrop/backdrop';
import { PluginType } from '../../types/plugin.ts';
import Events from '../../utils/events.ts';
import { includesAny } from '../../utils/container.ts';
import { isHls } from '../../utils/mediaSource.ts';
import { HlsAbrGovernor } from './hlsAbrGovernor.ts';
import { getHlsAbrPlatformOptions } from './hlsAbrOptions.ts';

/**
 * Returns resolved URL.
 * @param {string} url - URL.
 * @returns {string} Resolved URL or `url` if resolving failed.
 */
function resolveUrl(url) {
    return new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('HEAD', url, true);
        xhr.onload = function () {
            resolve(xhr.responseURL || url);
        };
        xhr.onerror = function (e) {
            console.error(e);
            resolve(url);
        };
        xhr.send(null);
    });
}

function tryRemoveElement(elem) {
    const parentNode = elem.parentNode;
    if (parentNode) {
        // Seeing crashes in edge webview
        try {
            parentNode.removeChild(elem);
        } catch (err) {
            console.error(`error removing dialog element: ${err}`);
        }
    }
}

function isManualTextTrack(track) {
    return (track.label || '').includes('manualTrack');
}

function enableNativeTrackSupport(mediaSource, track) {
    if (track?.DeliveryMethod === 'Embed') {
        return true;
    }

    if (browser.firefox && isHls(mediaSource)) {
        return false;
    }

    if (browser.ps4) {
        return false;
    }

    if (browser.web0s) {
        return false;
    }

    // Edge is randomly not rendering subtitles
    if (browser.edge) {
        return false;
    }

    if (browser.iOS && (browser.iosVersion || 10) < 10) {
        // works in the browser but not the native app
        return false;
    }

    if (track) {
        const format = (track.Codec || '').toLowerCase();
        if (format === 'ssa' || format === 'ass' || format === 'pgssub') {
            return false;
        }
    }

    return true;
}

function isPgsTrack(track) {
    return (track?.Codec || '').toLowerCase() === 'pgssub';
}

function isClientRenderedPgsTrack(track) {
    const subtitleBurninSetting = appSettings.get('subtitleburnin');
    return isPgsTrack(track)
        && appSettings.get('subtitlerenderpgs') === 'true'
        && subtitleBurninSetting !== 'all'
        && subtitleBurninSetting !== 'allcomplexformats'
        && subtitleBurninSetting !== 'onlyimageformats';
}

function requireHlsPlayer() {
    return import('hls.js/dist/hls.js').then(({ default: hls }) => {
        hls.DefaultConfig.lowLatencyMode = false;
        hls.DefaultConfig.backBufferLength = Infinity;
        hls.DefaultConfig.liveBackBufferLength = 90;
        window.Hls = hls;
    });
}

function getHlsLevelBitrate(level) {
    const bitrate = level?.bitrate || level?.attrs?.BANDWIDTH || level?.attrs?.AVERAGE_BANDWIDTH;
    return parseInt(bitrate, 10) || 0;
}

function getCurrentHlsLevelBitrate(hls) {
    const level = [hls.currentLevel, hls.loadLevel, hls.nextAutoLevel, hls.firstLevel]
        .find(levelIndex => levelIndex != null && levelIndex > -1);

    return getHlsLevelBitrate(hls.levels[level]) || null;
}

function canApplyHlsAbrProbe(hls, probeLevel, activeLevel) {
    if (!hls.autoLevelEnabled
        || !Number.isInteger(probeLevel)
        || probeLevel < 0
        || probeLevel > hls.maxAutoLevel) {
        return false;
    }

    const currentLevel = [activeLevel, hls.currentLevel, hls.firstLevel, 0]
        .find(level => Number.isInteger(level) && level >= 0);
    const current = hls.levels[currentLevel];
    const target = hls.levels[probeLevel];
    if (!target || probeLevel <= currentLevel || target.loadError > 0 || target.fragmentError > 0) {
        return false;
    }

    if ((current?.codecSet && target.codecSet && current.codecSet !== target.codecSet)
        || (current?.videoRange && target.videoRange && current.videoRange !== target.videoRange)
        || (current?.frameRate > 0 && target.frameRate > 0 && current.frameRate > target.frameRate)
        || target.supportedResult?.decodingInfoResults?.some(result => result.supported === false || result.smooth === false)) {
        return false;
    }

    return true;
}

function getManualHlsLevelForBitrate(levels, maxBitrate) {
    let selectedIndex = -1;
    let selectedBitrate = 0;
    let lowestIndex = -1;
    let lowestBitrate = Number.MAX_SAFE_INTEGER;
    let highestIndex = -1;
    let highestBitrate = 0;

    for (let i = 0, length = levels.length; i < length; i++) {
        const bitrate = getHlsLevelBitrate(levels[i]);
        if (!bitrate) {
            continue;
        }

        if (bitrate > highestBitrate) {
            highestBitrate = bitrate;
            highestIndex = i;
        }

        if (bitrate < lowestBitrate) {
            lowestBitrate = bitrate;
            lowestIndex = i;
        }

        if (bitrate <= maxBitrate && bitrate > selectedBitrate) {
            selectedBitrate = bitrate;
            selectedIndex = i;
        }
    }

    if (!highestBitrate) {
        return -1;
    }

    if (maxBitrate > highestBitrate) {
        return highestIndex;
    }

    if (maxBitrate < lowestBitrate) {
        return lowestIndex;
    }

    return selectedIndex === -1 ? lowestIndex : selectedIndex;
}

const CUSTOM_HLS_BACK_BUFFER_LENGTH = 120;
const CUSTOM_ABR_HLS_MAX_BUFFER_LENGTH = 60;
const CUSTOM_ABR_HLS_MAX_BUFFER_SIZE = 1024 * 1024 * 1024;
const MIN_HLS_BANDWIDTH_ESTIMATE = 500000;
const CUSTOM_AUTO_INITIAL_BITRATE = 6000000;
const HLS_ABR_GOVERNOR_TICK_MS = 2000;
const HLS_ABR_SEEK_GRACE_MS = 10000;

function getHlsAbrOptions(options) {
    if (!options.adaptiveBitrateStreaming) {
        return {};
    }

    const initialBandwidthEstimate = parseInt(options.initialBandwidthEstimate, 10);
    const abrOptions = {
        autoStartLoad: false,
        ...getHlsAbrPlatformOptions({
            isIos: browser.iOS,
            isSafari: browser.safari
        }),
        testBandwidth: false,
        startLevel: -1
    };

    if (browser.iOS || browser.safari) {
        Object.assign(abrOptions, {
            abrEwmaFastVoD: 1.5,
            abrEwmaSlowVoD: 3,
            abrBandWidthUpFactor: 0.85,
            maxStarvationDelay: 8,
            maxLoadingDelay: 8
        });
    }

    const startupBandwidthEstimate = Number.isFinite(initialBandwidthEstimate) && initialBandwidthEstimate > 0 ?
        initialBandwidthEstimate :
        CUSTOM_AUTO_INITIAL_BITRATE;
    const bandwidthEstimate = Math.max(startupBandwidthEstimate, MIN_HLS_BANDWIDTH_ESTIMATE);
    abrOptions.abrEwmaDefaultEstimate = bandwidthEstimate;
    abrOptions.abrEwmaDefaultEstimateMax = Math.max(bandwidthEstimate, Hls.DefaultConfig.abrEwmaDefaultEstimateMax);

    return abrOptions;
}

function getHlsBufferOptions(player, options) {
    const savedBufferLength = userSettings.hlsForwardBufferLength();
    if (savedBufferLength > 0) {
        const bufferLength = options.adaptiveBitrateStreaming ? Math.max(savedBufferLength, CUSTOM_ABR_HLS_MAX_BUFFER_LENGTH) : savedBufferLength;

        return {
            maxBufferLength: bufferLength,
            maxMaxBufferLength: bufferLength,
            ...(options.adaptiveBitrateStreaming ? { maxBufferSize: CUSTOM_ABR_HLS_MAX_BUFFER_SIZE } : {}),
            backBufferLength: CUSTOM_HLS_BACK_BUFFER_LENGTH,
            liveBackBufferLength: CUSTOM_HLS_BACK_BUFFER_LENGTH
        };
    }

    if (options.adaptiveBitrateStreaming) {
        return {
            maxBufferLength: CUSTOM_ABR_HLS_MAX_BUFFER_LENGTH,
            maxMaxBufferLength: CUSTOM_ABR_HLS_MAX_BUFFER_LENGTH,
            maxBufferSize: CUSTOM_ABR_HLS_MAX_BUFFER_SIZE,
            backBufferLength: CUSTOM_HLS_BACK_BUFFER_LENGTH,
            liveBackBufferLength: CUSTOM_HLS_BACK_BUFFER_LENGTH
        };
    }

    // Some browsers cannot handle huge fragments in high bitrate.
    // This issue usually happens when using HWA encoders with a high bitrate setting.
    // Limit the BufferLength to 6s, it works fine when playing 4k 120Mbps over HLS on chrome.
    // https://github.com/video-dev/hls.js/issues/876
    if ((browser.chrome || browser.edgeChromium || browser.firefox) && playbackManager.getMaxStreamingBitrate(player) >= 25000000) {
        return {
            maxBufferLength: 6,
            maxMaxBufferLength: 6
        };
    }

    return {
        maxBufferLength: 30,
        maxMaxBufferLength: 30
    };
}

function useHlsAbrGovernor(options) {
    return options.adaptiveBitrateStreaming;
}

function getBufferedAhead(mediaElement) {
    if (!mediaElement) {
        return 0;
    }

    const currentTime = mediaElement.currentTime || 0;
    const buffered = mediaElement.buffered;

    for (let i = 0, length = buffered.length; i < length; i++) {
        if (buffered.start(i) <= currentTime && buffered.end(i) >= currentTime) {
            return buffered.end(i) - currentTime;
        }
    }

    return 0;
}

function getHlsBufferedAhead(hls, mediaElement) {
    const hlsBufferLength = hls?.mainForwardBufferInfo?.len;
    if (Number.isFinite(hlsBufferLength)) {
        return hlsBufferLength;
    }

    return getBufferedAhead(mediaElement);
}

function getHlsLevelTargetDuration(hls, levelIndex) {
    const details = hls?.levels?.[levelIndex]?.details;
    const targetDuration = details?.targetduration || details?.fragments?.[0]?.duration;

    return Number.isFinite(targetDuration) && targetDuration > 0 ? targetDuration : 3;
}

function getHlsForwardBufferCap(hls) {
    const cap = hls?.config?.maxMaxBufferLength || hls?.config?.maxBufferLength || 0;
    return Number.isFinite(cap) && cap > 0 ? cap : 0;
}

function getHlsFragmentRuntimeOffset(frag) {
    const url = frag?.url || frag?.relurl;
    const start = frag?.start;

    if (!url || !Number.isFinite(start)) {
        return null;
    }

    try {
        const runtimeTicks = new URL(url, window.location.href).searchParams.get('runtimeTicks');
        if (runtimeTicks == null) {
            return null;
        }

        const runtimeSeconds = Number(runtimeTicks) / 10000000;
        return Number.isFinite(runtimeSeconds) ? runtimeSeconds - start : null;
    } catch {
        return null;
    }
}

function getMediaStreamVideoTracks(mediaSource) {
    return mediaSource.MediaStreams.filter(function (s) {
        return s.Type === 'Video';
    });
}

function getMediaStreamAudioTracks(mediaSource) {
    return mediaSource.MediaStreams.filter(function (s) {
        return s.Type === 'Audio';
    });
}

function getMediaStreamTextTracks(mediaSource) {
    return mediaSource.MediaStreams.filter(function (s) {
        return s.Type === 'Subtitle';
    });
}

function zoomIn(elem) {
    return new Promise(resolve => {
        const duration = 240;
        elem.style.animation = `htmlvideoplayer-zoomin ${duration}ms ease-in normal`;
        dom.addEventListener(elem, dom.whichAnimationEvent(), resolve, {
            once: true
        });
    });
}

function normalizeTrackEventText(text, useHtml) {
    const result = text
        .replace(/\\N/gi, '\n') // Correct newline characters
        .replace(/\r/gi, '') // Remove carriage return characters
        .replace(/{\\.*?}/gi, '') // Remove ass/ssa tags
        // Force LTR as the default direction
        .split('\n').map(val => `\u200E${val}`).join('\n');
    return useHtml ? result.replace(/\n/gi, '<br>') : result;
}

function getTextTrackUrl(track, item, format) {
    if (itemHelper.isLocalItem(item) && track.Path) {
        return track.Path;
    }

    let url = playbackManager.getSubtitleUrl(track, item.ServerId);
    if (format) {
        url = url.replace('.vtt', format);
    }

    return url;
}

function getPgsTrackUrl(track, item, mediaSource, startPositionTicks) {
    const apiClient = ServerConnections.getApiClient(item.ServerId);
    return apiClient.getUrl(`Videos/${item.Id}/${mediaSource.Id}/Subtitles/${track.Index}/${startPositionTicks || 0}/Stream.pgssub`, {
        ApiKey: apiClient.accessToken(),
        CacheBust: Date.now()
    });
}

function getDefaultProfile() {
    return profileBuilder({});
}

const PRIMARY_TEXT_TRACK_INDEX = 0;
const SECONDARY_TEXT_TRACK_INDEX = 1;
const PGS_CANVAS_CLASS = 'pgsSubtitlesCanvas';

export class HtmlVideoPlayer {
    /**
     * @type {string}
     */
    name;
    /**
     * @type {string}
     */
    type = PluginType.MediaPlayer;
    /**
     * @type {string}
     */
    id = 'htmlvideoplayer';
    /**
     * Let any players created by plugins take priority
     *
     * @type {number}
     */
    priority = 1;
    /**
     * @type {boolean}
     */
    isFetching = false;
    /**
     * @type {HTMLDivElement | null | undefined}
     */
    #videoDialog;
    /**
     * @type {number | undefined}
     */
    #subtitleTrackIndexToSetOnPlaying;
    /**
     * @type {number | undefined}
     */
    #secondarySubtitleTrackIndexToSetOnPlaying;
    /**
     * @type {number | null}
     */
    #audioTrackIndexToSetOnPlaying;
    /**
     * @type {any | null | undefined}
     */
    #currentAssRenderer;
    /**
     * @type {any | null | undefined}
     */
    #currentPgsRenderer;
    /**
     * @type {number | undefined}
     */
    #customTrackIndex;
    /**
     * @type {number | undefined}
     */
    #customSecondaryTrackIndex;
    /**
     * @type {boolean | undefined}
     */
    #showTrackOffset;
    /**
     * @type {number | undefined}
     */
    #currentTrackOffset;
    /**
     * @type {HTMLElement | null | undefined}
     */
    #secondaryTrackOffset;
    /**
     * @type {HTMLElement | null | undefined}
     */
    #videoSubtitlesElem;
    /**
     * @type {HTMLElement | null | undefined}
     */
    #videoSecondarySubtitlesElem;
    /**
     * @type {any | null | undefined}
     */
    #currentTrackEvents;
    /**
     * @type {any | null | undefined}
     */
    #currentSecondaryTrackEvents;
    /**
     * @type {string[] | undefined}
     */
    #supportedFeatures;
    /**
     * @type {HTMLVideoElement | null | undefined}
     */
    #mediaElement;
    /**
     * @type {number}
     */
    #fetchQueue = 0;
    /**
     * @type {string | undefined}
     */
    #currentSrc;
    /**
     * @type {boolean | undefined}
     */
    #started;
    /**
     * @type {boolean | undefined}
     */
    #timeUpdated;
    /**
     * @type {number | null | undefined}
     */
    #currentTime;

    /**
     * @private (used in other files)
     * @type {any | undefined}
     */
    _flvPlayer;

    /**
     * @private (used in other files)
     * @type {any | undefined}
     */
    _hlsPlayer;
    /**
     * @type {HlsAbrGovernor | undefined}
     */
    _hlsAbrGovernor;
    /**
     * @type {number | undefined}
     */
    _hlsAbrGovernorTimer;
    /**
     * @type {WeakSet<object> | undefined}
     */
    _hlsAbrLoadTokens;
    /**
     * @type {Map<object, { failedLevel: number, nativeEmergencyLevel?: number, stats: any }> | undefined}
     */
    _hlsAbrPendingEmergencies;
    /**
     * @type {boolean | undefined}
     */
    _hlsAbrSeeking;
    /**
     * @type {number | undefined}
     */
    _hlsAbrSeekGraceUntil;
    /**
     * @type {number}
     */
    _hlsSourceGeneration = 0;
    /**
     * @type {number | undefined}
     */
    _activeSourceGeneration;
    /**
     * @type {number | undefined}
     */
    _hlsRuntimeTimeOffset;
    /**
     * @private (used in other files)
     * @type {any | null | undefined}
     */
    _castPlayer;
    /**
     * @private (used in other files)
     * @type {any | undefined}
     */
    _currentPlayOptions;
    /**
     * @type {any | undefined}
     */
    #lastProfile;

    constructor() {
        if (browser.edgeUwp) {
            this.name = 'Windows Video Player';
        } else {
            this.name = 'Html Video Player';
        }
    }

    currentSrc() {
        return this.#currentSrc;
    }

    /**
     * @private
     */
    stopHlsAbrGovernor() {
        const capLevel = this._hlsAbrGovernor?.getState().capLevel;
        this.cancelPendingHlsAbrProbe(capLevel);
        if (this._hlsAbrGovernor) {
            this._hlsAbrGovernor.stop();
            this._hlsAbrGovernor = undefined;

            if (this._hlsPlayer) {
                this._hlsPlayer.autoLevelCapping = -1;
            }
        }

        if (this._hlsAbrGovernorTimer) {
            clearInterval(this._hlsAbrGovernorTimer);
            this._hlsAbrGovernorTimer = undefined;
        }

        this._hlsAbrLoadTokens = undefined;
        this._hlsAbrPendingEmergencies?.clear();
        this._hlsAbrPendingEmergencies = undefined;
        this._hlsAbrActiveLoadToken = undefined;
        this._hlsAbrActiveMainLevel = undefined;
        this._hlsAbrBufferFullCount = undefined;
        this._hlsAbrPendingProbeLevel = undefined;
        this._hlsAbrSeeking = undefined;
        this._hlsAbrSeekGraceUntil = undefined;
    }

    /**
     * @private
     */
    cancelPendingHlsAbrProbe(maximumLevel) {
        const pendingLevel = this._hlsAbrPendingProbeLevel;
        const hls = this._hlsPlayer;
        if (!Number.isInteger(pendingLevel) || !hls?.levels?.length) {
            this._hlsAbrPendingProbeLevel = undefined;
            return;
        }

        const state = this._hlsAbrGovernor?.getState();
        const safeMaximum = Number.isInteger(maximumLevel) ? maximumLevel : state?.capLevel;
        const fallbackLevel = [this._hlsAbrActiveMainLevel, state?.lastLoadedLevel, hls.currentLevel, 0]
            .find(level => Number.isInteger(level) && level >= 0 && level <= safeMaximum);
        hls.nextAutoLevel = Number.isInteger(fallbackLevel) ? fallbackLevel : Math.max(safeMaximum || 0, 0);
        this._hlsAbrPendingProbeLevel = undefined;
    }

    /**
     * @private
     */
    resetHlsAbrGovernorForSeek(nowMs) {
        const governor = this._hlsAbrGovernor;
        const decision = governor?.resetForSeek(nowMs);
        this.cancelPendingHlsAbrProbe(decision?.capLevel ?? governor?.getState().capLevel);
        this.applyHlsAbrDecision(decision);
    }

    /**
     * @private
     */
    getPlaybackRuntimeTimeOffset() {
        return this._hlsRuntimeTimeOffset ?? ((this._currentPlayOptions?.transcodingOffsetTicks || 0) / 10000000);
    }

    /**
     * @private
     */
    getPgsSubtitleTimeOffset() {
        return this.getPlaybackRuntimeTimeOffset() + (this.#currentTrackOffset || 0);
    }

    /**
     * @private
     */
    updateHlsRuntimeTimeOffset(frag) {
        const offset = getHlsFragmentRuntimeOffset(frag);
        if (offset == null) {
            return;
        }

        if (this._hlsRuntimeTimeOffset == null || Math.abs(this._hlsRuntimeTimeOffset - offset) > 0.001) {
            this._hlsRuntimeTimeOffset = offset;
            if (this.#currentPgsRenderer) {
                this.#currentPgsRenderer.timeOffset = this.getPgsSubtitleTimeOffset();
            }
            console.warn(`[PGS] hls runtime offset: ${offset.toFixed(3)}s`);
        }
    }

    /**
     * @private
     * @param {number} [bandwidthEstimate]
     */
    startHlsAbrGovernor(bandwidthEstimate) {
        const hls = this._hlsPlayer;
        if (!hls?.levels?.length || hls.levels.length < 2) {
            return false;
        }

        this.stopHlsAbrGovernor();

        const nowMs = performance.now();
        const configuredBandwidthEstimate = Number.parseInt(this._currentPlayOptions?.initialBandwidthEstimate, 10);
        const initialBandwidthEstimate = Number.isFinite(bandwidthEstimate) && bandwidthEstimate > 0 ?
            bandwidthEstimate :
            configuredBandwidthEstimate;
        const governor = new HlsAbrGovernor({
            levels: hls.levels.map((level, index) => ({
                index,
                bitrate: getHlsLevelBitrate(level)
            })),
            nowMs,
            initialBandwidthEstimate: Number.isFinite(initialBandwidthEstimate) && initialBandwidthEstimate > 0 ?
                initialBandwidthEstimate :
                undefined,
            initialBitrate: CUSTOM_AUTO_INITIAL_BITRATE,
            configuredBufferCapSeconds: getHlsForwardBufferCap(hls)
        });

        if (!governor.hasMultipleLevels) {
            return false;
        }

        this._hlsAbrGovernor = governor;
        this._hlsAbrLoadTokens = new WeakSet();
        this._hlsAbrPendingEmergencies = new Map();
        this._hlsAbrActiveLoadToken = undefined;
        this._hlsAbrActiveMainLevel = undefined;
        this._hlsAbrBufferFullCount = 0;
        this._hlsAbrPendingProbeLevel = undefined;
        this._hlsAbrSeeking = false;
        this._hlsAbrSeekGraceUntil = undefined;
        hls.startLevel = -1;
        hls.loadLevel = -1;
        hls.autoLevelCapping = governor.initialCapLevel;

        this._hlsAbrGovernorTimer = setInterval(() => {
            this.flushPendingHlsAbrEmergencies();
            this.updateHlsAbrGovernor();
        }, HLS_ABR_GOVERNOR_TICK_MS);

        this.updateHlsAbrGovernor();
        return true;
    }

    /**
     * @private
     */
    recordHlsAbrFragment(data) {
        const governor = this._hlsAbrGovernor;
        if (!governor) {
            return;
        }

        const frag = data?.frag;
        const stats = data?.part?.stats || data?.stats || frag?.stats;
        const loadingStats = stats?.loading;
        const level = Number(frag?.level ?? -1);
        const durationSeconds = Number(
            data?.part?.duration
            ?? frag?.duration
            ?? getHlsLevelTargetDuration(this._hlsPlayer, level)
        );

        governor.recordFragment({
            aborted: Boolean(stats?.aborted),
            durationSeconds,
            isInitSegment: frag?.sn === 'initSegment',
            isMain: frag?.type === 'main',
            level,
            loadedBytes: Number(stats?.loaded ?? stats?.total ?? data?.payload?.byteLength ?? 0),
            loadingEndMs: Number(loadingStats?.end ?? 0),
            loadingFirstMs: Number(loadingStats?.first ?? 0),
            loadingStartMs: Number(loadingStats?.start ?? 0),
            nowMs: performance.now()
        });
    }

    /**
     * @private
     */
    flushPendingHlsAbrEmergencies() {
        for (const [loadToken, emergency] of this._hlsAbrPendingEmergencies || []) {
            if (emergency.stats?.aborted) {
                this.handleHlsAbrEmergency(loadToken, emergency);
            } else if (emergency.stats?.loading?.end > 0) {
                this._hlsAbrPendingEmergencies?.delete(loadToken);
            }
        }
    }

    /**
     * @private
     */
    handleHlsAbrEmergency(loadToken, emergency) {
        this._hlsAbrPendingEmergencies?.delete(loadToken);
        if (!this._hlsAbrLoadTokens?.has(loadToken)) {
            return;
        }

        this._hlsAbrLoadTokens.delete(loadToken);
        const hls = this._hlsPlayer;
        const latestEmergencyLevel = hls?.nextAutoLevel;
        const nativeEmergencyLevel = Number.isInteger(latestEmergencyLevel)
            && latestEmergencyLevel >= 0
            && latestEmergencyLevel < emergency.failedLevel ?
            Math.min(latestEmergencyLevel, emergency.nativeEmergencyLevel ?? latestEmergencyLevel) :
            emergency.nativeEmergencyLevel;
        this.updateHlsAbrGovernor({
            currentLevel: emergency.failedLevel,
            isEmergency: true,
            nativeEmergencyLevel
        });
    }

    /**
     * @private
     * @param {{ currentLevel?: number, isEmergency?: boolean, isWaiting?: boolean, nativeEmergencyLevel?: number }} [flags]
     */
    updateHlsAbrGovernor(flags = {}) {
        const governor = this._hlsAbrGovernor;
        const hls = this._hlsPlayer;
        const elem = this.#mediaElement;
        if (!governor || !hls?.levels?.length || !elem) {
            return;
        }

        const selectedLevel = [
            flags.currentLevel,
            hls.loadLevel,
            hls.nextAutoLevel,
            hls.currentLevel,
            hls.firstLevel,
            0
        ].find(level => Number.isInteger(level) && level >= 0);
        const currentLevel = Math.min(selectedLevel, hls.levels.length - 1);
        const nowMs = performance.now();
        const decision = governor.observe({
            bufferSeconds: getHlsBufferedAhead(hls, elem),
            configuredBufferCapSeconds: getHlsForwardBufferCap(hls),
            currentLevel,
            hlsBandwidthEstimate: hls.bandwidthEstimate,
            isEmergency: Boolean(flags.isEmergency),
            isEnded: elem.ended,
            isLive: Boolean(hls.levels[currentLevel]?.details?.live || hls.latestLevelDetails?.live),
            isPaused: elem.paused,
            isSeeking: elem.seeking
                || this._hlsAbrSeeking
                || (this._hlsAbrSeekGraceUntil != null && nowMs < this._hlsAbrSeekGraceUntil),
            isWaiting: Boolean(flags.isWaiting),
            nativeEmergencyLevel: flags.nativeEmergencyLevel,
            nowMs,
            playbackRate: elem.playbackRate,
            segmentDurationSeconds: getHlsLevelTargetDuration(hls, currentLevel)
        });

        this.applyHlsAbrDecision(decision);
    }

    /**
     * @private
     */
    applyHlsAbrDecision(decision) {
        const hls = this._hlsPlayer;
        if (!decision || !hls?.levels?.length) {
            return;
        }

        const maximumLevel = hls.levels.length - 1;
        const requestedProbeLevel = decision.probeLevel;
        const governorState = this._hlsAbrGovernor?.getState();
        const governorStillExpectsPendingProbe = governorState?.probationProbePending
            && governorState.probationLevel === this._hlsAbrPendingProbeLevel;
        if (Number.isInteger(this._hlsAbrPendingProbeLevel)
            && requestedProbeLevel !== this._hlsAbrPendingProbeLevel
            && !governorStillExpectsPendingProbe) {
            this.cancelPendingHlsAbrProbe(decision.capLevel);
        }

        let effectiveDecision = decision;
        let capLevel = Math.min(Math.max(effectiveDecision.capLevel, 0), maximumLevel);
        hls.autoLevelCapping = capLevel;
        let appliedProbeLevel;

        if (effectiveDecision.forceLevel != null) {
            const forceLevel = Math.min(Math.max(effectiveDecision.forceLevel, 0), capLevel);
            hls.nextAutoLevel = forceLevel;
            hls.nextLoadLevel = forceLevel;
        }

        if (effectiveDecision.probeLevel != null) {
            const probeLevel = Math.min(Math.max(effectiveDecision.probeLevel, 0), capLevel);
            const state = this._hlsAbrGovernor?.getState();
            const activeLevel = Number.isInteger(this._hlsAbrActiveMainLevel) ?
                this._hlsAbrActiveMainLevel :
                state?.lastLoadedLevel;
            if (Number.isInteger(activeLevel)
                && activeLevel >= probeLevel
                && this._hlsAbrGovernor?.confirmProbe(activeLevel)) {
                appliedProbeLevel = activeLevel;
            } else if (canApplyHlsAbrProbe(hls, probeLevel, activeLevel)) {
                hls.nextAutoLevel = probeLevel;
                this._hlsAbrPendingProbeLevel = probeLevel;
                appliedProbeLevel = probeLevel;
            } else {
                const rejectedDecision = this._hlsAbrGovernor?.rejectProbe(
                    probeLevel,
                    performance.now()
                );
                if (rejectedDecision) {
                    effectiveDecision = rejectedDecision;
                    capLevel = Math.min(Math.max(effectiveDecision.capLevel, 0), maximumLevel);
                    hls.autoLevelCapping = capLevel;
                }
            }
        }

        console.debug(`hls abr governor: reason=${effectiveDecision.reason} phase=${effectiveDecision.phase} cap=${capLevel} force=${effectiveDecision.forceLevel ?? 'none'} probe=${requestedProbeLevel ?? 'none'} appliedProbe=${appliedProbeLevel ?? 'none'}`);
    }

    /**
     * @private
     */
    setHlsAbrHardCap(level) {
        if (!Number.isInteger(level) || level < 0) {
            return;
        }

        const decision = this._hlsAbrGovernor?.setHardCap(level);
        this.applyHlsAbrDecision(decision);
    }

    /**
     * @private
     */
    incrementFetchQueue() {
        if (this.#fetchQueue <= 0) {
            this.isFetching = true;
            Events.trigger(this, 'beginFetch');
        }

        this.#fetchQueue++;
    }

    /**
     * @private
     */
    decrementFetchQueue() {
        this.#fetchQueue--;

        if (this.#fetchQueue <= 0) {
            this.isFetching = false;
            Events.trigger(this, 'endFetch');
        }
    }

    /**
     * @private
     */
    updateVideoUrl(streamInfo, sourceGeneration) {
        const mediaSource = streamInfo.mediaSource;
        const item = streamInfo.item;

        // Huge hack alert. Safari doesn't seem to like if the segments aren't available right away when playback starts
        // This will start the transcoding process before actually feeding the video url into the player
        // Edit: Also seeing stalls from hls.js
        if (mediaSource && item && !mediaSource.RunTimeTicks && isHls(mediaSource) && streamInfo.playMethod === 'Transcode' && (browser.iOS || browser.osx)) {
            const hlsPlaylistUrl = streamInfo.url.replace('master.m3u8', 'live.m3u8');

            loading.show();

            console.debug(`prefetching hls playlist: ${hlsPlaylistUrl}`);

            return ServerConnections.getApiClient(item.ServerId).ajax({

                type: 'GET',
                url: hlsPlaylistUrl

            }).then(() => {
                if (sourceGeneration !== this._hlsSourceGeneration) {
                    return;
                }

                console.debug(`completed prefetching hls playlist: ${hlsPlaylistUrl}`);

                loading.hide();
                streamInfo.url = hlsPlaylistUrl;
            }, () => {
                if (sourceGeneration !== this._hlsSourceGeneration) {
                    return;
                }

                console.error(`error prefetching hls playlist: ${hlsPlaylistUrl}`);

                loading.hide();
            });
        } else {
            return Promise.resolve();
        }
    }

    async play(options) {
        const sourceGeneration = ++this._hlsSourceGeneration;
        this.#started = false;
        this.#timeUpdated = false;

        this.#currentTime = null;

        if (options.resetSubtitleOffset !== false) this.resetSubtitleOffset();

        let elem;
        try {
            elem = await this.createMediaElement(options, sourceGeneration);
        } catch (error) {
            if (sourceGeneration !== this._hlsSourceGeneration) {
                return;
            }
            throw error;
        }
        if (sourceGeneration !== this._hlsSourceGeneration) {
            return;
        }

        this.#applyAspectRatio(options.aspectRatio || this.getAspectRatio());

        try {
            await this.updateVideoUrl(options, sourceGeneration);
        } catch (error) {
            if (sourceGeneration !== this._hlsSourceGeneration) {
                return;
            }
            throw error;
        }
        if (sourceGeneration !== this._hlsSourceGeneration) {
            return;
        }

        return this.setCurrentSrc(elem, options, sourceGeneration);
    }

    /**
     * @private
     */
    setSrcWithFlvJs(elem, options, url, sourceGeneration) {
        return import('flv.js').then(({ default: flvjs }) => {
            if (sourceGeneration !== this._hlsSourceGeneration) {
                return;
            }

            const flvPlayer = flvjs.createPlayer({
                type: 'flv',
                url: url
            },
            {
                seekType: 'range',
                lazyLoad: false
            });

            this._activeSourceGeneration = sourceGeneration;
            flvPlayer.attachMediaElement(elem);
            flvPlayer.load();

            this._flvPlayer = flvPlayer;

            // This is needed in setCurrentTrackElement
            this.#currentSrc = url;

            return flvPlayer.play();
        }).catch(error => {
            if (sourceGeneration !== this._hlsSourceGeneration) {
                return;
            }
            throw error;
        });
    }

    /**
     * @private
     */
    setSrcWithHlsJs(elem, options, url, sourceGeneration) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const resolvePlayback = (value) => {
                if (!settled) {
                    settled = true;
                    resolve(value);
                }
            };
            const rejectPlayback = (reason) => {
                if (sourceGeneration !== this._hlsSourceGeneration) {
                    resolvePlayback();
                    return;
                }

                if (!settled) {
                    settled = true;
                    reject(reason);
                }
            };

            requireHlsPlayer().then(async () => {
                if (sourceGeneration !== this._hlsSourceGeneration) {
                    resolvePlayback();
                    return;
                }

                const hlsBufferOptions = getHlsBufferOptions(this, options);

                const includeCorsCredentials = await getIncludeCorsCredentials();
                if (sourceGeneration !== this._hlsSourceGeneration) {
                    resolvePlayback();
                    return;
                }

                const startPosition = (options.playerStartPositionTicks || 0) / 10000000;

                const hls = new Hls({
                    startPosition,
                    manifestLoadingTimeOut: 20000,
                    preserveManualLevelOnError: true,
                    ...getHlsAbrOptions(options),
                    ...hlsBufferOptions,
                    videoPreference: { preferHDR: true },
                    xhrSetup(xhr) {
                        xhr.withCredentials = includeCorsCredentials;
                    }
                });

                this._hlsPlayer = hls;
                const isCurrentHls = () => sourceGeneration === this._hlsSourceGeneration
                    && this._hlsPlayer === hls;
                let sourceRequested = false;
                let loadStarted = false;

                const startHlsLoad = () => {
                    if (loadStarted || !options.adaptiveBitrateStreaming) {
                        return;
                    }

                    loadStarted = true;
                    hls.startLoad(startPosition);
                };

                hls.on(Hls.Events.MEDIA_ATTACHED, () => {
                    if (!sourceRequested && isCurrentHls()) {
                        sourceRequested = true;
                        hls.loadSource(url);
                    }
                });

                hls.on(Hls.Events.MANIFEST_PARSED, () => {
                    if (!isCurrentHls()) {
                        return;
                    }

                    if (options.initialMaxStreamingBitrate) {
                        const level = getManualHlsLevelForBitrate(hls.levels, options.initialMaxStreamingBitrate);
                        if (level !== -1) {
                            this.stopHlsAbrGovernor();
                            hls.startLevel = level;
                            hls.loadLevel = level;
                        }
                    } else if (useHlsAbrGovernor(options)) {
                        if (!this.startHlsAbrGovernor()) {
                            hls.startLevel = -1;
                            hls.loadLevel = -1;
                        }
                    }

                    startHlsLoad();
                });

                hls.on(Hls.Events.FRAG_LOADING, (event, data) => {
                    const loadToken = data.part || data.frag;
                    if (isCurrentHls() && this._hlsAbrGovernor && loadToken) {
                        this.flushPendingHlsAbrEmergencies();
                        this._hlsAbrLoadTokens?.add(loadToken);
                        if (data.frag?.type === 'main' && data.frag?.sn !== 'initSegment') {
                            const level = Number(data.frag.level);
                            this._hlsAbrActiveLoadToken = loadToken;
                            this._hlsAbrActiveMainLevel = level;
                            if (level === this._hlsAbrPendingProbeLevel
                                && this._hlsAbrGovernor.confirmProbe(level)) {
                                this._hlsAbrPendingProbeLevel = undefined;
                            }
                        }
                    }
                });
                hls.on(Hls.Events.FRAG_LOADED, (event, data) => {
                    const loadToken = data.part || data.frag;
                    if (isCurrentHls() && loadToken) {
                        this._hlsAbrPendingEmergencies?.delete(loadToken);
                        if (loadToken === this._hlsAbrActiveLoadToken) {
                            this._hlsAbrActiveLoadToken = undefined;
                            this._hlsAbrActiveMainLevel = undefined;
                        }
                    }
                });
                hls.on(Hls.Events.FRAG_BUFFERED, (event, data) => {
                    const loadToken = data.part || data.frag;
                    if (isCurrentHls() && loadToken && this._hlsAbrLoadTokens?.has(loadToken)) {
                        this._hlsAbrPendingEmergencies?.delete(loadToken);
                        this._hlsAbrLoadTokens.delete(loadToken);
                        this.recordHlsAbrFragment(data);
                        this.updateHlsAbrGovernor({ currentLevel: data.frag?.level });
                    }
                });
                hls.on(Hls.Events.FRAG_CHANGED, (event, data) => {
                    if (isCurrentHls()) {
                        this.updateHlsRuntimeTimeOffset(data.frag);
                    }
                });
                hls.on(Hls.Events.LEVEL_SWITCHED, () => {
                    if (isCurrentHls()) {
                        this.updateHlsAbrGovernor();
                    }
                });
                hls.on(Hls.Events.LEVELS_UPDATED, () => {
                    if (isCurrentHls() && this._hlsAbrGovernor) {
                        const pendingProbeLevel = this._hlsAbrPendingProbeLevel;
                        this._hlsAbrPendingProbeLevel = undefined;
                        if (Number.isInteger(pendingProbeLevel)) {
                            this.applyHlsAbrDecision(this._hlsAbrGovernor.rejectProbe(
                                pendingProbeLevel,
                                performance.now(),
                                'levels-updated'
                            ));
                        }
                        const decision = this._hlsAbrGovernor.updateLevels(hls.levels.map((level, index) => ({
                            index,
                            bitrate: getHlsLevelBitrate(level)
                        })));
                        if (this._hlsAbrGovernor.hasMultipleLevels) {
                            this.applyHlsAbrDecision(decision);
                        } else {
                            this.stopHlsAbrGovernor();
                        }
                    }
                });
                hls.on(Hls.Events.FRAG_LOAD_EMERGENCY_ABORTED, (event, data) => {
                    const loadToken = data.part || data.frag;
                    const stats = data.stats || data.part?.stats || data.frag?.stats;
                    const failedLevel = Number(data.frag?.level);
                    const nativeEmergencyLevel = Number.isInteger(hls.nextAutoLevel)
                        && Number.isInteger(failedLevel)
                        && hls.nextAutoLevel >= 0
                        && hls.nextAutoLevel < failedLevel ?
                        hls.nextAutoLevel :
                        undefined;
                    if (isCurrentHls()
                        && loadToken
                        && this._hlsAbrLoadTokens?.has(loadToken)) {
                        const emergency = { failedLevel, nativeEmergencyLevel, stats };
                        // hls.js emits before a deferred abort occurs. Keep it pending until
                        // its shared loader stats confirm the abort, or discard it when buffered.
                        // hls.js deliberately does not abort the current request when its
                        // emergency target is the floor, but the level-0 switch is still real.
                        if (stats?.aborted || nativeEmergencyLevel === 0) {
                            this.handleHlsAbrEmergency(loadToken, emergency);
                        } else {
                            this._hlsAbrPendingEmergencies?.set(loadToken, emergency);
                        }
                    }
                });
                hls.on(Hls.Events.FPS_DROP_LEVEL_CAPPING, (event, data) => {
                    if (isCurrentHls()) {
                        this.setHlsAbrHardCap(data.level);
                        Promise.resolve().then(() => {
                            if (isCurrentHls() && this._hlsAbrGovernor) {
                                hls.autoLevelCapping = Math.min(
                                    data.level,
                                    this._hlsAbrGovernor.getState().capLevel
                                );
                            }
                        });
                    }
                });
                hls.on(Hls.Events.ERROR, (event, data) => {
                    if (isCurrentHls() && data.details === Hls.ErrorDetails.BUFFER_FULL_ERROR) {
                        this._hlsAbrBufferFullCount = (this._hlsAbrBufferFullCount || 0) + 1;
                        console.warn(`hls buffer full: maxBuffer=${hls.maxBufferLength}s configMax=${hls.config.maxMaxBufferLength}s`);
                    }
                });
                hls.on(Hls.Events.DESTROYING, () => {
                    if (isCurrentHls()) {
                        this.stopHlsAbrGovernor();
                    }
                    if (sourceGeneration !== this._hlsSourceGeneration) {
                        resolvePlayback();
                    }
                });

                this._activeSourceGeneration = sourceGeneration;
                bindEventsToHlsPlayer(this, hls, elem, this.onError, resolvePlayback, rejectPlayback);
                hls.attachMedia(elem);

                // This is needed in setCurrentTrackElement
                this.#currentSrc = url;
            }).catch(rejectPlayback);
        });
    }

    /**
     * @private
     */
    async setCurrentSrc(elem, options, sourceGeneration) {
        if (sourceGeneration !== this._hlsSourceGeneration) {
            return;
        }

        elem.removeEventListener('error', this.onError);

        let val = options.url;
        console.debug(`playing url: ${val}`);

        // Convert to seconds
        const seconds = (options.playerStartPositionTicks || 0) / 10000000;
        if (seconds) {
            val += `#t=${seconds}`;
        }

        this.stopHlsAbrGovernor();
        this._hlsRuntimeTimeOffset = undefined;
        destroyHlsPlayer(this);
        destroyFlvPlayer(this);
        destroyCastPlayer(this);

        let secondaryTrackValid = true;

        this.#subtitleTrackIndexToSetOnPlaying = options.mediaSource.DefaultSubtitleStreamIndex == null ? -1 : options.mediaSource.DefaultSubtitleStreamIndex;
        if (this.#subtitleTrackIndexToSetOnPlaying != null && this.#subtitleTrackIndexToSetOnPlaying >= 0) {
            const initialSubtitleStream = options.mediaSource.MediaStreams.find(stream => stream.Type === 'Subtitle' && stream.Index === this.#subtitleTrackIndexToSetOnPlaying);
            const initialSubtitleDescription = initialSubtitleStream ?
                `${initialSubtitleStream.Index}/${initialSubtitleStream.Codec}/${initialSubtitleStream.DeliveryMethod || 'none'}` :
                'none';
            console.warn(`[PGS] initial subtitle track: index=${this.#subtitleTrackIndexToSetOnPlaying} stream=${initialSubtitleDescription} pgsClient=${isClientRenderedPgsTrack(initialSubtitleStream)}`);
            if (!initialSubtitleStream || (initialSubtitleStream.DeliveryMethod === 'Encode' && !isClientRenderedPgsTrack(initialSubtitleStream))) {
                this.#subtitleTrackIndexToSetOnPlaying = -1;
                secondaryTrackValid = false;
            }
            // secondary track should not be shown if primary track is no longer a valid pair
            if (initialSubtitleStream && !playbackManager.trackHasSecondarySubtitleSupport(initialSubtitleStream, this)) {
                secondaryTrackValid = false;
            }
        } else {
            secondaryTrackValid = false;
        }

        this.#audioTrackIndexToSetOnPlaying = options.playMethod === 'Transcode' ? null : options.mediaSource.DefaultAudioStreamIndex;

        this._currentPlayOptions = options;

        if (secondaryTrackValid) {
            this.#secondarySubtitleTrackIndexToSetOnPlaying = options.mediaSource.DefaultSecondarySubtitleStreamIndex == null ? -1 : options.mediaSource.DefaultSecondarySubtitleStreamIndex;
            if (this.#secondarySubtitleTrackIndexToSetOnPlaying != null && this.#secondarySubtitleTrackIndexToSetOnPlaying >= 0) {
                const initialSecondarySubtitleStream = options.mediaSource.MediaStreams.find(stream => stream.Type === 'Subtitle' && stream.Index === this.#secondarySubtitleTrackIndexToSetOnPlaying);
                if (!initialSecondarySubtitleStream || !playbackManager.trackHasSecondarySubtitleSupport(initialSecondarySubtitleStream, this)) {
                    this.#secondarySubtitleTrackIndexToSetOnPlaying = -1;
                }
            }
        } else {
            this.#secondarySubtitleTrackIndexToSetOnPlaying = -1;
        }

        const crossOrigin = getCrossOriginValue(options.mediaSource);
        if (crossOrigin) {
            elem.crossOrigin = crossOrigin;
        }

        if (enableHlsJsPlayerForCodecs(options.mediaSource, 'Video') && isHls(options.mediaSource)) {
            return this.setSrcWithHlsJs(elem, options, val, sourceGeneration);
        } else if (options.playMethod !== 'Transcode' && options.mediaSource.Container?.toUpperCase() === 'FLV') {
            return this.setSrcWithFlvJs(elem, options, val, sourceGeneration);
        } else {
            elem.autoplay = true;

            let includeCorsCredentials;
            try {
                includeCorsCredentials = await getIncludeCorsCredentials();
            } catch (error) {
                if (sourceGeneration !== this._hlsSourceGeneration) {
                    return;
                }
                throw error;
            }
            if (sourceGeneration !== this._hlsSourceGeneration) {
                return;
            }

            if (includeCorsCredentials) {
                // Safari will not send cookies without this
                elem.crossOrigin = 'use-credentials';
            }

            return applySrc(elem, val, options, () => {
                if (sourceGeneration !== this._hlsSourceGeneration) {
                    return false;
                }
                this._activeSourceGeneration = sourceGeneration;
                return true;
            }).then(() => {
                if (sourceGeneration !== this._hlsSourceGeneration) {
                    return;
                }

                this.#currentSrc = val;

                return playWithPromise(elem, this.onError);
            }).catch(error => {
                if (sourceGeneration !== this._hlsSourceGeneration) {
                    return;
                }
                throw error;
            });
        }
    }

    setSubtitleStreamIndex(index) {
        this.setCurrentTrackElement(index);
    }

    setSecondarySubtitleStreamIndex(index) {
        this.setCurrentTrackElement(index, SECONDARY_TEXT_TRACK_INDEX);
    }

    resetSubtitleOffset() {
        this.#currentTrackOffset = 0;
        this.#secondaryTrackOffset = 0;
        this.#showTrackOffset = false;
    }

    enableShowingSubtitleOffset() {
        this.#showTrackOffset = true;
    }

    disableShowingSubtitleOffset() {
        this.#showTrackOffset = false;
    }

    isShowingSubtitleOffsetEnabled() {
        return this.#showTrackOffset;
    }

    /**
     * @private
     */
    getTextTracks() {
        const videoElement = this.#mediaElement;
        if (videoElement) {
            return Array.from(videoElement.textTracks)
                .filter(function (trackElement) {
                    // get showing .vtt textTack
                    return trackElement.mode === 'showing';
                });
        } else {
            return null;
        }
    }

    setSubtitleOffset = debounce(this._setSubtitleOffset, 100);

    /**
     * @private
     */
    _setSubtitleOffset(offset) {
        const offsetValue = parseFloat(offset);

        // if .ass currently rendering
        if (this.#currentAssRenderer) {
            this.updateCurrentTrackOffset(offsetValue);
            this.#currentAssRenderer.timeOffset = (this._currentPlayOptions.transcodingOffsetTicks || 0) / 10000000 + offsetValue;
        } else if (this.#currentPgsRenderer) {
            this.updateCurrentTrackOffset(offsetValue);
            this.#currentPgsRenderer.timeOffset = this.getPgsSubtitleTimeOffset();
        } else {
            const trackElements = this.getTextTracks();
            // if .vtt currently rendering
            if (trackElements?.length > 0) {
                trackElements.forEach((trackElement, index) => {
                    this.setTextTrackSubtitleOffset(trackElement, offsetValue, index);
                });
            } else if (this.#currentTrackEvents || this.#currentSecondaryTrackEvents) {
                this.#currentTrackEvents && this.setTrackEventsSubtitleOffset(this.#currentTrackEvents, offsetValue, PRIMARY_TEXT_TRACK_INDEX);
                this.#currentSecondaryTrackEvents && this.setTrackEventsSubtitleOffset(this.#currentSecondaryTrackEvents, offsetValue, SECONDARY_TEXT_TRACK_INDEX);
            } else {
                console.debug('No available track, cannot apply offset: ', offsetValue);
            }
        }
    }

    /**
     * @private
     */
    updateCurrentTrackOffset(offsetValue, currentTrackIndex = PRIMARY_TEXT_TRACK_INDEX) {
        let offsetToCompare = this.#currentTrackOffset;
        if (this.isSecondaryTrack(currentTrackIndex)) {
            offsetToCompare = this.#secondaryTrackOffset;
        }

        let relativeOffset = offsetValue;
        const newTrackOffset = offsetValue;

        if (offsetToCompare) {
            relativeOffset -= offsetToCompare;
        }

        if (this.isSecondaryTrack(currentTrackIndex)) {
            this.#secondaryTrackOffset = newTrackOffset;
        } else {
            this.#currentTrackOffset = newTrackOffset;
        }

        // relative to currentTrackOffset
        return relativeOffset;
    }

    /**
     * @private
     * These browsers will not clear the existing active cue when setting an offset
     * for native TextTracks.
     * Any previous text tracks that are on the screen when the offset changes will remain next
     * to the new tracks until they reach the end time of the new offset's instance of the track.
     */
    requiresHidingActiveCuesOnOffsetChange() {
        return !!browser.firefox;
    }

    /**
     * @private
     */
    hideTextTrackWithActiveCues(currentTrack) {
        if (currentTrack.activeCues) {
            currentTrack.mode = 'hidden';
        }
    }

    /**
     * Forces the active cue to clear by disabling then re-enabling the track.
     * The track mode is reverted inside of a 0ms timeout to free up the track
     * and allow it to disable and clear the active cue.
     * @private
     */
    forceClearTextTrackActiveCues(currentTrack) {
        if (currentTrack.activeCues) {
            currentTrack.mode = 'disabled';
            setTimeout(() => {
                currentTrack.mode = 'showing';
            }, 0);
        }
    }

    /**
     * @private
     */
    setTextTrackSubtitleOffset(currentTrack, offsetValue, currentTrackIndex) {
        if (currentTrack.cues) {
            offsetValue = this.updateCurrentTrackOffset(offsetValue, currentTrackIndex);
            if (offsetValue === 0) {
                return;
            }

            const shouldClearActiveCues = this.requiresHidingActiveCuesOnOffsetChange();
            if (shouldClearActiveCues) {
                this.hideTextTrackWithActiveCues(currentTrack);
            }

            Array.from(currentTrack.cues)
                .forEach(function (cue) {
                    cue.startTime -= offsetValue;
                    cue.endTime -= offsetValue;
                });

            if (shouldClearActiveCues) {
                this.forceClearTextTrackActiveCues(currentTrack);
            }
        }
    }

    /**
     * @private
     */
    setTrackEventsSubtitleOffset(trackEvents, offsetValue, currentTrackIndex) {
        if (Array.isArray(trackEvents)) {
            offsetValue = this.updateCurrentTrackOffset(offsetValue, currentTrackIndex) * 1e7; // ticks
            if (offsetValue === 0) {
                return;
            }
            trackEvents.forEach(function (trackEvent) {
                trackEvent.StartPositionTicks -= offsetValue;
                trackEvent.EndPositionTicks -= offsetValue;
            });
        }
    }

    getSubtitleOffset() {
        return this.#currentTrackOffset;
    }

    isPrimaryTrack(textTrackIndex) {
        return textTrackIndex === PRIMARY_TEXT_TRACK_INDEX;
    }

    isSecondaryTrack(textTrackIndex) {
        return textTrackIndex === SECONDARY_TEXT_TRACK_INDEX;
    }

    /**
     * @private
     */
    isAudioStreamSupported(stream, deviceProfile, container) {
        const codec = (stream.Codec || '').toLowerCase();

        if (!codec) {
            return true;
        }

        if (!deviceProfile) {
            // This should never happen
            return true;
        }

        const profiles = deviceProfile.DirectPlayProfiles || [];

        return profiles.some(function (p) {
            return p.Type === 'Video'
                    && includesAny((p.Container || '').toLowerCase(), container)
                    && includesAny((p.AudioCodec || '').toLowerCase(), codec);
        });
    }

    /**
     * @private
     */
    getSupportedAudioStreams() {
        const profile = this.#lastProfile;

        const mediaSource = this._currentPlayOptions.mediaSource;
        const container = mediaSource.Container.toLowerCase();

        return getMediaStreamAudioTracks(mediaSource).filter((stream) => {
            return this.isAudioStreamSupported(stream, profile, container);
        });
    }

    setAudioStreamIndex(index) {
        const streams = this.getSupportedAudioStreams();

        if (streams.length < 2) {
            // If there's only one supported stream then trust that the player will handle it on it's own
            return;
        }

        let audioIndex = -1;

        for (const stream of streams) {
            audioIndex++;

            if (stream.Index === index) {
                break;
            }
        }

        if (audioIndex === -1) {
            return;
        }

        const elem = this.#mediaElement;
        if (!elem) {
            return;
        }

        // https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/audioTracks

        /**
         * @type {ArrayLike<any>|any[]}
         */
        const elemAudioTracks = elem.audioTracks || [];
        console.debug(`found ${elemAudioTracks.length} audio tracks`);

        for (const [i, audioTrack] of Array.from(elemAudioTracks).entries()) {
            if (audioIndex === i) {
                console.debug(`setting audio track ${i} to enabled`);
                audioTrack.enabled = true;
            } else {
                console.debug(`setting audio track ${i} to disabled`);
                audioTrack.enabled = false;
            }
        }
    }

    stop(destroyPlayer) {
        const elem = this.#mediaElement;
        const src = this.#currentSrc;

        this._hlsSourceGeneration++;
        this._activeSourceGeneration = undefined;
        this.stopHlsAbrGovernor();

        if (elem) {
            if (src) {
                elem.pause();
            }

            onEndedInternal(this, elem, this.onError);
        }

        this.destroyCustomTrack(elem);

        if (destroyPlayer) {
            this.destroy();
        }

        return Promise.resolve();
    }

    destroy() {
        this.setSubtitleOffset.cancel();

        this._hlsSourceGeneration++;
        this._activeSourceGeneration = undefined;
        this.stopHlsAbrGovernor();
        destroyHlsPlayer(this);
        destroyFlvPlayer(this);

        setBackdropTransparency(TRANSPARENCY_LEVEL.None);
        document.body.classList.remove('hide-scroll');

        const videoElement = this.#mediaElement;

        if (videoElement) {
            this.#mediaElement = null;

            this.destroyCustomTrack(videoElement);
            videoElement.removeEventListener('timeupdate', this.onTimeUpdate);
            videoElement.removeEventListener('ended', this.onEnded);
            videoElement.removeEventListener('volumechange', this.onVolumeChange);
            videoElement.removeEventListener('pause', this.onPause);
            videoElement.removeEventListener('playing', this.onPlaying);
            videoElement.removeEventListener('play', this.onPlay);
            videoElement.removeEventListener('click', this.onClick);
            videoElement.removeEventListener('dblclick', this.onDblClick);
            videoElement.removeEventListener('waiting', this.onWaiting);
            videoElement.removeEventListener('seeking', this.onSeeking);
            videoElement.removeEventListener('seeked', this.onSeeked);
            videoElement.removeEventListener('error', this.onError); // bound in htmlMediaHelper

            resetSrc(videoElement);

            videoElement.parentNode.removeChild(videoElement);
        }

        const dlg = this.#videoDialog;
        if (dlg) {
            this.#videoDialog = null;
            dlg.parentNode.removeChild(dlg);
        }

        if (Screenfull.isEnabled) {
            Screenfull.exit();
        } else if (document.webkitIsFullScreen && document.webkitCancelFullscreen) {
            // iOS Safari
            document.webkitCancelFullscreen();
        }
    }

    /**
     * @private
     * @param e {Event} The event received from the `<video>` element
     */
    onEnded = (e) => {
        /**
         * @type {HTMLMediaElement}
         */
        const elem = e.target;
        if (this._activeSourceGeneration !== this._hlsSourceGeneration || !elem.ended) {
            return;
        }

        this._hlsSourceGeneration++;
        this._activeSourceGeneration = undefined;
        this.stopHlsAbrGovernor();
        this.destroyCustomTrack(elem);
        onEndedInternal(this, elem, this.onError);
    };

    /**
     * @private
     * @param e {Event} The event received from the `<video>` element
     */
    onTimeUpdate = (e) => {
        /**
         * @type {HTMLMediaElement}
         */
        const elem = e.target;
        // get the player position and the transcoding offset
        const time = elem.currentTime;

        if (time && !this.#timeUpdated) {
            this.#timeUpdated = true;
            this.ensureValidVideo(elem);
        }

        this.#currentTime = time;

        const currentPlayOptions = this._currentPlayOptions;
        // Not sure yet how this is coming up null since we never null it out, but it is causing app crashes
        if (currentPlayOptions) {
            let timeMs = time * 1000;
            timeMs += this.getPlaybackRuntimeTimeOffset() * 1000;
            this.updateSubtitleText(timeMs);
        }

        Events.trigger(this, 'timeupdate');
    };

    /**
     * @private
     * @param e {Event} The event received from the `<video>` element
     */
    onVolumeChange = (e) => {
        /**
         * @type {HTMLMediaElement}
         */
        const elem = e.target;
        saveVolume(elem.volume);
        Events.trigger(this, 'volumechange');
    };

    /**
     * @private
     */
    onNavigatedToOsd = () => {
        const dlg = this.#videoDialog;
        if (dlg) {
            dlg.classList.remove('videoPlayerContainer-onTop');

            this.onStartedAndNavigatedToOsd();
        }
    };

    /**
     * @private
     */
    onStartedAndNavigatedToOsd() {
        // If this causes a failure during navigation we end up in an awkward UI state
        this.setCurrentTrackElement(this.#subtitleTrackIndexToSetOnPlaying);

        if (this.#audioTrackIndexToSetOnPlaying != null && this.canSetAudioStreamIndex()) {
            this.setAudioStreamIndex(this.#audioTrackIndexToSetOnPlaying);
        }

        if (this.#secondarySubtitleTrackIndexToSetOnPlaying != null && this.#secondarySubtitleTrackIndexToSetOnPlaying >= 0) {
            /**
             * Using a 0ms timeout to set the secondary subtitles because of some weird race condition when
             * setting both primary and secondary tracks at the same time.
             * The `TextTrack` content and cues will somehow get mixed up and each track will play a mix of both languages.
             * Putting this in a timeout fixes it completely.
             */
            setTimeout(() => this.setSecondarySubtitleStreamIndex(this.#secondarySubtitleTrackIndexToSetOnPlaying), 0);
        }
    }

    /**
     * @private
     * @param e {Event} The event received from the `<video>` element
     */
    onPlaying = (e) => {
        /**
         * @type {HTMLMediaElement}
         */
        const elem = e.target;
        if (this._hlsAbrSeeking || this._hlsAbrSeekGraceUntil) {
            this._hlsAbrSeeking = false;
            this._hlsAbrSeekGraceUntil = undefined;
            this.resetHlsAbrGovernorForSeek(performance.now());
        }
        this.updateHlsAbrGovernor();

        if (!this.#started) {
            this.#started = true;
            elem.removeAttribute('controls');

            loading.hide();

            seekOnPlaybackStart(this, e.target, this._currentPlayOptions.playerStartPositionTicks, () => {
                if (this.#currentAssRenderer) {
                    this.#currentAssRenderer.timeOffset = (this._currentPlayOptions.transcodingOffsetTicks || 0) / 10000000 + this.#currentTrackOffset;
                    this.#currentAssRenderer.resize();
                    this.#currentAssRenderer.resetRenderAheadCache(false);
                }
            });

            if (this._currentPlayOptions.fullscreen) {
                appRouter.showVideoOsd().then(this.onNavigatedToOsd);
            } else {
                setBackdropTransparency(TRANSPARENCY_LEVEL.Backdrop);
                this.#videoDialog.classList.remove('videoPlayerContainer-onTop');

                this.onStartedAndNavigatedToOsd();
            }
        }
        Events.trigger(this, 'playing');
    };

    /**
     * @private
     */
    onPlay = () => {
        Events.trigger(this, 'unpause');
    };

    /**
     * @private
     */
    ensureValidVideo(elem) {
        if (elem !== this.#mediaElement) {
            return;
        }

        if (elem.videoWidth === 0 && elem.videoHeight === 0) {
            const mediaSource = this._currentPlayOptions?.mediaSource;

            // Only trigger this if there is media info
            // Avoid triggering in situations where it might not actually have a video stream (audio only live tv channel)
            if (!mediaSource || mediaSource.RunTimeTicks) {
                onErrorInternal(this, MediaError.NO_MEDIA_ERROR);
            }
        }
    }

    /**
     * @private
     */
    onClick = () => {
        Events.trigger(this, 'click');
    };

    /**
     * @private
     */
    onDblClick = () => {
        Events.trigger(this, 'dblclick');
    };

    /**
     * @private
     */
    onPause = () => {
        this.updateHlsAbrGovernor();
        Events.trigger(this, 'pause');
    };

    /**
     * @private
     */
    onSeeking = () => {
        const nowMs = performance.now();
        this._hlsAbrSeeking = true;
        this._hlsAbrSeekGraceUntil = undefined;
        this.resetHlsAbrGovernorForSeek(nowMs);

        Events.trigger(this, 'seeking');
    };

    /**
     * @private
     */
    onSeeked = () => {
        const nowMs = performance.now();
        this._hlsAbrSeeking = false;
        this._hlsAbrSeekGraceUntil = nowMs + HLS_ABR_SEEK_GRACE_MS;
        this.resetHlsAbrGovernorForSeek(nowMs);

        Events.trigger(this, 'seeked');
    };

    onWaiting = () => {
        if (this.#started) {
            this.updateHlsAbrGovernor({ isWaiting: true });
        }

        Events.trigger(this, 'waiting');
    };

    /**
     * @private
     * @param e {Event} The event received from the `<video>` element
     */
    onError = (e) => {
        /**
         * @type {HTMLMediaElement}
         */
        const elem = e.target;
        const errorCode = elem.error ? (elem.error.code || 0) : 0;
        const errorMessage = elem.error ? (elem.error.message || '') : '';
        console.error(`media element error: ${errorCode} ${errorMessage}`);

        let type;

        switch (errorCode) {
            case 1:
                // MEDIA_ERR_ABORTED
                // This will trigger when changing media while something is playing
                return;
            case 2:
                // MEDIA_ERR_NETWORK
                type = MediaError.NETWORK_ERROR;
                break;
            case 3:
                // MEDIA_ERR_DECODE
                if (this._hlsPlayer) {
                    handleHlsJsMediaError(this);
                    return;
                } else {
                    type = MediaError.MEDIA_DECODE_ERROR;
                }
                break;
            case 4:
                // MEDIA_ERR_SRC_NOT_SUPPORTED
                type = MediaError.MEDIA_NOT_SUPPORTED;
                break;
            default:
                // seeing cases where Edge is firing error events with no error code
                // example is start playing something, then immediately change src to something else
                return;
        }

        onErrorInternal(this, type);
    };

    /**
     * @private
     */
    destroyCustomRenderedTrackElements(targetTrackIndex) {
        if (this.isPrimaryTrack(targetTrackIndex)) {
            if (this.#videoSubtitlesElem) {
                tryRemoveElement(this.#videoSubtitlesElem);
                this.#videoSubtitlesElem = null;
            }
            document.querySelectorAll(`.${PGS_CANVAS_CLASS}`).forEach(tryRemoveElement);
        } else if (this.isSecondaryTrack(targetTrackIndex)) {
            if (this.#videoSecondarySubtitlesElem) {
                tryRemoveElement(this.#videoSecondarySubtitlesElem);
                this.#videoSecondarySubtitlesElem = null;
            }
        } else if (this.#videoSubtitlesElem) {
            // destroy all
            const subtitlesContainer = this.#videoSubtitlesElem.parentNode;
            if (subtitlesContainer) {
                tryRemoveElement(subtitlesContainer);
            }
            this.#videoSubtitlesElem = null;
            this.#videoSecondarySubtitlesElem = null;
            document.querySelectorAll(`.${PGS_CANVAS_CLASS}`).forEach(tryRemoveElement);
        } else {
            document.querySelectorAll(`.${PGS_CANVAS_CLASS}`).forEach(tryRemoveElement);
        }
    }

    /**
     * @private
     */
    destroyNativeTracks(videoElement, targetTrackIndex, disableEmbeddedTracks = false) {
        if (videoElement) {
            const destroySingleTrack = typeof targetTrackIndex === 'number';
            let manualTrackIndex = 0;
            const allTracks = Array.from(videoElement.textTracks || []); // get list of tracks
            for (const track of allTracks) {
                if (!isManualTextTrack(track)) {
                    if (disableEmbeddedTracks) {
                        track.mode = 'disabled';
                    }
                    continue;
                }

                // Skip all other manual tracks if we are targeting just one
                if (!destroySingleTrack || targetTrackIndex === manualTrackIndex) {
                    track.mode = 'disabled';
                }

                manualTrackIndex++;
            }
        }
    }

    /**
     * @private
     */
    destroyStoredTrackInfo(targetTrackIndex) {
        if (this.isPrimaryTrack(targetTrackIndex)) {
            this.#customTrackIndex = -1;
            this.#currentTrackEvents = null;
        } else if (this.isSecondaryTrack(targetTrackIndex)) {
            this.#customSecondaryTrackIndex = -1;
            this.#currentSecondaryTrackEvents = null;
        } else { // destroy all
            this.#customTrackIndex = -1;
            this.#customSecondaryTrackIndex = -1;
            this.#currentTrackEvents = null;
            this.#currentSecondaryTrackEvents = null;
        }
    }

    /**
     * @private
     */
    destroyCustomTrack(videoElement, targetTrackIndex, disableEmbeddedTracks = false) {
        this.destroyCustomRenderedTrackElements(targetTrackIndex);
        this.destroyNativeTracks(videoElement, targetTrackIndex, disableEmbeddedTracks);
        this.destroyStoredTrackInfo(targetTrackIndex);

        const octopus = this.#currentAssRenderer;
        if (octopus) {
            octopus.dispose();
        }
        this.#currentAssRenderer = null;

        const pgsRenderer = this.#currentPgsRenderer;
        if (pgsRenderer) {
            pgsRenderer.dispose();
        }
        this.#currentPgsRenderer = null;
    }

    /**
     * @private
     */
    fetchSubtitlesUwp(track) {
        return Windows.Storage.StorageFile.getFileFromPathAsync(track.Path).then(function (storageFile) {
            return Windows.Storage.FileIO.readTextAsync(storageFile);
        }).then(function (text) {
            return JSON.parse(text);
        });
    }

    /**
     * @private
     */
    async fetchSubtitles(track, item) {
        if (window.Windows && itemHelper.isLocalItem(item)) {
            return this.fetchSubtitlesUwp(track, item);
        }

        this.incrementFetchQueue();
        try {
            const response = await fetch(getTextTrackUrl(track, item, '.js'));

            if (!response.ok) {
                throw new Error(response);
            }

            return response.json();
        } finally {
            this.decrementFetchQueue();
        }
    }

    /**
     * @private
     */
    setTrackForDisplay(videoElement, track, targetTextTrackIndex = PRIMARY_TEXT_TRACK_INDEX) {
        if (!track) {
            // Destroy all tracks by passing undefined if there is no valid primary track
            const targetTrackIndex = this.isSecondaryTrack(targetTextTrackIndex) ? targetTextTrackIndex : undefined;
            this.destroyCustomTrack(videoElement, targetTrackIndex, !this.isSecondaryTrack(targetTextTrackIndex));
            return;
        }

        let targetTrackIndex = this.#customTrackIndex;
        if (this.isSecondaryTrack(targetTextTrackIndex)) {
            targetTrackIndex = this.#customSecondaryTrackIndex;
        }

        // skip if already playing this track
        if (targetTrackIndex === track.Index) {
            return;
        }

        this.resetSubtitleOffset();
        const item = this._currentPlayOptions.item;

        this.destroyCustomTrack(videoElement, targetTextTrackIndex, true);

        if (this.isSecondaryTrack(targetTextTrackIndex)) {
            this.#customSecondaryTrackIndex = track.Index;
        } else {
            this.#customTrackIndex = track.Index;
        }
        this.renderTracksEvents(videoElement, track, item, targetTextTrackIndex);
    }

    /**
     * @private
     */
    renderSsaAss(videoElement, track, item) {
        const supportedFonts = ['application/vnd.ms-opentype', 'application/x-truetype-font', 'font/otf', 'font/ttf', 'font/woff', 'font/woff2'];
        const availableFonts = [];
        const attachments = this._currentPlayOptions.mediaSource.MediaAttachments || [];
        const apiClient = ServerConnections.getApiClient(item);
        attachments.forEach(i => {
            // we only require font files and ignore embedded media attachments like covers as there are cases where ffmpeg fails to extract those
            if (supportedFonts.includes(i.MimeType)) {
                // embedded font url
                availableFonts.push(apiClient.getUrl(i.DeliveryUrl));
            }
        });
        const fallbackFontList = apiClient.getUrl('/FallbackFont/Fonts', {
            ApiKey: apiClient.accessToken()
        });
        const htmlVideoPlayer = this;
        import('@jellyfin/libass-wasm').then(({ default: SubtitlesOctopus }) => {
            const mediaSource = this._currentPlayOptions.mediaSource;
            const videoStream = getMediaStreamVideoTracks(mediaSource)[0];

            const options = {
                video: videoElement,
                subUrl: getTextTrackUrl(track, item),
                fonts: availableFonts,
                workerUrl: `${appRouter.baseUrl()}/libraries/subtitles-octopus-worker.js`,
                legacyWorkerUrl: `${appRouter.baseUrl()}/libraries/subtitles-octopus-worker-legacy.js`,
                onError() {
                    // HACK: Clear JavascriptSubtitlesOctopus: it gets disposed when an error occurs
                    htmlVideoPlayer.#currentAssRenderer = null;

                    // HACK: Give JavascriptSubtitlesOctopus time to dispose itself
                    setTimeout(() => {
                        onErrorInternal(this, MediaError.ASS_RENDER_ERROR);
                    }, 0);
                },
                timeOffset: (this._currentPlayOptions.transcodingOffsetTicks || 0) / 10000000,

                // new octopus options; override all, even defaults
                renderMode: 'wasm-blend',
                dropAllAnimations: false,
                libassMemoryLimit: 40,
                libassGlyphLimit: 40,
                targetFps: videoStream?.ReferenceFrameRate || 24,
                prescaleFactor: 0.8,
                prescaleHeightLimit: 1080,
                maxRenderHeight: 2160,
                resizeVariation: 0.2,
                renderAhead: 90
            };

            Promise.all([
                apiClient.getNamedConfiguration('encoding'),
                // Worker in Tizen 5 doesn't resolve relative path with async request
                resolveUrl(options.workerUrl),
                resolveUrl(options.legacyWorkerUrl)
            ]).then(([config, workerUrl, legacyWorkerUrl]) => {
                options.workerUrl = workerUrl;
                options.legacyWorkerUrl = legacyWorkerUrl;

                if (config.EnableFallbackFont) {
                    apiClient.getJSON(fallbackFontList).then((fontFiles = []) => {
                        fontFiles.forEach(font => {
                            const fontUrl = apiClient.getUrl(`/FallbackFont/Fonts/${encodeURIComponent(font.Name)}`, {
                                ApiKey: apiClient.accessToken()
                            });
                            availableFonts.push(fontUrl);
                        });
                        this.#currentAssRenderer = new SubtitlesOctopus(options);
                    });
                } else {
                    this.#currentAssRenderer = new SubtitlesOctopus(options);
                }
            });
        });
    }

    /**
     * @private
     */
    renderPgs(videoElement, track, item) {
        import('libpgs').then((libpgs) => {
            const aspectRatio = this.getPgsRenderAspectRatio();
            const canvas = document.createElement('canvas');
            canvas.classList.add(PGS_CANVAS_CLASS);
            canvas.style.position = 'absolute';
            canvas.style.inset = '0';
            canvas.style.width = '100%';
            canvas.style.height = '100%';
            canvas.style.zIndex = '1';
            canvas.style.pointerEvents = 'none';
            canvas.style.objectFit = aspectRatio;
            videoElement.parentNode.appendChild(canvas);
            const options = {
                video: videoElement,
                canvas,
                subUrl: getPgsTrackUrl(track, item, this._currentPlayOptions.mediaSource, this._currentPlayOptions.playerStartPositionTicks),
                workerUrl: `${appRouter.baseUrl()}/libraries/libpgs.worker.js`,
                timeOffset: this.getPgsSubtitleTimeOffset(),
                aspectRatio,
                mode: 'mainThread'
            };
            console.warn(`[PGS] rendering PGS subtitles: index=${track.Index} delivery=${track.DeliveryMethod || 'none'} videoTime=${videoElement.currentTime.toFixed(3)} offset=${options.timeOffset.toFixed(3)} url=${options.subUrl}`);
            this.#currentPgsRenderer = new libpgs.PgsRenderer(options);
            // libpgs initializes its previous timestamp index to 0. If playback starts inside
            // timestamp index 0, the first real render is skipped unless we force a state change.
            this.#currentPgsRenderer.renderAtTimestamp(-1);
            setTimeout(() => {
                console.warn(`[PGS] canvas state: size=${canvas.width}x${canvas.height} videoTime=${videoElement.currentTime.toFixed(3)} offset=${this.#currentPgsRenderer?.timeOffset?.toFixed?.(3) || 'none'}`);
            }, 5000);
        });
    }

    getPgsRenderAspectRatio(aspectRatio = this._currentPlayOptions?.aspectRatio || this.getAspectRatio()) {
        if (appSettings.get('subtitlepgsrendermode') === 'screensafearea') {
            return 'contain';
        }

        return aspectRatio === 'auto' ? 'contain' : aspectRatio;
    }

    /**
     * @private
     */
    renderSubtitlesWithCustomElement(videoElement, track, item, targetTextTrackIndex) {
        this.fetchSubtitles(track, item).then((subtitleData) => {
            // Exit if the video element was destroyed while fetching subtitles
            if (!this.#mediaElement) return;

            const subtitleAppearance = userSettings.getSubtitleAppearanceSettings();
            const subtitleVerticalPosition = parseInt(subtitleAppearance.verticalPosition, 10);

            if (!this.#videoSubtitlesElem && !this.isSecondaryTrack(targetTextTrackIndex)) {
                let subtitlesContainer = document.querySelector('.videoSubtitles');
                if (!subtitlesContainer) {
                    subtitlesContainer = document.createElement('div');
                    subtitlesContainer.classList.add('videoSubtitles');
                }
                const subtitlesElement = document.createElement('div');
                subtitlesElement.classList.add('videoSubtitlesInner');
                subtitlesContainer.appendChild(subtitlesElement);
                this.#videoSubtitlesElem = subtitlesElement;
                this.setSubtitleAppearance(subtitlesContainer, this.#videoSubtitlesElem);
                videoElement.parentNode.appendChild(subtitlesContainer);
                this.#currentTrackEvents = subtitleData.TrackEvents;
            } else if (!this.#videoSecondarySubtitlesElem && this.isSecondaryTrack(targetTextTrackIndex)) {
                const subtitlesContainer = document.querySelector('.videoSubtitles');
                if (!subtitlesContainer) return;
                const secondarySubtitlesElement = document.createElement('div');
                secondarySubtitlesElement.classList.add('videoSecondarySubtitlesInner');
                // determine the order of the subtitles
                if (subtitleVerticalPosition < 0) {
                    subtitlesContainer.insertBefore(secondarySubtitlesElement, subtitlesContainer.firstChild);
                } else {
                    subtitlesContainer.appendChild(secondarySubtitlesElement);
                }
                this.#videoSecondarySubtitlesElem = secondarySubtitlesElement;
                this.setSubtitleAppearance(subtitlesContainer, this.#videoSecondarySubtitlesElem);
                this.#currentSecondaryTrackEvents = subtitleData.TrackEvents;
            }
        });
    }

    /**
     * @private
     */
    setSubtitleAppearance(elem, innerElem) {
        subtitleAppearanceHelper.applyStyles({
            text: innerElem,
            window: elem
        }, userSettings.getSubtitleAppearanceSettings());
    }

    /**
     * @private
     */
    getCueCss(appearance, selector) {
        return `${selector}::cue {
                ${appearance.text.map((s) => s.value !== undefined && s.value !== '' ? `${s.name}:${s.value}!important;` : '').join('')}
            }`;
    }

    /**
     * @private
     */
    setCueAppearance() {
        const elementId = `${this.id}-cuestyle`;

        let styleElem = document.querySelector(`#${elementId}`);
        if (!styleElem) {
            styleElem = document.createElement('style');
            styleElem.id = elementId;
            document.getElementsByTagName('head')[0].appendChild(styleElem);
        }

        styleElem.innerHTML = this.getCueCss(subtitleAppearanceHelper.getStyles(userSettings.getSubtitleAppearanceSettings()), '.htmlvideoplayer');
    }

    /**
     * @private
     */
    async renderTracksEvents(videoElement, track, item, targetTextTrackIndex = PRIMARY_TEXT_TRACK_INDEX) {
        if (isClientRenderedPgsTrack(track)) {
            this.renderPgs(videoElement, track, item);
            return;
        }

        if (!itemHelper.isLocalItem(item) || track.IsExternal) {
            const format = (track.Codec || '').toLowerCase();
            if (format === 'ssa' || format === 'ass') {
                this.renderSsaAss(videoElement, track, item);
                return;
            }
            if (format === 'pgssub') {
                this.renderPgs(videoElement, track, item);
                return;
            }

            if (useCustomSubtitles(userSettings)) {
                this.renderSubtitlesWithCustomElement(videoElement, track, item, targetTextTrackIndex);
                return;
            }
        }

        let trackElement = null;
        const manualTracks = Array.from(videoElement.textTracks || []).filter(isManualTextTrack);
        if (manualTracks.length > targetTextTrackIndex) {
            trackElement = manualTracks[targetTextTrackIndex];
            // This throws an error in IE, but is fine in chrome
            // In IE it's not necessary anyway because changing the src seems to be enough
            try {
                trackElement.mode = 'showing';
                while (trackElement.cues.length) {
                    trackElement.removeCue(trackElement.cues[0]);
                }
            } catch (e) {
                console.error('error removing cue from textTrack', e);
            }

            trackElement.mode = 'disabled';
        } else {
            // There is a function addTextTrack but no function for removeTextTrack
            // Therefore we add ONE element and replace its cue data
            trackElement = videoElement.addTextTrack('subtitles', 'manualTrack', 'und');
        }

        // download the track json
        this.fetchSubtitles(track, item).then(data => {
            // Exit if the video element was destroyed while fetching subtitles
            if (!this.#mediaElement) return;

            console.debug(`downloaded ${data.TrackEvents.length} track events`);

            const subtitleAppearance = userSettings.getSubtitleAppearanceSettings();
            const cueLine = parseInt(subtitleAppearance.verticalPosition, 10);

            // add some cues to show the text
            // in safari, the cues need to be added before setting the track mode to showing
            for (const trackEvent of data.TrackEvents) {
                const TrackCue = window.VTTCue || window.TextTrackCue;
                const text = normalizeTrackEventText(trackEvent.Text, false);
                const cue = new TrackCue(trackEvent.StartPositionTicks / 10000000, trackEvent.EndPositionTicks / 10000000, text);

                if (cue.line === 'auto') {
                    if (cueLine < 0) {
                        const lineCount = (text.match(/\n/g) || []).length;
                        cue.line = cueLine - lineCount;
                    } else {
                        cue.line = cueLine;
                    }
                }

                trackElement.addCue(cue);
            }

            trackElement.mode = 'showing';
        });
    }

    /**
     * @private
     */
    updateSubtitleText(timeMs) {
        const allTrackEvents = [this.#currentTrackEvents, this.#currentSecondaryTrackEvents];
        const subtitleTextElements = [this.#videoSubtitlesElem, this.#videoSecondarySubtitlesElem];

        for (let i = 0; i < allTrackEvents.length; i++) {
            const trackEvents = allTrackEvents[i];
            const subtitleTextElement = subtitleTextElements[i];

            if (trackEvents && subtitleTextElement) {
                const ticks = timeMs * 10000;
                let selectedTrackEvent;
                for (const trackEvent of trackEvents) {
                    if (trackEvent.StartPositionTicks <= ticks && trackEvent.EndPositionTicks >= ticks) {
                        selectedTrackEvent = trackEvent;
                        break;
                    }
                }

                if (selectedTrackEvent?.Text) {
                    subtitleTextElement.innerHTML = DOMPurify.sanitize(
                        normalizeTrackEventText(selectedTrackEvent.Text, true));
                    subtitleTextElement.classList.remove('hide');
                } else {
                    subtitleTextElement.classList.add('hide');
                }
            }
        }
    }

    /**
     * @private
     */
    setCurrentTrackElement(streamIndex, targetTextTrackIndex) {
        console.debug(`setting new text track index to: ${streamIndex}`);

        const mediaStreamTextTracks = getMediaStreamTextTracks(this._currentPlayOptions.mediaSource);

        let track = streamIndex === -1 ? null : mediaStreamTextTracks.filter(function (t) {
            return t.Index === streamIndex;
        })[0];
        const trackDescription = track ? `${track.Index}/${track.Codec}/${track.DeliveryMethod || 'none'}` : 'none';
        console.warn(`[PGS] text track resolved: index=${streamIndex} track=${trackDescription} pgsClient=${isClientRenderedPgsTrack(track)}`);

        // This play method can only check if it is real direct play, and will mark Remux as Transcode as well
        const isDirectPlay = this._currentPlayOptions.playMethod === 'DirectPlay';
        const burnInWhenTranscoding = appSettings.alwaysBurnInSubtitleWhenTranscoding();

        let sessionPromise;
        if (!isDirectPlay && burnInWhenTranscoding) {
            const apiClient = ServerConnections.getApiClient(this._currentPlayOptions.item.ServerId);
            sessionPromise = apiClient.getSessions({
                deviceId: apiClient.deviceId()
            }).then(function (sessions) {
                return sessions[0] || {};
            }, function () {
                return Promise.resolve({});
            });
        } else {
            sessionPromise = Promise.resolve({});
        }

        const player = this;

        sessionPromise.then((s) => {
            if (!s.TranscodingInfo || s.TranscodingInfo.IsVideoDirect) {
                // restore recorded delivery method if any
                mediaStreamTextTracks.forEach((t) => {
                    t.DeliveryMethod = t.realDeliveryMethod ?? t.DeliveryMethod;
                });
                player.setTrackForDisplay(player.#mediaElement, track, targetTextTrackIndex);
                if (enableNativeTrackSupport(player._currentPlayOptions?.mediaSource, track)) {
                    if (streamIndex !== -1) {
                        player.setCueAppearance();
                    }
                } else {
                    // null these out to disable the player's native display (handled below)
                    streamIndex = -1;
                    track = null;
                }
            } else {
                // record the original delivery method and set all delivery method to encode
                // this is needed for subtitle track switching to properly reload the video stream
                mediaStreamTextTracks.forEach((t) => {
                    t.realDeliveryMethod = t.DeliveryMethod;
                    t.DeliveryMethod = 'Encode';
                });
                // unset stream when switching to transcode
                player.setTrackForDisplay(player.#mediaElement, null, -1);
            }
        });
    }

    /**
     * @private
     */
    createMediaElement(options, sourceGeneration) {
        const dlg = document.querySelector('.videoPlayerContainer');

        if (!dlg) {
            return import('./style.scss').then(() => {
                if (sourceGeneration !== this._hlsSourceGeneration) {
                    return;
                }

                if (options.fullscreen) loading.show();

                const playerDlg = document.createElement('div');
                playerDlg.setAttribute('dir', 'ltr');
                playerDlg.classList.add('videoPlayerContainer');
                if (options.fullscreen) {
                    playerDlg.classList.add('videoPlayerContainer-onTop');
                }

                let html = '';
                const cssClass = 'htmlvideoplayer';

                // Can't autoplay in these browsers so we need to use the full controls, at least until playback starts
                if (!appHost.supports(AppFeature.HtmlVideoAutoplay)) {
                    html += '<video class="' + cssClass + '" preload="metadata" autoplay="autoplay" controls="controls" webkit-playsinline playsinline>';
                } else if (browser.web0s) {
                    // in webOS, setting preload auto allows resuming videos
                    html += '<video class="' + cssClass + '" preload="auto" autoplay="autoplay" webkit-playsinline playsinline>';
                } else {
                    // Chrome 35 won't play with preload none
                    html += '<video class="' + cssClass + '" preload="metadata" autoplay="autoplay" webkit-playsinline playsinline>';
                }

                html += '</video>';

                playerDlg.innerHTML = html;
                const videoElement = playerDlg.querySelector('video');

                // TODO: Move volume control to PlaybackManager. Player should just be a wrapper that translates commands into API calls.
                if (!appHost.supports(AppFeature.PhysicalVolumeControl)) {
                    videoElement.volume = getSavedVolume();
                }

                videoElement.addEventListener('timeupdate', this.onTimeUpdate);
                videoElement.addEventListener('ended', this.onEnded);
                videoElement.addEventListener('volumechange', this.onVolumeChange);
                videoElement.addEventListener('pause', this.onPause);
                videoElement.addEventListener('playing', this.onPlaying);
                videoElement.addEventListener('play', this.onPlay);
                videoElement.addEventListener('click', this.onClick);
                videoElement.addEventListener('dblclick', this.onDblClick);
                videoElement.addEventListener('waiting', this.onWaiting);
                videoElement.addEventListener('seeking', this.onSeeking);
                videoElement.addEventListener('seeked', this.onSeeked);
                if (options.backdropUrl) {
                    videoElement.poster = options.backdropUrl;
                }

                document.body.insertBefore(playerDlg, document.body.firstChild);
                this.#videoDialog = playerDlg;
                this.#mediaElement = videoElement;

                delete this.forcedFullscreen;

                if (options.fullscreen) {
                    // At this point, we must hide the scrollbar placeholder, so it's not being displayed while the item is being loaded
                    document.body.classList.add('hide-scroll');

                    // Enter fullscreen in the webOS browser to hide the top bar
                    if (!window.NativeShell && browser.web0s && Screenfull.isEnabled) {
                        Screenfull.request().then(() => {
                            if (sourceGeneration === this._hlsSourceGeneration) {
                                this.forcedFullscreen = true;
                            }
                        });
                        return videoElement;
                    }

                    // don't animate on smart tv's, too slow
                    if (!browser.slow && browser.supportsCssAnimation()) {
                        return zoomIn(playerDlg).then(function () {
                            return videoElement;
                        });
                    }
                }

                return videoElement;
            });
        } else {
            if (options.fullscreen) {
                // we need to hide scrollbar when starting playback from page with animated background
                document.body.classList.add('hide-scroll');

                // Enter fullscreen in the webOS browser to hide the top bar
                if (!this.forcedFullscreen && !window.NativeShell && browser.web0s && Screenfull.isEnabled) {
                    Screenfull.request().then(() => {
                        if (sourceGeneration === this._hlsSourceGeneration) {
                            this.forcedFullscreen = true;
                        }
                    });
                }
            }

            const videoElement = dlg.querySelector('video');
            if (options.backdropUrl) {
                // update backdrop image
                videoElement.poster = options.backdropUrl;
            }

            return Promise.resolve(videoElement);
        }
    }

    /**
     * @private
     */
    canPlayMediaType(mediaType) {
        return (mediaType || '').toLowerCase() === 'video';
    }

    supportsAdaptiveBitrate(item) {
        return item?.MediaType === 'Video' && enableHlsJsPlayer(item.RunTimeTicks, 'Video');
    }

    getMaxStreamingBitrate() {
        const hls = this._hlsPlayer;
        if (!hls?.levels?.length || hls.levels.length < 2) {
            return null;
        }

        if (hls.autoLevelEnabled) {
            return getCurrentHlsLevelBitrate(hls);
        }

        const level = hls.manualLevel > -1 ? hls.manualLevel : hls.loadLevel;
        return getHlsLevelBitrate(hls.levels[level]) || null;
    }

    enableAutomaticBitrateDetection() {
        if (this._hlsAbrGovernor) {
            return true;
        }

        const hls = this._hlsPlayer;
        if (!hls?.levels?.length || hls.levels.length < 2) {
            return null;
        }

        return hls.autoLevelEnabled;
    }

    getSupportedStreamingBitrates() {
        const hls = this._hlsPlayer;
        if (!hls?.levels?.length || hls.levels.length < 2) {
            return null;
        }

        return hls.levels
            .map(getHlsLevelBitrate)
            .filter(Boolean);
    }

    setMaxStreamingBitrate(options) {
        const hls = this._hlsPlayer;
        if (!hls?.levels?.length || hls.levels.length < 2) {
            return false;
        }

        if (options.enableAutomaticBitrateDetection || !options.maxBitrate) {
            if (useHlsAbrGovernor(this._currentPlayOptions || {})) {
                if (!this.startHlsAbrGovernor()) {
                    hls.startLevel = -1;
                    hls.loadLevel = -1;
                }
            } else {
                this.stopHlsAbrGovernor();
                hls.startLevel = -1;
                hls.loadLevel = -1;
            }
            return true;
        }

        this.stopHlsAbrGovernor();

        const level = getManualHlsLevelForBitrate(hls.levels, options.maxBitrate);
        if (level === -1) {
            return false;
        }

        hls.startLevel = level;
        hls.loadLevel = level;
        return true;
    }

    /**
     * @private
     */
    supportsPlayMethod(playMethod, item) {
        if (appHost.supportsPlayMethod) {
            return appHost.supportsPlayMethod(playMethod, item);
        }

        return true;
    }

    /**
     * @private
     */
    getDeviceProfile(item, options) {
        return HtmlVideoPlayer.getDeviceProfileInternal(item, options).then((profile) => {
            this.#lastProfile = profile;
            return profile;
        });
    }

    /**
     * @private
     */
    static getDeviceProfileInternal(item, options) {
        if (appHost.getDeviceProfile) {
            return appHost.getDeviceProfile(item, options);
        }

        return getDefaultProfile();
    }

    /**
     * @private
     */
    static getSupportedFeatures() {
        const list = [];

        const video = document.createElement('video');
        if (
            // Check non-standard Safari PiP support
            typeof video.webkitSupportsPresentationMode === 'function' && video.webkitSupportsPresentationMode('picture-in-picture') && typeof video.webkitSetPresentationMode === 'function'
            // Check non-standard Windows PiP support
            || (window.Windows
                && Windows.UI.ViewManagement.ApplicationView.getForCurrentView()
                    .isViewModeSupported(Windows.UI.ViewManagement.ApplicationViewMode.compactOverlay))
            // Check standard PiP support
            || document.pictureInPictureEnabled
        ) {
            list.push('PictureInPicture');
        }

        if (browser.safari || browser.iOS || browser.iPad) {
            list.push('AirPlay');
        }

        if (typeof video.playbackRate === 'number') {
            list.push('PlaybackRate');
        }

        list.push('SetBrightness');
        list.push('SetAspectRatio');
        list.push('SecondarySubtitles');

        return list;
    }

    supports(feature) {
        if (!this.#supportedFeatures) {
            this.#supportedFeatures = HtmlVideoPlayer.getSupportedFeatures();
        }

        return this.#supportedFeatures.includes(feature);
    }

    // Save this for when playback stops, because querying the time at that point might return 0
    currentTime(val) {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            if (val != null) {
                const time = Math.max(0, (val / 1000) - this.getPlaybackRuntimeTimeOffset());
                const nowMs = performance.now();
                this._hlsAbrSeeking = false;
                this._hlsAbrSeekGraceUntil = nowMs + HLS_ABR_SEEK_GRACE_MS;
                this.resetHlsAbrGovernorForSeek(nowMs);
                mediaElement.currentTime = time;
                this.#currentTime = time;
                Events.trigger(this, 'timeupdate', [{ isPositionChange: true }]);
                return;
            }

            const currentTime = this.#currentTime;
            if (currentTime != null) {
                return (currentTime + this.getPlaybackRuntimeTimeOffset()) * 1000;
            }

            return ((mediaElement.currentTime || 0) + this.getPlaybackRuntimeTimeOffset()) * 1000;
        }
    }

    duration() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            const duration = mediaElement.duration;
            if (isValidDuration(duration)) {
                return duration * 1000;
            }
        }

        return null;
    }

    canSetAudioStreamIndex() {
        const video = this.#mediaElement;
        if (video) {
            return canPlaySecondaryAudio(video);
        }

        return false;
    }

    static onPictureInPictureError(err) {
        console.error(`Picture in picture error: ${err}`);
    }

    setPictureInPictureEnabled(isEnabled) {
        const video = this.#mediaElement;

        if (document.pictureInPictureEnabled) {
            if (video) {
                if (isEnabled) {
                    video.requestPictureInPicture().catch(HtmlVideoPlayer.onPictureInPictureError);
                } else {
                    document.exitPictureInPicture().catch(HtmlVideoPlayer.onPictureInPictureError);
                }
            }
        } else if (window.Windows) {
            this.isPip = isEnabled;
            if (isEnabled) {
                Windows.UI.ViewManagement.ApplicationView.getForCurrentView().tryEnterViewModeAsync(Windows.UI.ViewManagement.ApplicationViewMode.compactOverlay);
            } else {
                Windows.UI.ViewManagement.ApplicationView.getForCurrentView().tryEnterViewModeAsync(Windows.UI.ViewManagement.ApplicationViewMode.default);
            }
        } else if (video?.webkitSupportsPresentationMode && typeof video.webkitSetPresentationMode === 'function') {
            video.webkitSetPresentationMode(isEnabled ? 'picture-in-picture' : 'inline');
        }
    }

    isPictureInPictureEnabled() {
        if (document.pictureInPictureEnabled) {
            return !!document.pictureInPictureElement;
        } else if (window.Windows) {
            return this.isPip || false;
        } else {
            const video = this.#mediaElement;
            if (video) {
                return video.webkitPresentationMode === 'picture-in-picture';
            }
        }

        return false;
    }

    isAirPlayEnabled() {
        if (document.AirPlayEnabled) {
            return !!document.AirplayElement;
        }

        return false;
    }

    setAirPlayEnabled(isEnabled) {
        const video = this.#mediaElement;

        if (document.AirPlayEnabled) {
            if (video) {
                if (isEnabled) {
                    video.requestAirPlay().catch(function(err) {
                        console.error('Error requesting AirPlay', err);
                    });
                } else {
                    document.exitAirPLay().catch(function(err) {
                        console.error('Error exiting AirPlay', err);
                    });
                }
            }
        } else {
            video.webkitShowPlaybackTargetPicker();
        }
    }

    setBrightness(val) {
        const elem = this.#mediaElement;

        if (elem) {
            val = Math.max(0, val);
            val = Math.min(100, val);

            let rawValue = val;
            rawValue = Math.max(20, rawValue);

            const cssValue = rawValue >= 100 ? 'none' : (rawValue / 100);
            elem.style['-webkit-filter'] = `brightness(${cssValue})`;
            elem.style.filter = `brightness(${cssValue})`;
            elem.brightnessValue = val;
            Events.trigger(this, 'brightnesschange');
        }
    }

    getBrightness() {
        const elem = this.#mediaElement;
        if (elem) {
            const val = elem.brightnessValue;
            return val == null ? 100 : val;
        }
    }

    seekable() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            const seekable = mediaElement.seekable;
            if (seekable?.length) {
                let start = seekable.start(0);
                let end = seekable.end(0);

                if (!isValidDuration(start)) {
                    start = 0;
                }
                if (!isValidDuration(end)) {
                    end = 0;
                }

                return (end - start) > 0;
            }

            return false;
        }
    }

    pause() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            mediaElement.pause();
        }
    }

    // This is a retry after error
    resume() {
        this.unpause();
    }

    unpause() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            mediaElement.play();
        }
    }

    paused() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            return mediaElement.paused;
        }

        return false;
    }

    setPlaybackRate(value) {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            mediaElement.playbackRate = value;
        }
    }

    getPlaybackRate() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            return mediaElement.playbackRate;
        }
        return null;
    }

    getSupportedPlaybackRates() {
        return [{
            name: '0.5x',
            id: 0.5
        }, {
            name: '0.75x',
            id: 0.75
        }, {
            name: '1x',
            id: 1.0
        }, {
            name: '1.25x',
            id: 1.25
        }, {
            name: '1.5x',
            id: 1.5
        }, {
            name: '1.75x',
            id: 1.75
        }, {
            name: '2x',
            id: 2.0
        }, {
            name: '2.5x',
            id: 2.5
        }, {
            name: '3x',
            id: 3.0
        }, {
            name: '3.5x',
            id: 3.5
        }, {
            name: '4.0x',
            id: 4.0
        }];
    }

    setVolume(val) {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            mediaElement.volume = Math.pow(val / 100, 3);
        }
    }

    getVolume() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            return Math.min(Math.round(Math.pow(mediaElement.volume, 1 / 3) * 100), 100);
        }
    }

    volumeUp() {
        this.setVolume(Math.min(this.getVolume() + 2, 100));
    }

    volumeDown() {
        this.setVolume(Math.max(this.getVolume() - 2, 0));
    }

    setMute(mute) {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            mediaElement.muted = mute;
        }
    }

    isMuted() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            return mediaElement.muted;
        }
        return false;
    }

    #applyAspectRatio(val = this.getAspectRatio()) {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            if (val === 'auto') {
                mediaElement.style.removeProperty('object-fit');
            } else {
                mediaElement.style['object-fit'] = val;
            }
        }

        if (this.#currentPgsRenderer) {
            this.#currentPgsRenderer.aspectRatio = this.getPgsRenderAspectRatio(val);
        }
    }

    setAspectRatio(val) {
        appSettings.aspectRatio(val);
        this.#applyAspectRatio(val);
    }

    getAspectRatio() {
        return appSettings.aspectRatio() || 'auto';
    }

    getSupportedAspectRatios() {
        return [{
            name: globalize.translate('Auto'),
            id: 'auto'
        }, {
            name: globalize.translate('AspectRatioCover'),
            id: 'cover'
        }, {
            name: globalize.translate('AspectRatioFill'),
            id: 'fill'
        }];
    }

    togglePictureInPicture() {
        return this.setPictureInPictureEnabled(!this.isPictureInPictureEnabled());
    }

    toggleAirPlay() {
        return this.setAirPlayEnabled(!this.isAirPlayEnabled());
    }

    getBufferedRanges() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            return getBufferedRanges(this, mediaElement);
        }

        return [];
    }

    getStats() {
        const mediaElement = this.#mediaElement;
        const playOptions = this._currentPlayOptions || [];

        const categories = [];

        if (!mediaElement) {
            return Promise.resolve({
                categories: categories
            });
        }

        const mediaCategory = {
            stats: [],
            type: 'media'
        };
        categories.push(mediaCategory);

        const mediaInfos = [];
        mediaInfos.push(this._hlsPlayer || isHls(playOptions.mediaSource) ? 'HLS' : 'Video');
        if (playOptions.url) {
            //  create an anchor element (note: no need to append this element to the document)
            let link = document.createElement('a');
            //  set href to any path
            link.setAttribute('href', playOptions.url);
            const protocol = (link.protocol || '').replace(':', '');

            if (protocol) {
                mediaInfos.push(`(${protocol})`);
            }

            link = null;
        }
        if (mediaInfos.length) {
            mediaCategory.stats.push({
                label: globalize.translate('LabelStreamType'),
                value: mediaInfos.join('  ')
            });
        }

        if (this._hlsPlayer?.levels?.length) {
            const hls = this._hlsPlayer;
            const governor = this._hlsAbrGovernor;
            const level = [hls.currentLevel, hls.loadLevel, hls.nextAutoLevel, hls.firstLevel, 0]
                .find(levelIndex => Number.isInteger(levelIndex) && levelIndex >= 0);
            const bitrate = getHlsLevelBitrate(hls.levels[level]);
            const buffer = getHlsBufferedAhead(hls, mediaElement);
            const state = governor?.getState();
            const probationProbePending = Number(Boolean(state?.probationProbePending));
            const autoDetails = state ?
                ` / phase ${state.phase} / play ${hls.currentLevel} / load ${hls.loadLevel} / next ${hls.nextAutoLevel} / cap ${state.capLevel} / hcap ${hls.autoLevelCapping} / maxAuto ${hls.maxAutoLevel} / hardCap ${state.hardCapLevel} / manual ${hls.manualLevel} / loaded ${state.lastLoadedLevel} / probe ${state.probationLevel} / pending ${probationProbePending} / restore ${state.restoreCapLevel} / upTarget ${state.upTargetLevel} / votes ${state.upVotes} / refill ${state.pendingRefillFragments}/${state.lastRefillCredits} / hold ${Math.round(state.upHoldRemainingSeconds * 10) / 10}s / recovery ${Math.round(state.recoveryRemainingSeconds * 10) / 10}s / buf ${Math.round(buffer * 10) / 10}s / maxBuf ${Math.round(hls.maxBufferLength * 10) / 10}/${Math.round(hls.config.maxMaxBufferLength * 10) / 10}s / bufferFull ${this._hlsAbrBufferFullCount || 0} / low ${Math.round(state.lowBufferSeconds * 10) / 10}s / high ${Math.round(state.highBufferSeconds * 10) / 10}s / slope ${Math.round(state.bufferSlope * 100) / 100}s/s / predictedLoad ${Math.round(state.predictedCurrentLoadSeconds * 10) / 10}s / bwe ${Math.round(state.bandwidthEstimate / 100000) / 10} Mbps / service ${Math.round(state.serviceBandwidthEstimate / 100000) / 10} Mbps / ttfb ${Math.round(state.ttfbEstimateMs)}ms / samples ${state.confidence}` :
                '';
            let autoMode = 'Manual';
            if (governor) {
                autoMode = 'Governor';
            } else if (hls.autoLevelEnabled) {
                autoMode = 'hls.js';
            }
            const bitrateText = bitrate ? `${Math.round(bitrate / 100000) / 10} Mbps` : 'unknown';

            mediaCategory.stats.push({
                label: 'HLS Auto',
                value: `${autoMode} / ${level} / ${bitrateText} / ${Math.round(buffer)}s${autoDetails}`
            });
        }

        const videoCategory = {
            stats: [],
            type: 'video'
        };
        categories.push(videoCategory);

        const devicePixelRatio = window.devicePixelRatio || 1;
        const rect = mediaElement.getBoundingClientRect ? mediaElement.getBoundingClientRect() : {};
        let height = Math.round(rect.height * devicePixelRatio);
        let width = Math.round(rect.width * devicePixelRatio);

        const viewInfos = [];
        // Don't show player dimensions on smart TVs because the app UI could be lower
        // resolution than the video and this causes users to think there is a problem
        if (width && height && !browser.tv) {
            viewInfos.push(`${width}x${height}`);
        }

        height = mediaElement.videoHeight;
        width = mediaElement.videoWidth;
        if (width && height) {
            viewInfos.push(`${width}x${height}`);
        }
        if (viewInfos.length) {
            videoCategory.stats.push({
                label: globalize.translate('LabelPlayerSizes'),
                value: viewInfos.join(' / ')
            });
        }

        if (mediaElement.getVideoPlaybackQuality) {
            const playbackQuality = mediaElement.getVideoPlaybackQuality();
            const droppedVideoFrames = playbackQuality.droppedVideoFrames || 0;
            const corruptedVideoFrames = playbackQuality.corruptedVideoFrames || 0;

            const qualityInfos = [];
            qualityInfos.push(droppedVideoFrames);
            qualityInfos.push(corruptedVideoFrames);

            videoCategory.stats.push({
                label: globalize.translate('LabelPlaybackQuality'),
                value: qualityInfos.join(' / ')
            });
        }

        const audioCategory = {
            stats: [],
            type: 'audio'
        };
        categories.push(audioCategory);

        const sinkId = mediaElement.sinkId;
        if (sinkId) {
            audioCategory.stats.push({
                label: 'Sink Id:',
                value: sinkId
            });
        }

        return Promise.resolve({
            categories: categories
        });
    }
}

export default HtmlVideoPlayer;
