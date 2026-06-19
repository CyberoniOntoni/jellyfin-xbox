(function (appName, appVersion, deviceName, supportsHdr10, supportsDolbyVision) {
    'use strict';

    console.log('Windows UWP adapter');

    const xbox = deviceName.toLowerCase().indexOf('xbox') !== -1;
    const xboxSeries = deviceName.toLowerCase().indexOf('xbox series') !== -1;
    const mobile = deviceName.toLowerCase().indexOf('mobile') !== -1;

    function postMessage(type, args = {}) {
        console.debug(`AppHost.${type}`, args);
        const payload = {
            'type': type,
            'args': args
        };

        window.chrome.webview.postMessage(JSON.stringify(payload));
    }

    const AppInfo = {
        deviceName: deviceName,
        appName: appName,
        appVersion: appVersion
    };

    // List of supported features
    const SupportedFeatures = [
        'displaylanguage',
        'displaymode',
        'exit',
        'exitmenu',
        'externallinkdisplay',
        'externallinks',
        'htmlaudioautoplay',
        'htmlvideoautoplay',
        'multiserver',
        'otherapppromotions',
        'screensaver',
        'subtitleappearancesettings',
        'subtitleburnsettings',
        'targetblank'
    ];

    if (xbox || mobile) {
        SupportedFeatures.push('physicalvolumecontrol');
    }

    SupportedFeatures.push('clientsettings');

    console.debug('SupportedFeatures', SupportedFeatures);

    window.NativeShell = {
        AppHost: {
            init: function () {
                console.debug('AppHost.init', AppInfo);
                return Promise.resolve(AppInfo);
            },

            appName: function () {
                console.debug('AppHost.appName', AppInfo.appName);
                return AppInfo.appName;
            },

            appVersion: function () {
                console.debug('AppHost.appVersion', AppInfo.appVersion);
                return AppInfo.appVersion;
            },

            deviceName: function () {
                console.debug('AppHost.deviceName', AppInfo.deviceName);
                return AppInfo.deviceName;
            },

            exit: function () {
                postMessage('exit');
            },

            getDefaultLayout: function () {
                let layout;
                if (xbox) {
                    layout = 'tv';
                } else if (mobile) {
                    layout = 'mobile';
                } else {
                    layout = 'desktop';
                }
                console.debug('AppHost.getDefaultLayout', layout);
                return layout;
            },

            getDeviceProfile: function (profileBuilder) {
                console.debug('AppHost.getDeviceProfile');
                const options = {};
                if (supportsHdr10 != null) {
                    options.supportsHdr10 = supportsHdr10;
                }
                if (supportsDolbyVision != null) {
                    options.supportsDolbyVision = supportsDolbyVision;
                }
                if (xboxSeries) {
                    options.maxVideoWidth = 3840;
                }
                return profileBuilder(options);
            },

            supports: function (command) {
                const isSupported = command && SupportedFeatures.indexOf(command.toLowerCase()) !== -1;
                console.debug('AppHost.supports', {
                    command: command,
                    isSupported: isSupported
                });
                return isSupported;
            }
        },

        enableFullscreen: function (videoInfo) {
        },

        disableFullscreen: function () {
            postMessage('disableFullscreen');
        },

        getPlugins: function () {
            console.debug('getPlugins');
            postMessage('loaded');
            return ["UwpXboxHdmiSetupPlugin", "UwpSubtitleResumeSyncPlugin"];
        },

        selectServer: function () {
            postMessage('selectServer');
        },

        openClientSettings: function () {
            postMessage('openClientSettings');
        }
    };
})(APP_NAME, APP_VERSION, DEVICE_NAME, SUPPORTS_HDR, SUPPORTS_DOVI);


/**
 * Plugin build to toggle attached HDMI monitors
 * Follows: https://github.com/jellyfin/jellyfin-web/blob/master/src/types/plugin.ts
 */
