import type Hls from 'hls.js';
import type {
    AbrController,
    FragLoadedData,
    FragLoadingData,
    Fragment,
    MediaAttachedData
} from 'hls.js';

import { AbrPolicy, type AbrContext, type AbrDebugState, type AbrTuning } from './abrPolicy';
import { getHlsLevelBitrate, getHlsLevelTargetDuration, isHlsLevelSwitchAllowed } from './hlsLevelInfo';

export interface JellyfinAbrOptions {
    initialBandwidthEstimate?: number;
    initialBitrate?: number;
    /** Called once with each new controller, so the player can show its state. */
    onCreate?: (controller: JellyfinAbrControllerApi) => void;
    tuning?: Partial<AbrTuning>;
}

export interface JellyfinAbrDebugState extends AbrDebugState {
    bufferSeconds: number;
    highBufferSeconds: number;
    lowBufferSeconds: number;
}

export interface JellyfinAbrControllerApi {
    getDebugState(): JellyfinAbrDebugState | null;
}

type HlsClass = Pick<typeof Hls, 'DefaultConfig' | 'Events'>;
type AbrControllerClass = typeof AbrController;

function getAccessor(prototype: object, name: string) {
    let current: object | null = prototype;
    while (current) {
        const descriptor = Object.getOwnPropertyDescriptor(current, name);
        if (descriptor) {
            return descriptor;
        }
        current = Object.getPrototypeOf(current);
    }
    throw new Error(`hls.js AbrController has no ${name} accessor`);
}

function getBufferedAhead(media: HTMLMediaElement | null) {
    if (!media) {
        return 0;
    }

    const { buffered, currentTime } = media;
    for (let index = 0; index < buffered.length; index++) {
        if (buffered.start(index) <= currentTime && buffered.end(index) >= currentTime) {
            return buffered.end(index) - currentTime;
        }
    }
    return 0;
}

function isMainMediaFragment(fragment: Fragment | undefined) {
    // hls.js types say sn is a number, but init segments use the string 'initSegment'.
    return String(fragment?.type) === 'main' && typeof fragment?.sn === 'number';
}

/**
 * Builds an hls.js ABR controller class that lets AbrPolicy choose every
 * level. It keeps the hls.js bandwidth estimator and emergency abort rules,
 * and overrides only the level choice. The class is built at runtime because
 * hls.js is loaded on demand.
 */
