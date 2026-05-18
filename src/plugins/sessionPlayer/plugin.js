import { playbackManager } from '../../components/playback/playbackmanager';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import serverNotifications from '../../scripts/serverNotifications';
import { PluginType } from '../../types/plugin.ts';
import Events from '../../utils/events.ts';
import isEqual from 'lodash-es/isEqual';

const PENDING_SEEK_TIMEOUT_MS = 15000;
const PENDING_SEEK_SETTLED_TOLERANCE_TICKS = 2 * 10000000;
const TICKS_PER_MILLISECOND = 10000;

function getActivePlayerId() {
    const info = playbackManager.getPlayerInfo();
    return info ? info.id : null;
}

function sendPlayCommand(apiClient, options, playType) {
    const sessionId = getActivePlayerId();

    const ids = options.ids || options.items.map(function (i) {
        return i.Id;
    });

    const remoteOptions = {
        ItemIds: ids.join(','),

        PlayCommand: playType
    };

    if (options.startPositionTicks) {
        remoteOptions.StartPositionTicks = options.startPositionTicks;
    }

    if (options.mediaSourceId) {
        remoteOptions.MediaSourceId = options.mediaSourceId;
    }

    if (options.audioStreamIndex != null) {
        remoteOptions.AudioStreamIndex = options.audioStreamIndex;
    }

    if (options.subtitleStreamIndex != null) {
        remoteOptions.SubtitleStreamIndex = options.subtitleStreamIndex;
    }

    if (options.startIndex != null) {
        remoteOptions.StartIndex = options.startIndex;
    }

    return apiClient.sendPlayCommand(sessionId, remoteOptions);
}

function sendPlayStateCommand(instance, command, options) {
    const apiClient = getCurrentApiClient(instance);
    const sessionId = getActivePlayerId();
    const query = {};

    if (options?.SeekPositionTicks != null) {
        query.seekPositionTicks = options.SeekPositionTicks;
    }

    if (options?.SeekOffsetTicks != null) {
        query.seekOffsetTicks = options.SeekOffsetTicks;
    }

    return apiClient.ajax({
        type: 'POST',
        url: apiClient.getUrl(`Sessions/${sessionId}/Playing/${command}`, query),
        dataType: 'json',
        headers: {
            accept: 'application/json'
        }
    }).then(session => {
        if (session) {
            processUpdatedSessions(instance, [session], apiClient);
        }

        return session || null;
    });
}

function getCurrentApiClient(instance) {
    const currentServerId = instance.currentServerId;

    if (currentServerId) {
        return ServerConnections.getApiClient(currentServerId);
    }

    return ServerConnections.currentApiClient();
}

function sendCommandByName(instance, name, options) {
    const command = {
        Name: name
    };

    if (options) {
        command.Arguments = options;
    }

    instance.sendCommand(command);
}

function unsubscribeFromPlayerUpdates(instance) {
    instance.isUpdating = true;

    const apiClient = getCurrentApiClient(instance);
    apiClient.sendMessage('SessionsStop');
    if (instance.pollInterval) {
        clearInterval(instance.pollInterval);
        instance.pollInterval = null;
    }
    if (instance.localTimeUpdateInterval) {
        clearInterval(instance.localTimeUpdateInterval);
        instance.localTimeUpdateInterval = null;
    }
    if (instance.onVisibilityChange) {
        document.removeEventListener('visibilitychange', instance.onVisibilityChange);
        instance.onVisibilityChange = null;
    }
}

async function updatePlaylist(instance, queue) {
    const options = {
        ids: queue.map(i => i.Id),
        serverId: getCurrentApiClient(instance).serverId()
    };

    const result = await playbackManager.getItemsForPlayback(options.serverId, {
        Ids: options.ids.join(',')
    });

    const items = await playbackManager.translateItemsForPlayback(result.Items, options);

    for (let i = 0; i < items.length; i++) {
        items[i].PlaylistItemId = queue[i].PlaylistItemId;
    }

    instance.playlist = items;
}

