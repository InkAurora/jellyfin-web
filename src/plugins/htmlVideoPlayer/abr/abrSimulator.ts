/**
 * A small HLS playback simulator for ABR tests. It models one network link,
 * a transcoding server, the hls.js loader (buffer limit, emergency abort) and
 * the media element (stalls, seeks, pauses, playback rate). Time moves in
 * fixed steps, so every run is deterministic.
 */

const STEP_MS = 50;
const ABANDON_CHECK_MS = 100;
const RESUME_BUFFER_SECONDS = 0.5;
const DECODER_FREEZE_MS = 500;

export type SimMediaEvent = 'waiting' | 'seeking' | 'seeked' | 'playing' | 'pause' | 'play';

export interface SimContext {
    bufferSeconds: number;
    bufferCapSeconds: number;
    /** The level of the last fragment that started to load, -1 before the first one. */
    currentLevel: number;
    isLive: boolean;
    isPaused: boolean;
    isSeeking: boolean;
    levels: number[];
    nowMs: number;
    playbackRate: number;
    segmentDurationSeconds: number;
}

export interface SimFragment {
    declaredBitrate: number;
    durationSeconds: number;
    isFirstAfterSwitch: boolean;
    level: number;
    loadedBytes: number;
    loadingEndMs: number;
    loadingFirstMs: number;
    loadingStartMs: number;
}

export interface SimAlgorithm {
    readonly name: string;
    /** The forward buffer limit the player uses at this level. */
    getBufferCapSeconds(levelBitrate: number, context: SimContext): number;
    chooseLevel(context: SimContext): number;
    onEmergency?(newLevel: number, failedLevel: number, context: SimContext): void;
    onFragmentBuffered?(fragment: SimFragment, context: SimContext): void;
    onFragmentLoaded?(fragment: SimFragment, context: SimContext): void;
    onFragmentLoading?(level: number, context: SimContext): void;
    onMediaEvent?(event: SimMediaEvent, context: SimContext): void;
    onTick?(context: SimContext): void;
}

export interface SimScenario {
    /** Bits/s at a time in seconds. */
    bandwidth: (seconds: number) => number;
    /** Seconds of buffer the player reports late after an append (WebKit). */
    bufferReportDelayMs?: number;
    /** Times (seconds) of `waiting` events that do not come from the network. */
    decoderStalls?: number[];
    durationSeconds: number;
    initialBandwidthEstimate?: number;
    isLive?: boolean;
    latencyMs?: number;
    levels: number[];
    name: string;
    pauses?: Array<{ atSeconds: number; durationSeconds: number }>;
    playbackRate?: number;
    seeks?: Array<{ atSeconds: number; toSeconds: number }>;
    segmentDurationSeconds: number;
    /** Extra server delay on the first fragment after a level change or seek. */
    switchPenaltyMs?: number;
    /** Transcode speed (x realtime) for a level. Undefined means the segments are ready. */
    transcodeSpeed?: (level: number) => number | undefined;
    /** Size factor for a segment number (1 = declared bitrate). */
    vbr?: (segment: number) => number;
}

export interface SimMetrics {
    averageBitrate: number;
    decoderStalls: number;
    downSwitches: number;
    emergencies: number;
    levelTimeline: Array<{ atSeconds: number; level: number }>;
    maxBufferCapSeconds: number;
    minBufferCapSeconds: number;
    stallCount: number;
    stallSeconds: number;
    startupMs: number;
    switches: number;
    timeToTopSeconds: number;
    upSwitches: number;
}

interface ActiveLoad {
    bytesLoaded: number;
    bytesTotal: number;
    firstByteAtMs: number;
    isFirstAfterSwitch: boolean;
    level: number;
    nextAbandonCheckMs: number;
    segment: number;
    startMs: number;
}

interface ServerState {
    lastSegment: number;
    level: number;
    restartAtMs: number;
    startSegment: number;
}

type PlayState = 'starting' | 'playing' | 'stalled' | 'paused' | 'seeking' | 'frozen';

