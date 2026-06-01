import { Credentials, ApiClient } from 'jellyfin-apiclient';

import { appHost } from 'components/apphost';
import appSettings from 'scripts/settings/appSettings';
import { setUserInfo } from 'scripts/settings/userSettings';
import Dashboard from 'utils/dashboard';
import Events from 'utils/events.ts';
import { toApi } from 'utils/jellyfin-apiclient/compat';

import ConnectionManager from './connectionManager';

const normalizeImageOptions = options => {
    if (!options.quality && (options.maxWidth || options.width || options.maxHeight || options.height || options.fillWidth || options.fillHeight)) {
        options.quality = 90;
    }
};

const MAX_BITRATE = 2147483647;
const LAN_BITRATE = 140000000;
const BITRATE_CACHE_DURATION = 60 * 60 * 1000;

const getMaxBandwidth = () => {
    if (navigator.connection) {
        let max = navigator.connection.downlinkMax;
        if (max && max > 0 && max < Number.POSITIVE_INFINITY) {
            max *= 1000000;
            max *= 0.7;
            return parseInt(max, 10);
        }
    }

    return null;
};

const normalizeBitrate = (apiClient, bitrate) => {
    if (!bitrate) {
        if (apiClient.lastDetectedBitrate) {
            return apiClient.lastDetectedBitrate;
        }

        return null;
    }

    let result = Math.min(Math.round(bitrate * 0.7), MAX_BITRATE);
    const maxRate = getMaxBandwidth();

    if (maxRate) {
        result = Math.min(result, maxRate);
    }

    apiClient.lastDetectedBitrate = result;
    apiClient.lastDetectedBitrateTime = Date.now();

    return result;
};

const detectBitrate = apiClient => async force => {
    if (!force && apiClient.lastDetectedBitrate && Date.now() - (apiClient.lastDetectedBitrateTime || 0) <= BITRATE_CACHE_DURATION) {
        return apiClient.lastDetectedBitrate;
    }

    let endpointInfo = {};
    try {
        endpointInfo = await apiClient.getEndpointInfo();
    } catch {
        // Preserve the upstream behavior: bitrate detection can continue without endpoint info.
    }

    const tests = [1000000, 3000000, 10000000];
    let bestBitrate = 0;

    for (const byteSize of tests) {
        try {
            bestBitrate = Math.max(bestBitrate, await apiClient.getDownloadSpeed(byteSize));
        } catch {
            break;
        }
    }

    let result = normalizeBitrate(apiClient, bestBitrate);

    if (endpointInfo.IsInNetwork) {
        result = Math.max(result || 0, LAN_BITRATE);
        apiClient.lastDetectedBitrate = result;
        apiClient.lastDetectedBitrateTime = Date.now();
    }

    if (!result) {
        return Promise.reject();
    }

    return result;
};

class ServerConnections extends ConnectionManager {
    firstConnection = false;

    constructor() {
        super(...arguments);
        this.localApiClient = null;
        this.firstConnection = null;

        Events.on(this, 'localusersignedout', (_e, logoutInfo) => {
            setUserInfo(null, null);
            // Ensure the updated credentials are persisted to storage
            credentialProvider.credentials(credentialProvider.credentials());

            if (window.NativeShell && typeof window.NativeShell.onLocalUserSignedOut === 'function') {
                window.NativeShell.onLocalUserSignedOut(logoutInfo);
            }
        });

        Events.on(this, 'apiclientcreated', (_e, apiClient) => {
            apiClient.getMaxBandwidth = getMaxBandwidth;
            apiClient.normalizeImageOptions = normalizeImageOptions;
            apiClient.detectBitrate = detectBitrate(apiClient);
        });
    }

    initApiClient(server) {
        console.debug('creating ApiClient singleton');

        const apiClient = new ApiClient(
            server,
            appHost.appName(),
            appHost.appVersion(),
            appHost.deviceName(),
            appHost.deviceId()
        );

        apiClient.enableAutomaticNetworking = false;
        apiClient.manualAddressOnly = true;

        this.addApiClient(apiClient);

        this.setLocalApiClient(apiClient);

        console.debug('loaded ApiClient singleton');
    }

    /**
     * @returns {Promise<import('jellyfin-apiclient').ConnectResponse>} The result of the connection attempt.
     */
    connect(options) {
        return super.connect({
            enableAutoLogin: appSettings.enableAutoLogin(),
            ...options
        });
    }

    setLocalApiClient(apiClient) {
        if (apiClient) {
            this.localApiClient = apiClient;
            window.ApiClient = apiClient;
        }
    }

    getLocalApiClient() {
        return this.localApiClient;
    }

    /**
     * Gets the ApiClient that is currently connected.
     * @returns {ApiClient|undefined} apiClient
     */
    currentApiClient() {
        let apiClient = this.getLocalApiClient();

        if (!apiClient) {
            const server = this.getLastUsedServer();

            if (server) {
                apiClient = this.getApiClient(server.Id);
            }
        }

        return apiClient;
    }

    /**
     * Gets the Api that is currently connected.
     * @returns {import(@jellyfin/sdk).Api|undefined} The current Api instance.
     */
    getCurrentApi() {
        const apiClient = this.currentApiClient();
        if (!apiClient) return;

        return toApi(apiClient);
    }

    /**
     * Gets the ApiClient that is currently connected or throws if not defined.
     * @async
     * @returns {Promise<ApiClient>} The current ApiClient instance.
     */
    async getCurrentApiClientAsync() {
        const apiClient = this.currentApiClient();
        if (!apiClient) throw new Error('[ServerConnection] No current ApiClient instance');

        return apiClient;
    }

    onLocalUserSignedIn(user) {
        const apiClient = this.getApiClient(user.ServerId);
        this.setLocalApiClient(apiClient);
        return setUserInfo(user.Id, apiClient).then(() => {
            if (window.NativeShell && typeof window.NativeShell.onLocalUserSignedIn === 'function') {
                return window.NativeShell.onLocalUserSignedIn(user, apiClient.accessToken());
            }
            return Promise.resolve();
        });
    }
}

const credentialProvider = new Credentials();

const capabilities = Dashboard.capabilities(appHost);

export default new ServerConnections(
    credentialProvider,
    appHost.appName(),
    appHost.appVersion(),
    appHost.deviceName(),
    appHost.deviceId(),
    capabilities);