function compareQueues(q1, q2) {
    if (q1.length !== q2.length) {
        return true;
    }

    for (let i = 0; i < q1.length; i++) {
        if (q1[i].Id !== q2[i].Id || q1[i].PlaylistItemId !== q2[i].PlaylistItemId) {
            return true;
        }
    }
    return false;
}

function updateCurrentQueue(instance, session) {
    const current = session.NowPlayingQueue;
    if (instance.isUpdatingPlaylist) {
        return;
    }

    if (instance.lastPlayerData && !compareQueues(current, instance.playlist)) {
        return;
    }

    instance.isUpdatingPlaylist = true;

    const finish = () => {
        instance.isUpdatingPlaylist = false;
        instance.isPlaylistRendered = true;
    };

    updatePlaylist(instance, current).then(finish, finish);
}

function processUpdatedSessions(instance, sessions, apiClient) {
    const serverId = apiClient.serverId();

    sessions.forEach(s => {
        if (s.NowPlayingItem) {
            s.NowPlayingItem.ServerId = serverId;
        }
    });

    const currentTargetId = getActivePlayerId();

    const session = sessions.filter(function (s) {
        return s.Id === currentTargetId;
    })[0];

    if (session) {
        normalizeImages(session, apiClient);
        normalizePendingSeekPosition(instance, session);
        syncVisualPosition(instance, session);

        updateCurrentQueue(instance, session);
        const eventNames = getChangedEvents(instance.lastPlayerData, session);

        instance.lastPlayerData = session;

        eventNames.forEach(eventName => {
            Events.trigger(instance, eventName, [session]);
        });
    } else {
        instance.lastPlayerData = session;

        playbackManager.setDefaultPlayerActive();
    }
}

function normalizePendingSeekPosition(instance, session) {
    const pendingSeekPositionTicks = instance.pendingSeekPositionTicks;
    const pendingSeekDate = instance.pendingSeekDate;
    const reportedPositionTicks = session.PlayState?.PositionTicks;
    if (!Number.isFinite(pendingSeekPositionTicks) || !Number.isFinite(pendingSeekDate) || !Number.isFinite(reportedPositionTicks)) {
        return;
    }

    const seekAgeMs = Date.now() - pendingSeekDate;
    if (seekAgeMs > PENDING_SEEK_TIMEOUT_MS) {
        instance.pendingSeekPositionTicks = null;
        instance.pendingSeekDate = null;
        return;
    }

    if (Math.abs(reportedPositionTicks - pendingSeekPositionTicks) <= PENDING_SEEK_SETTLED_TOLERANCE_TICKS) {
        instance.pendingSeekPositionTicks = null;
        instance.pendingSeekDate = null;
        return;
    }

    let estimatedTicks = pendingSeekPositionTicks;
    if (!session.PlayState.IsPaused) {
        estimatedTicks += seekAgeMs * 10000 * (session.PlayState.PlaybackRate || 1);
    }

    const runtimeTicks = session.NowPlayingItem?.RunTimeTicks;
    if (runtimeTicks) {
        estimatedTicks = Math.min(estimatedTicks, runtimeTicks);
    }

    session.PlayState.PositionTicks = Math.max(0, estimatedTicks);
    session.LastPlaybackCheckIn = new Date().toISOString();
}

function syncVisualPosition(instance, state) {
    const positionTicks = state.PlayState?.PositionTicks;
    if (!Number.isFinite(positionTicks)) {
        return;
    }

    instance.visualPositionTicks = Math.max(0, positionTicks);
    instance.visualPositionUpdatedAt = Date.now();
}

