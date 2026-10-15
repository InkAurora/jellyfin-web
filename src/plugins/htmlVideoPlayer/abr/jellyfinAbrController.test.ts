import Hls from 'hls.js/dist/hls.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createJellyfinAbrController, type JellyfinAbrControllerApi } from './jellyfinAbrController';

const LADDER = [420_000, 720_000, 1_500_000, 3_000_000, 6_000_000, 10_000_000, 20_000_000];
const { Events } = Hls;

type Handler = (event: string, data: unknown) => void;

/** Just enough of an Hls instance for the ABR controller. */
class FakeHls {
    config = { ...Hls.DefaultConfig, maxBufferLength: 30, maxMaxBufferLength: 30 };
    latestLevelDetails = null;
    levels = LADDER.map(bitrate => ({ bitrate, details: { targetduration: 3 } }));
    loadLevel = -1;
    logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), log: vi.fn(), trace: vi.fn(), warn: vi.fn() };
    mainForwardBufferInfo: { len: number } | null = { len: 20 };
    maxAutoLevel = LADDER.length - 1;
    media: HTMLMediaElement | null = null;
    minAutoLevel = 0;
    private handlers = new Map<string, Array<{ context: unknown; handler: Handler }>>();

    on(event: string, handler: Handler, context: unknown) {
        const list = this.handlers.get(event) || [];
        list.push({ context, handler });
        this.handlers.set(event, list);
    }

    off(event: string, handler: Handler, context: unknown) {
        this.handlers.set(event, (this.handlers.get(event) || [])
            .filter(entry => entry.handler !== handler || entry.context !== context));
    }

    trigger(event: string, data: unknown) {
        for (const entry of [...(this.handlers.get(event) || [])]) {
            entry.handler.call(entry.context, event, data);
        }
    }

    countHandlers(event: string) {
        return this.handlers.get(event)?.length || 0;
    }
}

interface TestController extends JellyfinAbrControllerApi {
    destroy(): void;
    firstAutoLevel: number;
    nextAutoLevel: number;
}

let nowMs = 0;

function createController(options: Parameters<typeof createJellyfinAbrController>[1] = {}) {
    const hls = new FakeHls();
    const ControllerClass = createJellyfinAbrController(Hls, options);
    const controller = new ControllerClass(hls as unknown as Hls) as unknown as TestController;
    return { controller, hls };
}

function parseManifest(hls: FakeHls) {
    hls.trigger(Events.MANIFEST_PARSED, { levels: hls.levels });
}

function loadFragment(hls: FakeHls, level: number, options: { bandwidth?: number; ttfbMs?: number } = {}) {
    const bandwidth = options.bandwidth ?? 60_000_000;
    const loadedBytes = LADDER[level] * 3 / 8;
    const startMs = nowMs;
    const firstMs = startMs + (options.ttfbMs ?? 50);
    const endMs = firstMs + (loadedBytes * 8_000 / bandwidth);
    const frag = {
        duration: 3,
        level,
        sn: 1,
        stats: { aborted: false, loaded: loadedBytes, loading: { end: endMs, first: firstMs, start: startMs } },
        type: 'main'
    };
    hls.trigger(Events.FRAG_LOADING, { frag });
    nowMs = endMs;
    hls.trigger(Events.FRAG_LOADED, { frag });
}

function attachMedia(hls: FakeHls) {
    const media = document.createElement('video');
    Object.defineProperty(media, 'paused', { configurable: true, value: false });
    hls.media = media;
    hls.trigger(Events.MEDIA_ATTACHED, { media });
    media.dispatchEvent(new Event('playing'));
    return media;
}