class UwpXboxHdmiSetupPlugin {
    constructor(pluginOptions) {
        this.name = "UwpXboxHdmiSetupPlugin";
        this.id = "UwpXboxHdmiSetupPlugin";
        this.type = "preplayintercept";
        this.priority = 0;
        this.PluginOptions = pluginOptions;
    }

    async intercept(options) {
        const item = options.item;
        if (!item) {
            return;
        }
        if ("mediaSourceId" in options) {
            const mediaSourceid = options.mediaSourceId;
            var mediaStreams = null;
            var mediaSource = null;

            if (item.MediaSources == null) {
                const apiClient = this.PluginOptions.ServerConnections.getApiClient(item.ServerId);
                const isLiveTv = ["TvChannel", "LiveTvChannel"].includes(item.Type);
                mediaStreams = isLiveTv ? null : await apiClient.getItem(apiClient.getCurrentUserId(), mediaSourceid || item.Id)
                    .then(fullItem => {
                        mediaSource = fullItem;
                        return fullItem.MediaStreams;
                    });
            }
            else {
                mediaSource = item.MediaSources.find(e => e.Id == mediaSourceid);
                if (mediaSource == null) {
                    return;
                }
                mediaStreams = mediaSource.MediaStreams;
            }

            if (mediaStreams == null || mediaStreams.length == 0) {
                return;
            }

            const stream = mediaStreams.find(s => s.Type === 'Video');

            if (stream == null) {
                return;
            }

            const payload = {
                'type': "enableFullscreen",
                'args': {
                    'videoWidth': stream.Width,
                    'videoHeight': stream.Height,
                    'videoFrameRate': (stream.AverageFrameRate || stream.RealFrameRate),
                    'videoRangeType': stream.VideoRangeType
                }
            };

            window.chrome.webview.postMessage(JSON.stringify(payload));
            await new Promise(resolve => setTimeout(resolve, 3000)); // wait 3 sec before continuing with playback to setup display
        }
    }
}

window["UwpXboxHdmiSetupPlugin"] = async () => UwpXboxHdmiSetupPlugin;

/**
 * Subtitle formats rendered client-side (SubtitlesOctopus / libpgs) that drift after resume.
 * Native text formats (vtt, srt) are excluded — they sync via a different path.
 */
const BURN_IN_STYLE_SUBTITLE_CODECS = new Set([
    'ass', 'ssa', 'pgssub', 'pgs', 'dvdsub', 'dvbsub', 'vobsub'
]);

const NATIVE_TEXT_SUBTITLE_CODECS = new Set([
    'vtt', 'webvtt', 'srt', 'subrip'
]);

const RESUME_SYNC_CHECK_DELAYS_MS = [2000, 5000, 8000];
const RESUME_SYNC_THRESHOLD_SEC = 0.5;
const RESUME_SYNC_MAX_DELTA_SEC = 120;

function getSubtitleDeliveryMethod(stream) {
    if (!stream) {
        return null;
    }

    if (stream.DeliveryMethod) {
        return stream.DeliveryMethod;
    }

    return stream.IsExternal ? 'External' : 'Embed';
}

function isBurnInStyleSubtitle(stream) {
    if (!stream) {
        return false;
    }

    const codec = (stream.Codec || '').toLowerCase();

    if (NATIVE_TEXT_SUBTITLE_CODECS.has(codec)) {
        return false;
    }

    if (!BURN_IN_STYLE_SUBTITLE_CODECS.has(codec)) {
        return false;
    }

    const delivery = getSubtitleDeliveryMethod(stream);
    if (delivery === 'Encode') {
        return false;
    }

    return true;
}

function getExpectedStartTicks(player) {
    const playOptions = player?._currentPlayOptions;
    return playOptions?.playerStartPositionTicks || 0;
}