function getBasicEvents(oldPlayerData, newPlayerData) {
    const names = [];
    if (oldPlayerData.PlayState.PositionTicks !== newPlayerData.PlayState.PositionTicks) {
        names.push('timeupdate');
    }
    if (oldPlayerData.PlayState.IsPaused !== newPlayerData.PlayState.IsPaused) {
        names.push(newPlayerData.PlayState.IsPaused ? 'pause' : 'unpause');
    }
    if (oldPlayerData.PlayState.IsMuted !== newPlayerData.PlayState.IsMuted
        || oldPlayerData.PlayState.VolumeLevel !== newPlayerData.PlayState.VolumeLevel) {
        names.push('volumechange');
    }
    if (oldPlayerData.PlayState.RepeatMode !== newPlayerData.PlayState.RepeatMode) {
        names.push('repeatmodechange');
    }
    return names;
}

function copyNewStateOfBasicEvents(oldPlayerData, newPlayerData) {
    const prepareOldData = (oldObject, newObject, propertyName) => {
        if (!Object.hasOwn(newObject, propertyName)) {
            delete oldObject[propertyName];
        } else {
            oldObject[propertyName] = newObject[propertyName];
        }
    };

    prepareOldData(oldPlayerData.PlayState, newPlayerData.PlayState, 'PositionTicks');
    if (oldPlayerData.TranscodingInfo) {
        // TranscodingInfo.CompletionPercentage and TranscodingInfo.Framerate change with time
        // so it's enough if we only trigger 'timeupdate' event
        prepareOldData(oldPlayerData.TranscodingInfo, newPlayerData.TranscodingInfo, 'CompletionPercentage');
        prepareOldData(oldPlayerData.TranscodingInfo, newPlayerData.TranscodingInfo, 'Framerate');
    }
    prepareOldData(oldPlayerData, newPlayerData, 'LastActivityDate');
    prepareOldData(oldPlayerData, newPlayerData, 'LastPlaybackCheckIn');
    prepareOldData(oldPlayerData.PlayState, newPlayerData.PlayState, 'IsPaused');
    prepareOldData(oldPlayerData, newPlayerData, 'LastPausedDate');
    prepareOldData(oldPlayerData.PlayState, newPlayerData.PlayState, 'IsMuted');
    prepareOldData(oldPlayerData.PlayState, newPlayerData.PlayState, 'VolumeLevel');
    prepareOldData(oldPlayerData.PlayState, newPlayerData.PlayState, 'RepeatMode');
    prepareOldData(oldPlayerData.PlayState, newPlayerData.PlayState, 'OrderMode');
}

function getChangedEvents(oldPlayerData, newPlayerData) {
    if (!oldPlayerData?.PlayState || !newPlayerData?.PlayState
        || (oldPlayerData.TranscodingInfo !== newPlayerData.TranscodingInfo && (!oldPlayerData.TranscodingInfo || !newPlayerData.TranscodingInfo))) {
        return ['statechange'];
    }

    const names = getBasicEvents(oldPlayerData, newPlayerData);
    // override the part of oldPlayerData, because it will be overwritten anyway, after this function
    copyNewStateOfBasicEvents(oldPlayerData, newPlayerData);

    if (!isEqual(oldPlayerData, newPlayerData)) {
        return ['statechange'];
    }

    return names;
}

function onPollIntervalFired() {
    const instance = this;
    refreshPlayerUpdates(instance);
}

function refreshPlayerUpdates(instance) {
    const apiClient = getCurrentApiClient(instance);
    apiClient.getSessions().then(function (sessions) {
        processUpdatedSessions(instance, sessions, apiClient);
    });
}

function onLocalTimeUpdateIntervalFired() {
    const instance = this;
    if (!document.hidden && !instance.paused() && instance.lastPlayerData?.NowPlayingItem) {
        Events.trigger(instance, 'timeupdate');
    }
}

function onVisibilityChange() {
    const instance = this;
    if (!document.hidden) {
        subscribeToPlayerUpdates(instance);
        refreshPlayerUpdates(instance);
        Events.trigger(instance, 'timeupdate');
    }
}