describe('createJellyfinAbrController', () => {
    beforeEach(() => {
        nowMs = 1_000;
        vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('extends the hls.js AbrController and reports itself through onCreate', () => {
        const onCreate = vi.fn();
        const { controller } = createController({ onCreate });

        expect(controller).toBeInstanceOf(Hls.DefaultConfig.abrController);
        expect(onCreate).toHaveBeenCalledWith(controller);
    });

    it('has no debug state before the manifest has levels', () => {
        const { controller, hls } = createController();
        hls.levels = [];

        expect(controller.getDebugState()).toBeNull();
    });

    it('chooses the start level from the seed and keeps it under the hls.js cap', () => {
        const { controller, hls } = createController({ initialBitrate: 6_000_000 });
        parseManifest(hls);

        // 6 Mbps is safe, but its first 3 s segment would take 2.1 s. The start limit is 2 s.
        expect(controller.firstAutoLevel).toBe(3);
        hls.maxAutoLevel = 2;
        expect(controller.firstAutoLevel).toBe(2);
        expect(controller.nextAutoLevel).toBe(2);
    });

    it('goes up one level after the dwell time on a fast network', () => {
        const { controller, hls } = createController({ initialBitrate: 1_500_000 });
        parseManifest(hls);
        const startLevel = controller.nextAutoLevel;
        loadFragment(hls, startLevel);
        loadFragment(hls, startLevel);

        expect(controller.nextAutoLevel).toBe(startLevel + 1);
        loadFragment(hls, startLevel + 1);
        expect(controller.nextAutoLevel).toBe(startLevel + 1);

        nowMs += 10_000;
        expect(controller.nextAutoLevel).toBe(startLevel + 2);
    });

    it('treats an hls.js emergency switch as a real down-switch', () => {
        const { controller, hls } = createController({ initialBitrate: 6_000_000 });
        parseManifest(hls);
        loadFragment(hls, 4);
        loadFragment(hls, 4);

        controller.nextAutoLevel = 1;

        expect(controller.nextAutoLevel).toBe(1);
        expect(controller.getDebugState()).toMatchObject({ currentLevel: 1, lastReason: 'emergency' });
    });

    it('ignores a waiting event while the buffer is full', () => {
        const { controller, hls } = createController({ initialBitrate: 6_000_000 });
        parseManifest(hls);
        const media = attachMedia(hls);
        loadFragment(hls, 4);

        media.dispatchEvent(new Event('waiting'));

        expect(controller.getDebugState()).toMatchObject({ currentLevel: 4, lastReason: 'stall-ignored' });
    });

    it('goes down one level on a waiting event with an empty buffer', () => {
        const { controller, hls } = createController({ initialBitrate: 6_000_000 });
        parseManifest(hls);
        const media = attachMedia(hls);
        loadFragment(hls, 4);
        hls.mainForwardBufferInfo = { len: 0.2 };

        media.dispatchEvent(new Event('waiting'));

        expect(controller.getDebugState()).toMatchObject({ currentLevel: 3, lastReason: 'stall' });
    });

    it('ignores a waiting event during a seek', () => {
        const { controller, hls } = createController({ initialBitrate: 6_000_000 });
        parseManifest(hls);
        const media = attachMedia(hls);
        loadFragment(hls, 4);
        hls.mainForwardBufferInfo = { len: 0 };

        media.dispatchEvent(new Event('seeking'));
        media.dispatchEvent(new Event('waiting'));

        expect(controller.getDebugState()).toMatchObject({ currentLevel: 4 });
    });

    it('removes its listeners on destroy', () => {
        const { controller, hls } = createController();
        parseManifest(hls);
        attachMedia(hls);

        controller.destroy();

        expect(hls.countHandlers(Events.FRAG_LOADED)).toBe(0);
        expect(hls.countHandlers(Events.MEDIA_ATTACHED)).toBe(0);
    });
});

describe('createJellyfinAbrController emergency rule', () => {
    const baseAbandonCheck = vi.fn();

    /** A stand-in for the hls.js AbrController with the members the wrapper uses. */
    class FakeAbrController {
        _abandonRulesCheck = baseAbandonCheck;
        fragCurrent: unknown = null;
        hls: FakeHls;
        constructor(hls: FakeHls) {
            this.hls = hls;
        }
        get firstAutoLevel() {
            return 0;
        }
        get nextAutoLevel() {
            return 0;
        }
        set nextAutoLevel(_level: number) {
            // Not needed here.
        }
        destroy() {
            // Not needed here.
        }
    }

    function createWrappedController() {
        const hls = new FakeHls();
        const fakeHlsClass = { DefaultConfig: { abrController: FakeAbrController }, Events } as unknown as typeof Hls;
        const ControllerClass = createJellyfinAbrController(fakeHlsClass);
        const controller = new ControllerClass(hls as unknown as Hls) as unknown as {
            _abandonRulesCheck: () => void;
            fragCurrent: unknown;
        };
        hls.trigger(Events.MANIFEST_PARSED, { levels: hls.levels });
        return { controller, hls };
    }

    function startFragment(hls: FakeHls, controller: { fragCurrent: unknown }, level: number) {
        const frag = {
            duration: 3,
            level,
            sn: 1,
            stats: { aborted: false, loaded: 0, loading: { end: 0, first: 0, start: 1 } },
            type: 'main'
        };
        hls.trigger(Events.FRAG_LOADING, { frag });
        controller.fragCurrent = frag;
        return frag;
    }

    beforeEach(() => {
        baseAbandonCheck.mockClear();
    });

    it('skips the hls.js rule while the first fragment after a switch waits for its first byte', () => {
        const { controller, hls } = createWrappedController();
        const frag = startFragment(hls, controller, 3);

        controller._abandonRulesCheck();
        expect(baseAbandonCheck).not.toHaveBeenCalled();

        frag.stats.loading.first = 500;
        controller._abandonRulesCheck();
        expect(baseAbandonCheck).toHaveBeenCalledTimes(1);
    });

    it('runs the hls.js rule for later fragments of the same level', () => {
        const { controller, hls } = createWrappedController();
        startFragment(hls, controller, 3);
        startFragment(hls, controller, 3);

        controller._abandonRulesCheck();

        expect(baseAbandonCheck).toHaveBeenCalledTimes(1);
    });
});