export function runSimulation(scenario: SimScenario, algorithm: SimAlgorithm): SimMetrics {
    const segmentDuration = scenario.segmentDurationSeconds;
    const playbackRate = scenario.playbackRate || 1;
    const latencyMs = scenario.latencyMs ?? 50;
    const levels = scenario.levels;
    const topLevel = levels.length - 1;
    const isLive = Boolean(scenario.isLive);
    // A live stream starts three segments behind the live edge.
    const liveStartEdge = 10 * segmentDuration;

    let nowMs = 0;
    let playhead = isLive ? liveStartEdge - (3 * segmentDuration) : 0;
    let bufferedEnd = Math.floor(playhead / segmentDuration) * segmentDuration;
    let playState: PlayState = 'starting';
    let stateBeforePause: PlayState = 'playing';
    let frozenUntilMs = 0;
    let pauseUntilMs = 0;
    let hasStarted = false;
    let currentLevel = -1;
    let load: ActiveLoad | undefined;
    let server: ServerState | undefined;
    let ttfbEstimateMs = latencyMs;
    let restartPending = true;
    // hls.js keeps its own bandwidth estimate for the emergency rule.
    let bandwidthEstimate = scenario.initialBandwidthEstimate || 6_000_000;
    const segmentLevels = new Map<number, number>();
    const appendTimes: Array<{ atMs: number; end: number }> = [];

    const metrics: SimMetrics = {
        averageBitrate: 0,
        decoderStalls: 0,
        downSwitches: 0,
        emergencies: 0,
        levelTimeline: [],
        maxBufferCapSeconds: 0,
        minBufferCapSeconds: Number.POSITIVE_INFINITY,
        stallCount: 0,
        stallSeconds: 0,
        startupMs: -1,
        switches: 0,
        timeToTopSeconds: -1,
        upSwitches: 0
    };
    let playedBits = 0;
    let playedSeconds = 0;

    const seeks = [...(scenario.seeks || [])];
    const pauses = [...(scenario.pauses || [])];
    const decoderStalls = [...(scenario.decoderStalls || [])];

    function reportedBufferedEnd() {
        const delayMs = scenario.bufferReportDelayMs || 0;
        if (!delayMs) {
            return bufferedEnd;
        }
        let end = bufferedEnd;
        for (let index = appendTimes.length - 1; index >= 0; index--) {
            if (nowMs - appendTimes[index].atMs < delayMs) {
                end = Math.min(end, appendTimes[index].end - segmentDuration);
            }
        }
        return end;
    }

    function context(): SimContext {
        const levelBitrate = levels[Math.max(currentLevel, 0)];
        const partial: SimContext = {
            bufferSeconds: Math.max(reportedBufferedEnd() - playhead, 0),
            bufferCapSeconds: 0,
            currentLevel,
            isLive,
            isPaused: playState === 'paused',
            isSeeking: playState === 'seeking',
            levels,
            nowMs,
            playbackRate,
            segmentDurationSeconds: segmentDuration
        };
        partial.bufferCapSeconds = algorithm.getBufferCapSeconds(levelBitrate, partial);
        return partial;
    }

    function emit(event: SimMediaEvent) {
        algorithm.onMediaEvent?.(event, context());
    }

    function liveEdge() {
        return liveStartEdge + (nowMs / 1000);
    }

    function serverDelayMs(level: number, segment: number) {
        let penaltyMs = 0;
        if (!server || server.level !== level || segment !== server.lastSegment + 1) {
            // Jellyfin restarts the transcoder on a level change or a seek.
            server = { lastSegment: segment, level, restartAtMs: nowMs, startSegment: segment };
            penaltyMs = scenario.switchPenaltyMs || 0;
        }
        server.lastSegment = segment;
        const speed = scenario.transcodeSpeed?.(level);
        if (!speed) {
            return penaltyMs;
        }

        const readyAtMs = server.restartAtMs
            + ((segment - server.startSegment + 1) * segmentDuration * 1000 / speed);
        return penaltyMs + Math.max(readyAtMs - nowMs, 0);
    }

    function startLoad() {
        const segment = Math.floor((bufferedEnd + 0.001) / segmentDuration);
        if (isLive && (segment + 1) * segmentDuration > liveEdge()) {
            return;
        }

        const ctx = context();
        if (ctx.bufferSeconds >= ctx.bufferCapSeconds && hasStarted) {
            return;
        }

        const level = Math.min(Math.max(algorithm.chooseLevel(ctx), 0), topLevel);
        const isFirstAfterSwitch = level !== currentLevel || restartPending;
        restartPending = false;
        if (level !== currentLevel && currentLevel >= 0) {
            metrics.switches += 1;
            if (level > currentLevel) {
                metrics.upSwitches += 1;
            } else {
                metrics.downSwitches += 1;
            }
        }
        if (level !== currentLevel) {
            metrics.levelTimeline.push({ atSeconds: nowMs / 1000, level });
        }
        if (level === topLevel && metrics.timeToTopSeconds < 0) {
            metrics.timeToTopSeconds = nowMs / 1000;
        }
        currentLevel = level;
        const vbr = scenario.vbr?.(segment) ?? 1;
        load = {
            bytesLoaded: 0,
            bytesTotal: Math.round(levels[level] * segmentDuration * vbr / 8),
            firstByteAtMs: nowMs + latencyMs + serverDelayMs(level, segment),
            isFirstAfterSwitch,
            level,
            nextAbandonCheckMs: nowMs + ABANDON_CHECK_MS,
            segment,
            startMs: nowMs
        };
        algorithm.onFragmentLoading?.(level, context());
        metrics.maxBufferCapSeconds = Math.max(metrics.maxBufferCapSeconds, ctx.bufferCapSeconds);
        metrics.minBufferCapSeconds = Math.min(metrics.minBufferCapSeconds, ctx.bufferCapSeconds);
    }

    function finishLoad(active: ActiveLoad) {
        const fragment: SimFragment = {
            declaredBitrate: levels[active.level],
            durationSeconds: segmentDuration,
            isFirstAfterSwitch: active.isFirstAfterSwitch,
            level: active.level,
            loadedBytes: active.bytesTotal,
            loadingEndMs: nowMs,
            loadingFirstMs: active.firstByteAtMs,
            loadingStartMs: active.startMs
        };
        ttfbEstimateMs = (0.8 * ttfbEstimateMs) + (0.2 * (active.firstByteAtMs - active.startMs));
        const sampleRate = active.bytesTotal * 8000 / Math.max(nowMs - active.firstByteAtMs, STEP_MS);
        bandwidthEstimate = (0.7 * bandwidthEstimate) + (0.3 * sampleRate);
        load = undefined;
        algorithm.onFragmentLoaded?.(fragment, context());
        segmentLevels.set(active.segment, active.level);
        bufferedEnd = Math.max(bufferedEnd, (active.segment + 1) * segmentDuration);
        appendTimes.push({ atMs: nowMs, end: bufferedEnd });
        while (appendTimes.length && nowMs - appendTimes[0].atMs > 10_000) {
            appendTimes.shift();
        }
        algorithm.onFragmentBuffered?.(fragment, context());
    }

    // Close to hls.js AbrController._abandonRulesCheck.
    function checkAbandon(active: ActiveLoad) {
        if (playState !== 'playing' || active.level === 0) {
            return;
        }

        const timeLoadingMs = nowMs - active.startMs;
        if (timeLoadingMs <= Math.max(ttfbEstimateMs, 1000 * segmentDuration / (2 * playbackRate))) {
            return;
        }

        const starvationSeconds = Math.max(bufferedEnd - playhead, 0) / playbackRate;
        const streamingMs = nowMs - active.firstByteAtMs;
        const loadRate = active.bytesLoaded > 0 && streamingMs > 0 ? active.bytesLoaded * 8000 / streamingMs : 0;
        const remainingSeconds = loadRate ?
            (active.bytesTotal - active.bytesLoaded) * 8 / loadRate :
            (active.bytesTotal * 8 / bandwidthEstimate) + (ttfbEstimateMs / 1000);
        if (remainingSeconds <= starvationSeconds) {
            return;
        }

        const bandwidth = loadRate || bandwidthEstimate;
        let nextLevel = active.level - 1;
        let nextDelaySeconds = Number.POSITIVE_INFINITY;
        for (; nextLevel > 0; nextLevel--) {
            nextDelaySeconds = (ttfbEstimateMs / 1000) + (segmentDuration * levels[nextLevel] / bandwidth);
            if (nextDelaySeconds < Math.min(starvationSeconds, segmentDuration + (ttfbEstimateMs / 1000))) {
                break;
            }
        }
        if (nextLevel === 0) {
            nextDelaySeconds = (ttfbEstimateMs / 1000) + (segmentDuration * levels[0] / bandwidth);
        }
        if (nextDelaySeconds >= remainingSeconds || nextDelaySeconds > segmentDuration * 10) {
            return;
        }

        metrics.emergencies += 1;
        load = undefined;
        algorithm.onEmergency?.(nextLevel, active.level, context());
    }

    function stepLoad() {
        if (!load) {
            return;
        }

        if (nowMs >= load.nextAbandonCheckMs) {
            load.nextAbandonCheckMs = nowMs + ABANDON_CHECK_MS;
            checkAbandon(load);
            if (!load) {
                return;
            }
        }
        if (nowMs < load.firstByteAtMs) {
            return;
        }

        const bits = scenario.bandwidth(nowMs / 1000) * STEP_MS / 1000;
        load.bytesLoaded = Math.min(load.bytesLoaded + (bits / 8), load.bytesTotal);
        if (load.bytesLoaded >= load.bytesTotal) {
            finishLoad(load);
        }
    }

    function resumeWhenBuffered(buffer: number) {
        if (playState === 'stalled') {
            metrics.stallSeconds += STEP_MS / 1000;
        }
        if (buffer < RESUME_BUFFER_SECONDS) {
            return;
        }
        if (playState === 'seeking') {
            emit('seeked');
        }
        playState = 'playing';
        if (!hasStarted) {
            hasStarted = true;
            metrics.startupMs = nowMs;
        }
        emit('playing');
    }

    function resumeAfterFreezeOrPause() {
        if (playState === 'frozen' && nowMs >= frozenUntilMs) {
            playState = 'playing';
            emit('playing');
        } else if (playState === 'paused' && nowMs >= pauseUntilMs) {
            playState = stateBeforePause;
            emit('play');
            if (playState === 'playing') {
                emit('playing');
            }
        }
    }

    function advancePlayhead(buffer: number) {
        const advance = Math.min(playbackRate * STEP_MS / 1000, Math.max(buffer, 0));
        const level = segmentLevels.get(Math.floor(playhead / segmentDuration));
        if (level != null) {
            playedBits += levels[level] * advance;
            playedSeconds += advance;
        }
        playhead += advance;
        if (bufferedEnd - playhead <= 0.001) {
            playState = 'stalled';
            metrics.stallCount += 1;
            emit('waiting');
        }
    }

    function stepPlayback() {
        const buffer = bufferedEnd - playhead;
        if (playState === 'starting' || playState === 'stalled' || playState === 'seeking') {
            resumeWhenBuffered(buffer);
        } else if (playState === 'frozen' || playState === 'paused') {
            resumeAfterFreezeOrPause();
        } else {
            advancePlayhead(buffer);
        }
    }

    function handleScheduledEvents() {
        const seconds = nowMs / 1000;
        if (seeks.length && seconds >= seeks[0].atSeconds) {
            const seek = seeks.shift() as { atSeconds: number; toSeconds: number };
            load = undefined;
            restartPending = true;
            emit('seeking');
            playhead = seek.toSeconds;
            bufferedEnd = Math.floor(playhead / segmentDuration) * segmentDuration;
            segmentLevels.clear();
            appendTimes.length = 0;
            playState = 'seeking';
            emit('waiting');
        }
        if (pauses.length && seconds >= pauses[0].atSeconds && playState === 'playing') {
            const pause = pauses.shift() as { atSeconds: number; durationSeconds: number };
            stateBeforePause = 'playing';
            pauseUntilMs = nowMs + (pause.durationSeconds * 1000);
            playState = 'paused';
            emit('pause');
        }
        if (decoderStalls.length && seconds >= decoderStalls[0]) {
            decoderStalls.shift();
            if (playState === 'playing') {
                metrics.decoderStalls += 1;
                playState = 'frozen';
                frozenUntilMs = nowMs + DECODER_FREEZE_MS;
                emit('waiting');
            }
        }
    }

    const endMs = scenario.durationSeconds * 1000;
    let nextTickMs = 0;
    for (; nowMs < endMs; nowMs += STEP_MS) {
        handleScheduledEvents();
        if (!load) {
            startLoad();
        }
        stepLoad();
        stepPlayback();
        if (nowMs >= nextTickMs) {
            nextTickMs = nowMs + 100;
            algorithm.onTick?.(context());
        }
    }

    metrics.averageBitrate = playedSeconds ? playedBits / playedSeconds : 0;
    if (!Number.isFinite(metrics.minBufferCapSeconds)) {
        metrics.minBufferCapSeconds = 0;
    }
    return metrics;
}