function getEstimatedPositionTicks(state) {
    const playState = state?.PlayState || {};
    const positionTicks = playState.PositionTicks;
    return Number.isFinite(positionTicks) ? Math.max(0, positionTicks) : positionTicks;
}

function getVisualPositionTicks(instance) {
    const state = instance.lastPlayerData;
    const basePositionTicks = Number.isFinite(instance.visualPositionTicks) ?
        instance.visualPositionTicks :
        getEstimatedPositionTicks(state);

    if (!Number.isFinite(basePositionTicks) || state?.PlayState?.IsPaused) {
        return basePositionTicks;
    }

    const updatedAt = Number.isFinite(instance.visualPositionUpdatedAt) ? instance.visualPositionUpdatedAt : Date.now();
    let positionTicks = basePositionTicks + ((Date.now() - updatedAt) * TICKS_PER_MILLISECOND);
    const runtimeTicks = state.NowPlayingItem?.RunTimeTicks;
    if (runtimeTicks) {
        positionTicks = Math.min(positionTicks, runtimeTicks);
    }

    return Math.max(0, positionTicks);
}

function setEstimatedPositionTicks(instance, positionTicks) {
    const state = instance.lastPlayerData;
    const playState = state?.PlayState;
    if (!playState) {
        return;
    }

    const runtimeTicks = state.NowPlayingItem?.RunTimeTicks;
    let updatedTicks = Math.max(0, positionTicks);
    if (runtimeTicks) {
        updatedTicks = Math.min(updatedTicks, runtimeTicks);
    }

    playState.PositionTicks = updatedTicks;
    state.LastPlaybackCheckIn = new Date().toISOString();
    instance.pendingSeekPositionTicks = updatedTicks;
    instance.pendingSeekDate = Date.now();
    syncVisualPosition(instance, state);
    Events.trigger(instance, 'timeupdate', [{ isPositionChange: true }]);
}

function setPausedState(instance, isPaused) {
    const state = instance.lastPlayerData;
    const playState = state?.PlayState;
    if (!playState) {
        return;
    }

    const positionTicks = getVisualPositionTicks(instance);
    if (Number.isFinite(positionTicks)) {
        playState.PositionTicks = positionTicks;
    }
    playState.IsPaused = isPaused;
    state.LastPlaybackCheckIn = new Date().toISOString();
    syncVisualPosition(instance, state);
    Events.trigger(instance, isPaused ? 'pause' : 'unpause', [state]);
    Events.trigger(instance, 'timeupdate', [{ isPositionChange: true }]);
}

function subscribeToSessionSocket(instance) {
    const apiClient = getCurrentApiClient(instance);
    apiClient.sendMessage('SessionsStart', '100,800');
    if (!apiClient.isMessageChannelOpen()) {
        refreshPlayerUpdates(instance);
    }
}

function subscribeToPlayerUpdates(instance) {
    instance.isUpdating = true;

    subscribeToSessionSocket(instance);
    if (instance.pollInterval) {
        clearInterval(instance.pollInterval);
        instance.pollInterval = null;
    }
    instance.pollInterval = setInterval(onPollIntervalFired.bind(instance), 5000);
    if (instance.localTimeUpdateInterval) {
        clearInterval(instance.localTimeUpdateInterval);
        instance.localTimeUpdateInterval = null;
    }
    instance.localTimeUpdateInterval = setInterval(onLocalTimeUpdateIntervalFired.bind(instance), 1000);
    if (instance.onVisibilityChange) {
        document.removeEventListener('visibilitychange', instance.onVisibilityChange);
    }
    instance.onVisibilityChange = onVisibilityChange.bind(instance);
    document.addEventListener('visibilitychange', instance.onVisibilityChange);
}