export function createJellyfinAbrController(HlsConstructor: HlsClass, options: JellyfinAbrOptions = {}): AbrControllerClass {
    const Base = HlsConstructor.DefaultConfig.abrController;
    const { Events } = HlsConstructor;
    const baseNextAutoLevel = getAccessor(Base.prototype, 'nextAutoLevel');
    const baseFirstAutoLevel = getAccessor(Base.prototype, 'firstAutoLevel');

    class JellyfinAbrController extends Base implements JellyfinAbrControllerApi {
        private firstAfterSwitchFragments = new WeakSet<Fragment>();
        private hasPlayed = false;
        private isSeeking = false;
        private lastLoadingLevel = -1;
        private mediaElement: HTMLMediaElement | null = null;
        private policy: AbrPolicy | undefined;
        private restartPending = true;

        constructor(hls: Hls) {
            super(hls);
            hls.on(Events.MANIFEST_LOADING, this.onJellyfinManifestLoading, this);
            hls.on(Events.MANIFEST_PARSED, this.onJellyfinLevelsChanged, this);
            hls.on(Events.LEVELS_UPDATED, this.onJellyfinLevelsChanged, this);
            hls.on(Events.FRAG_LOADING, this.onJellyfinFragLoading, this);
            hls.on(Events.FRAG_LOADED, this.onJellyfinFragLoaded, this);
            hls.on(Events.MEDIA_ATTACHED, this.onJellyfinMediaAttached, this);
            hls.on(Events.MEDIA_DETACHING, this.onJellyfinMediaDetaching, this);
            options.onCreate?.(this);
        }

        destroy() {
            const { hls } = this;
            if (hls) {
                hls.off(Events.MANIFEST_LOADING, this.onJellyfinManifestLoading, this);
                hls.off(Events.MANIFEST_PARSED, this.onJellyfinLevelsChanged, this);
                hls.off(Events.LEVELS_UPDATED, this.onJellyfinLevelsChanged, this);
                hls.off(Events.FRAG_LOADING, this.onJellyfinFragLoading, this);
                hls.off(Events.FRAG_LOADED, this.onJellyfinFragLoaded, this);
                hls.off(Events.MEDIA_ATTACHED, this.onJellyfinMediaAttached, this);
                hls.off(Events.MEDIA_DETACHING, this.onJellyfinMediaDetaching, this);
            }
            this.onJellyfinMediaDetaching();
            this.policy = undefined;
            super.destroy();
        }

        get firstAutoLevel(): number {
            const policy = this.ensurePolicy();
            const context = this.getContext();
            if (!policy || !context) {
                return baseFirstAutoLevel.get?.call(this);
            }
            return policy.chooseStartLevel(context);
        }

        get nextAutoLevel(): number {
            const policy = this.ensurePolicy();
            const context = this.getContext();
            if (!policy || !context) {
                return baseNextAutoLevel.get?.call(this);
            }
            return policy.chooseLevel(context);
        }

        /** hls.js sets this for an emergency down-switch or after a load error. */
        set nextAutoLevel(level: number) {
            baseNextAutoLevel.set?.call(this, level);
            if (Number.isInteger(level) && level >= 0) {
                this.policy?.recordEmergency(level, performance.now());
            }
        }

        getDebugState(): JellyfinAbrDebugState | null {
            const context = this.getContext();
            if (!this.policy || !context) {
                return null;
            }

            const thresholds = this.policy.getBufferThresholds(context);
            return {
                ...this.policy.getDebugState(context.nowMs),
                bufferSeconds: context.bufferSeconds,
                highBufferSeconds: thresholds.high,
                lowBufferSeconds: thresholds.low
            };
        }

        private ensurePolicy() {
            const levels = this.hls?.levels;
            if (!this.policy && levels && levels.length > 1) {
                this.policy = new AbrPolicy({
                    initialBandwidthEstimate: options.initialBandwidthEstimate,
                    initialBitrate: options.initialBitrate,
                    levels: levels.map((level, index) => ({ bitrate: getHlsLevelBitrate(level), index })),
                    tuning: options.tuning
                });
            }
            return this.policy?.hasMultipleLevels ? this.policy : undefined;
        }

        private getContext(): AbrContext | null {
            const { hls } = this;
            const levels = hls?.levels;
            if (!levels?.length) {
                return null;
            }

            const media = this.mediaElement || hls.media;
            const referenceLevel = Math.min(Math.max(this.lastLoadingLevel, hls.loadLevel, 0), levels.length - 1);
            const bufferInfoLength = hls.mainForwardBufferInfo?.len;
            const { maxBufferLength, maxMaxBufferLength } = hls.config;
            return {
                bufferCapSeconds: Math.min(maxBufferLength || 0, maxMaxBufferLength || maxBufferLength || 0),
                bufferSeconds: Number.isFinite(bufferInfoLength) ? bufferInfoLength as number : getBufferedAhead(media),
                isLive: Boolean(hls.latestLevelDetails?.live),
                isSwitchAllowed: (fromLevel, toLevel) => isHlsLevelSwitchAllowed(
                    levels[fromLevel],
                    levels[toLevel],
                    toLevel > fromLevel
                ),
                maxLevel: hls.maxAutoLevel,
                minLevel: hls.minAutoLevel,
                nowMs: performance.now(),
                playbackRate: Math.abs(media?.playbackRate || 1),
                segmentDurationSeconds: getHlsLevelTargetDuration(hls, referenceLevel)
            };
        }

        private onJellyfinManifestLoading() {
            this.policy = undefined;
            this.hasPlayed = false;
            this.isSeeking = false;
            this.lastLoadingLevel = -1;
            this.restartPending = true;
        }

        private onJellyfinLevelsChanged() {
            const levels = this.hls?.levels;
            if (!levels?.length) {
                return;
            }
            if (this.policy) {
                this.policy.updateLevels(levels.map((level, index) => ({ bitrate: getHlsLevelBitrate(level), index })));
            } else {
                this.ensurePolicy();
            }
        }

        private onJellyfinFragLoading(_event: string, data: FragLoadingData) {
            const { frag } = data;
            if (!isMainMediaFragment(frag)) {
                return;
            }

            if (frag.level !== this.lastLoadingLevel || this.restartPending) {
                this.firstAfterSwitchFragments.add(frag);
            }
            this.restartPending = false;
            this.lastLoadingLevel = frag.level;
            this.policy?.recordFragmentLoading(frag.level, performance.now());
        }

        private onJellyfinFragLoaded(_event: string, data: FragLoadedData) {
            const { frag, part } = data;
            const stats = part?.stats.loaded ? part.stats : frag.stats;
            if (!this.policy || !isMainMediaFragment(frag) || stats.aborted) {
                return;
            }

            this.policy.recordFragment({
                declaredBitrate: getHlsLevelBitrate(this.hls.levels[frag.level]),
                durationSeconds: part?.duration ?? frag.duration,
                isFirstAfterSwitch: this.firstAfterSwitchFragments.has(frag),
                loadedBytes: stats.loaded,
                loadingEndMs: stats.loading.end,
                loadingFirstMs: stats.loading.first,
                loadingStartMs: stats.loading.start
            });
        }

        private onJellyfinMediaAttached(_event: string, data: MediaAttachedData) {
            this.onJellyfinMediaDetaching();
            this.mediaElement = data.media;
            this.mediaElement.addEventListener('seeking', this.onJellyfinSeeking);
            this.mediaElement.addEventListener('playing', this.onJellyfinPlaying);
            this.mediaElement.addEventListener('waiting', this.onJellyfinWaiting);
        }

        private onJellyfinMediaDetaching() {
            this.mediaElement?.removeEventListener('seeking', this.onJellyfinSeeking);
            this.mediaElement?.removeEventListener('playing', this.onJellyfinPlaying);
            this.mediaElement?.removeEventListener('waiting', this.onJellyfinWaiting);
            this.mediaElement = null;
        }

        private readonly onJellyfinSeeking = () => {
            this.isSeeking = true;
            this.restartPending = true;
        };

        private readonly onJellyfinPlaying = () => {
            this.hasPlayed = true;
            this.isSeeking = false;
        };

        private readonly onJellyfinWaiting = () => {
            const media = this.mediaElement;
            // A stall during start or a seek is expected. It says nothing about the network.
            if (!this.hasPlayed || this.isSeeking || !media || media.paused || media.seeking) {
                return;
            }

            const context = this.getContext();
            if (context) {
                this.policy?.recordStall(context);
            }
        };
    }

    return JellyfinAbrController as unknown as AbrControllerClass;
}