function checkResumeSubtitlePosition(playbackManager, player, expectedTicks, checkLabel) {
    const actualTicks = playbackManager.getCurrentTicks(player);
    const deltaSec = (expectedTicks - actualTicks) / 10000000;
    const absDeltaSec = Math.abs(deltaSec);

    if (absDeltaSec < RESUME_SYNC_THRESHOLD_SEC) {
        return;
    }

    if (absDeltaSec > RESUME_SYNC_MAX_DELTA_SEC) {
        console.log(`[UwpSubtitleResumeSync] ${checkLabel}: delta ${deltaSec.toFixed(2)}s exceeds sanity cap, skipping`);
        return;
    }

    const currentOffset = playbackManager.getPlayerSubtitleOffset(player) || 0;
    const newOffset = currentOffset + deltaSec;

    console.log(
        `[UwpSubtitleResumeSync] ${checkLabel}: correcting offset by ${deltaSec.toFixed(2)}s ` +
        `(expected ${(expectedTicks / 10000000).toFixed(1)}s, actual ${(actualTicks / 10000000).toFixed(1)}s, ` +
        `offset ${currentOffset.toFixed(2)}s -> ${newOffset.toFixed(2)}s)`
    );

    playbackManager.setSubtitleOffset(newOffset, player);
}

/**
 * Corrects ASS/SSA and other burn-in-style subtitle drift after resume playback.
 */
class UwpSubtitleResumeSyncPlugin {
    constructor(pluginOptions) {
        this.name = 'UWP Subtitle Resume Sync';
        this.id = 'uwpsubtitleresumesync';
        this.type = 'preplayintercept';
        this.priority = -100;
        this.PluginOptions = pluginOptions;
        this._resumeSyncTimers = [];
        this._activePlayer = null;

        this.bindPlaybackEvents(pluginOptions);
    }

    intercept() {
        return Promise.resolve();
    }

    bindPlaybackEvents(pluginOptions) {
        const playbackManager = pluginOptions?.playbackManager;
        const events = pluginOptions?.events;

        if (!playbackManager || !events || playbackManager._uwpSubtitleResumeSyncApplied) {
            return;
        }

        playbackManager._uwpSubtitleResumeSyncApplied = true;

        events.on(playbackManager, 'playbackstart', (e, player) => {
            this.onPlaybackStart(playbackManager, player);
        });

        events.on(playbackManager, 'playbackstop', () => {
            this.clearResumeSyncTimers();
        });
    }

    onPlaybackStart(playbackManager, player) {
        this.clearResumeSyncTimers();
        this._activePlayer = player;

        const expectedTicks = getExpectedStartTicks(player);
        if (expectedTicks <= 0) {
            return;
        }

        RESUME_SYNC_CHECK_DELAYS_MS.forEach((delay, index) => {
            const timer = setTimeout(() => {
                if (this._activePlayer !== player) {
                    return;
                }

                const subIndex = playbackManager.getSubtitleStreamIndex(player);
                if (subIndex == null || subIndex === -1) {
                    return;
                }

                const stream = playbackManager.getSubtitleStream(player, subIndex);
                if (!isBurnInStyleSubtitle(stream)) {
                    return;
                }

                checkResumeSubtitlePosition(
                    playbackManager,
                    player,
                    expectedTicks,
                    `check ${index + 1} @ ${delay}ms (${stream.Codec})`
                );
            }, delay);

            this._resumeSyncTimers.push(timer);
        });
    }

    clearResumeSyncTimers() {
        this._resumeSyncTimers.forEach((timer) => clearTimeout(timer));
        this._resumeSyncTimers = [];
        this._activePlayer = null;
    }
}

window["UwpSubtitleResumeSyncPlugin"] = async () => UwpSubtitleResumeSyncPlugin;

if (!window.consoleXboxOverride)
{
    window.consoleXboxOverride = true;
    const logOverride = function(logLevel) {
        let oldLogLevel = console[logLevel];
        console[logLevel] = function () {
            oldLogLevel.apply(console, arguments);
            let argsArray = Array.from(arguments);
            window.chrome.webview.postMessage(JSON.stringify({ type: "log", args: { level: logLevel, messages: argsArray } }));
        }
    }
    // debug is intentionally commented out as it can overwhelm the interopt layer. Uncomment for troubleshooting if needed.
    //logOverride("debug");
    logOverride("error");
    logOverride("log");
    logOverride("warn");
    logOverride("info");
}