function normalizeImages(state, apiClient) {
    if (state?.NowPlayingItem) {
        const item = state.NowPlayingItem;

        if (!item.ImageTags || !item.ImageTags.Primary && item.PrimaryImageTag) {
            item.ImageTags = item.ImageTags || {};
            item.ImageTags.Primary = item.PrimaryImageTag;
        }
        if (item.BackdropImageTag && item.BackdropItemId === item.Id) {
            item.BackdropImageTags = [item.BackdropImageTag];
        }
        if (item.BackdropImageTag && item.BackdropItemId !== item.Id) {
            item.ParentBackdropImageTags = [item.BackdropImageTag];
            item.ParentBackdropItemId = item.BackdropItemId;
        }
        if (!item.ServerId) {
            item.ServerId = apiClient.serverId();
        }
    }
}

class SessionPlayer {
    lastPlaylistItemId;

    constructor() {
        const self = this;

        this.name = 'Remote Control';
        this.type = PluginType.MediaPlayer;
        this.isLocalPlayer = false;
        this.id = 'remoteplayer';

        this.playlist = [];
        this.isPlaylistRendered = true;
        this.isUpdatingPlaylist = false;

        Events.on(serverNotifications, 'Sessions', function (e, apiClient, data) {
            processUpdatedSessions(self, data, apiClient);
        });
    }

    beginPlayerUpdates() {
        this.playerListenerCount = this.playerListenerCount || 0;

        if (this.playerListenerCount <= 0) {
            this.playerListenerCount = 0;

            subscribeToPlayerUpdates(this);
        }

        this.playerListenerCount++;
    }

    endPlayerUpdates() {
        this.playerListenerCount = this.playerListenerCount || 0;
        this.playerListenerCount--;

        if (this.playerListenerCount <= 0) {
            unsubscribeFromPlayerUpdates(this);
            this.playerListenerCount = 0;
        }
    }

    getPlayerState() {
        return this.lastPlayerData || {};
    }

    getTargets() {
        const apiClient = getCurrentApiClient(this);

        const sessionQuery = {
            ControllableByUserId: apiClient.getCurrentUserId()
        };

        if (apiClient) {
            const name = this.name;

            return apiClient.getSessions(sessionQuery).then(function (sessions) {
                return sessions.filter(function (s) {
                    return s.DeviceId !== apiClient.deviceId();
                }).map(function (s) {
                    return {
                        name: s.DeviceName,
                        deviceName: s.DeviceName,
                        deviceType: s.DeviceType,
                        id: s.Id,
                        playerName: name,
                        appName: s.Client,
                        playableMediaTypes: s.PlayableMediaTypes,
                        isLocalPlayer: false,
                        supportedCommands: s.Capabilities.SupportedCommands,
                        user: s.UserId ? {
                            Id: s.UserId,
                            Name: s.UserName,
                            PrimaryImageTag: s.UserPrimaryImageTag
                        } : null
                    };
                });
            });
        } else {
            return Promise.resolve([]);
        }
    }

    sendCommand(command) {
        const sessionId = getActivePlayerId();

        const apiClient = getCurrentApiClient(this);
        apiClient.sendCommand(sessionId, command);
    }

    play(options) {
        options = Object.assign({}, options);

        if (options.items) {
            options.ids = options.items.map(function (i) {
                return i.Id;
            });

            options.items = null;
        }

        return sendPlayCommand(getCurrentApiClient(this), options, 'PlayNow');
    }

    shuffle(item) {
        sendPlayCommand(getCurrentApiClient(this), { ids: [item.Id] }, 'PlayShuffle');
    }

    instantMix(item) {
        sendPlayCommand(getCurrentApiClient(this), { ids: [item.Id] }, 'PlayInstantMix');
    }

    queue(options) {
        sendPlayCommand(getCurrentApiClient(this), options, 'PlayLast');
    }

    queueNext(options) {
        sendPlayCommand(getCurrentApiClient(this), options, 'PlayNext');
    }

    canPlayMediaType(mediaType) {
        mediaType = (mediaType || '').toLowerCase();
        return mediaType === 'audio' || mediaType === 'video';
    }

    canQueueMediaType(mediaType) {
        return this.canPlayMediaType(mediaType);
    }

    stop() {
        return sendPlayStateCommand(this, 'Stop');
    }

    nextTrack() {
        return sendPlayStateCommand(this, 'NextTrack');
    }

    previousTrack() {
        return sendPlayStateCommand(this, 'PreviousTrack');
    }

    seek(positionTicks) {
        setEstimatedPositionTicks(this, positionTicks);
        return sendPlayStateCommand(this, 'Seek',
            {
                SeekPositionTicks: positionTicks
            });
    }

    rewind(offsetMilliseconds) {
        const positionTicks = getVisualPositionTicks(this);
        const seekOffsetTicks = 0 - (offsetMilliseconds * TICKS_PER_MILLISECOND);
        if (Number.isFinite(positionTicks)) {
            setEstimatedPositionTicks(this, positionTicks + seekOffsetTicks);
        }

        return sendPlayStateCommand(this, 'SeekRelative', {
            SeekOffsetTicks: seekOffsetTicks
        });
    }

    fastForward(offsetMilliseconds) {
        const positionTicks = getVisualPositionTicks(this);
        const seekOffsetTicks = offsetMilliseconds * TICKS_PER_MILLISECOND;
        if (Number.isFinite(positionTicks)) {
            setEstimatedPositionTicks(this, positionTicks + seekOffsetTicks);
        }

        return sendPlayStateCommand(this, 'SeekRelative', {
            SeekOffsetTicks: seekOffsetTicks
        });
    }

    currentTime(val) {
        if (val != null) {
            return this.seek(val * 10000);
        }

        const positionTicks = getVisualPositionTicks(this);
        return positionTicks / 10000;
    }

    duration() {
        let state = this.lastPlayerData || {};
        state = state.NowPlayingItem || {};
        return state.RunTimeTicks;
    }

    paused() {
        let state = this.lastPlayerData || {};
        state = state.PlayState || {};
        return state.IsPaused;
    }

    getVolume() {
        let state = this.lastPlayerData || {};
        state = state.PlayState || {};
        return state.VolumeLevel;
    }

    isMuted() {
        let state = this.lastPlayerData || {};
        state = state.PlayState || {};
        return state.IsMuted;
    }

    pause() {
        setPausedState(this, true);
        return sendPlayStateCommand(this, 'Pause');
    }

    unpause() {
        setPausedState(this, false);
        return sendPlayStateCommand(this, 'Unpause');
    }

    playPause() {
        setPausedState(this, !this.paused());
        return sendPlayStateCommand(this, 'PlayPause');
    }

    setMute(isMuted) {
        if (isMuted) {
            sendCommandByName(this, 'Mute');
        } else {
            sendCommandByName(this, 'Unmute');
        }
    }

    toggleMute() {
        sendCommandByName(this, 'ToggleMute');
    }

    setVolume(vol) {
        sendCommandByName(this, 'SetVolume', {
            Volume: vol
        });
    }

    volumeUp() {
        sendCommandByName(this, 'VolumeUp');
    }

    volumeDown() {
        sendCommandByName(this, 'VolumeDown');
    }

    toggleFullscreen() {
        sendCommandByName(this, 'ToggleFullscreen');
    }

    audioTracks() {
        let state = this.lastPlayerData || {};
        state = state.NowPlayingItem || {};
        const streams = state.MediaStreams || [];
        return streams.filter(function (s) {
            return s.Type === 'Audio';
        });
    }

    getAudioStreamIndex() {
        let state = this.lastPlayerData || {};
        state = state.PlayState || {};
        return state.AudioStreamIndex;
    }

    playTrailers(item) {
        sendCommandByName(this, 'PlayTrailers', {
            ItemId: item.Id
        });
    }

    setAudioStreamIndex(index) {
        sendCommandByName(this, 'SetAudioStreamIndex', {
            Index: index
        });
    }

    subtitleTracks() {
        let state = this.lastPlayerData || {};
        state = state.NowPlayingItem || {};
        const streams = state.MediaStreams || [];
        return streams.filter(function (s) {
            return s.Type === 'Subtitle';
        });
    }

    getSubtitleStreamIndex() {
        let state = this.lastPlayerData || {};
        state = state.PlayState || {};
        return state.SubtitleStreamIndex;
    }

    setSubtitleStreamIndex(index) {
        sendCommandByName(this, 'SetSubtitleStreamIndex', {
            Index: index
        });
    }

    setRepeatMode(mode) {
        sendCommandByName(this, 'SetRepeatMode', {
            RepeatMode: mode
        });
    }

    getRepeatMode() {
        // not supported?
    }

    setQueueShuffleMode(mode) {
        sendCommandByName(this, 'SetShuffleQueue', {
            ShuffleMode: mode
        });
    }

    getQueueShuffleMode() {
        // not supported?
    }

    displayContent(options) {
        sendCommandByName(this, 'DisplayContent', options);
    }

    isPlaying(mediaType) {
        const state = this.lastPlayerData || {};
        return state.NowPlayingItem != null && (state.NowPlayingItem.MediaType === mediaType || !mediaType);
    }

    isPlayingVideo() {
        let state = this.lastPlayerData || {};
        state = state.NowPlayingItem || {};
        return state.MediaType === 'Video';
    }

    isPlayingAudio() {
        let state = this.lastPlayerData || {};
        state = state.NowPlayingItem || {};
        return state.MediaType === 'Audio';
    }

    getTrackIndex(playlistItemId) {
        for (let i = 0; i < this.playlist.length; i++) {
            if (this.playlist[i].PlaylistItemId === playlistItemId) {
                return i;
            }
        }
    }

    getPlaylist() {
        let itemId;

        if (this.lastPlayerData) {
            itemId = this.lastPlayerData.PlaylistItemId;
        }

        if (this.playlist.length > 0 && (this.isPlaylistRendered || itemId !== this.lastPlaylistItemId)) {
            this.isPlaylistRendered = false;
            this.lastPlaylistItemId = itemId;
            return Promise.resolve(this.playlist);
        }
        return Promise.resolve([]);
    }

    movePlaylistItem(playlistItemId, newIndex) {
        const index = this.getTrackIndex(playlistItemId);
        if (index === newIndex) return;

        const current = this.getCurrentPlaylistItemId();
        let currentIndex = 0;

        if (current === playlistItemId) {
            currentIndex = newIndex;
        }

        const append = (newIndex + 1 >= this.playlist.length);

        if (newIndex > index) newIndex++;

        const ids = [];
        const item = this.playlist[index];

        for (let i = 0; i < this.playlist.length; i++) {
            if (i === index) continue;

            if (i === newIndex) {
                ids.push(item.Id);
            }

            if (this.playlist[i].PlaylistItemId === current) {
                currentIndex = ids.length;
            }

            ids.push(this.playlist[i].Id);
        }

        if (append) {
            ids.push(item.Id);
        }

        const options = {
            ids,
            startIndex: currentIndex
        };

        return sendPlayCommand(getCurrentApiClient(this), options, 'PlayNow');
    }

    getCurrentPlaylistItemId() {
        return this.lastPlayerData.PlaylistItemId;
    }

    setCurrentPlaylistItem(playlistItemId) {
        const options = {
            ids: this.playlist.map(i => i.Id),
            startIndex: this.getTrackIndex(playlistItemId)
        };
        return sendPlayCommand(getCurrentApiClient(this), options, 'PlayNow');
    }

    removeFromPlaylist() {
        return Promise.resolve();
    }

    tryPair() {
        return Promise.resolve();
    }
}

export default SessionPlayer;
