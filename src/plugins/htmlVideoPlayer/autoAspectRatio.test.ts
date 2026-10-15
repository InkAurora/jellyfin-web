import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AutoAspectRatio, { detectLetterbox, getAutoScale } from './autoAspectRatio';

function frame(top = 0, bottom = top, brightness = 120, barBrightness = 8): ImageData {
    const width = 192;
    const height = 108;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const offset = (y * width + x) * 4;
            const value = y < top || y >= height - bottom ? barBrightness : brightness;
            data.set([value, value, value, 255], offset);
        }
    }
    return { data, width, height } as ImageData;
}

describe('letterbox detection', () => {
    it('finds compressed black bars and full-height pictures', () => {
        expect(detectLetterbox(frame(14))).toBeCloseTo(14 / 108);
        expect(detectLetterbox(frame())).toBe(0);
    });

    it('rejects black frames, fades, asymmetric shadows and excessive crops', () => {
        expect(detectLetterbox(frame(0, 0, 0))).toBeNull();
        expect(detectLetterbox(frame(14, 14, 12))).toBeNull();
        expect(detectLetterbox(frame(14, 0))).toBeNull();
        expect(detectLetterbox(frame(30))).toBeNull();
    });

    it('detects the reported dark scene against pure black bars', () => {
        const image = frame(14, 14, 6, 0);
        for (let y = 14; y < 94; y++) {
            for (let x = 0; x < image.width; x++) {
                image.data.set([6, 6 + x % 11, 6], (y * image.width + x) * 4);
            }
        }
        expect(detectLetterbox(image)).toBeCloseTo(14 / 108);
        expect(detectLetterbox(frame(14, 14, 25))).toBeCloseTo(14 / 108);
    });

    it('requires a difference greater than five in any color channel', () => {
        expect(detectLetterbox(frame(14, 14, 13))).toBeNull();
        const image = frame(14, 14, 10);
        for (let y = 14; y < 94; y++) {
            for (let x = 0; x < image.width; x++) {
                image.data.set([10, 14, 10], (y * image.width + x) * 4);
            }
        }
        expect(detectLetterbox(image)).toBeCloseTo(14 / 108);
    });

    it('tolerates slight variation in compressed bars', () => {
        const image = frame(14, 14, 18);
        for (let y = 0; y < image.height; y++) {
            if (y >= 14 && y < 94) continue;
            for (let x = 0; x < image.width; x++) {
                const value = 6 + (x + y) % 5;
                image.data.set([value, value, value, 255], (y * image.width + x) * 4);
            }
        }
        expect(detectLetterbox(image)).toBeCloseTo(14 / 108);
    });

    it('compares gradual changes to the fixed bar color, not adjacent pixels', () => {
        const image = frame(14);
        for (let y = 14; y < 94; y++) {
            const value = Math.min(120, 9 + Math.min(y - 14, 93 - y));
            for (let x = 0; x < image.width; x++) {
                image.data.set([value, value, value, 255], (y * image.width + x) * 4);
            }
        }
        expect(detectLetterbox(image)).toBeCloseTo(19 / 108);
    });

    it('ignores isolated noise and a minority of shadows touching the boundary', () => {
        const image = frame(14, 14, 18);
        for (const y of [3, 104]) {
            for (let x = 0; x < image.width; x++) {
                image.data.set([80, 80, 80, 255], (y * image.width + x) * 4);
            }
        }
        for (let y = 0; y < image.height; y++) {
            for (let x = 20; x < 30; x++) {
                image.data.set([8, 8, 8, 255], (y * image.width + x) * 4);
            }
        }
        expect(detectLetterbox(image)).toBeCloseTo(14 / 108);
    });

    it('rejects boundaries that do not form horizontal lines', () => {
        const image = frame();
        for (let x = 0; x < image.width; x++) {
            const depth = 6 + Math.floor(x / 5) % 7 * 3;
            for (let y = 0; y < depth; y++) {
                image.data.set([8, 8, 8, 255], (y * image.width + x) * 4);
                image.data.set([8, 8, 8, 255], ((image.height - 1 - y) * image.width + x) * 4);
            }
        }
        expect(detectLetterbox(image)).toBeNull();
    });

    it('requires matching dark colors at both outer edges', () => {
        const image = frame(14);
        for (let y = 94; y < image.height; y++) {
            for (let x = 0; x < image.width; x++) {
                image.data.set([16, 16, 16, 255], (y * image.width + x) * 4);
            }
        }
        expect(detectLetterbox(image)).toBeNull();
        expect(detectLetterbox(frame(14, 14, 120, 40))).toBe(0);
    });

    it('does not infer a boundary from a small visible patch', () => {
        const image = frame(14, 14, 8);
        for (let y = 14; y < 94; y++) {
            for (let x = 20; x < 35; x++) {
                image.data.set([100, 100, 100, 255], (y * image.width + x) * 4);
            }
        }
        expect(detectLetterbox(image)).toBeNull();
    });

    it('allows two rows of top/bottom disagreement, but not three', () => {
        expect(detectLetterbox(frame(14, 16, 18))).toBeCloseTo(14 / 108);
        expect(detectLetterbox(frame(14, 17, 18))).toBeNull();
    });

    it('ignores centered burned-in captions in the bars', () => {
        const image = frame(14);
        for (let y = 97; y < 103; y++) {
            for (let x = 65; x < 127; x++) {
                image.data.set([255, 255, 255, 255], (y * image.width + x) * 4);
            }
        }
        expect(detectLetterbox(image)).toBeCloseTo(14 / 108);
    });

    it('accepts a soft boundary introduced by video downsampling', () => {
        const image = frame(14);
        for (const y of [13, 94]) {
            for (let x = 0; x < image.width; x++) {
                image.data.set([25, 25, 25, 255], (y * image.width + x) * 4);
            }
        }
        expect(detectLetterbox(image)).toBeCloseTo(13 / 108);
    });
});

describe('automatic aspect ratio playback', () => {
    let video: HTMLVideoElement;
    let controller: AutoAspectRatio;
    let image: ImageData;
    let now: number;
    let nextFrame: FrameRequestCallback | undefined;
    const readPixels = vi.fn();

    function sample(count = 4, interval = 500) {
        for (let i = 0; i < count; i++) {
            now += interval;
            video.currentTime += interval / 1000;
            video.dispatchEvent(new Event('timeupdate'));
            const callback = nextFrame;
            nextFrame = undefined;
            callback?.(now);
        }
    }

    function setVideo(values: Record<string, number | boolean>) {
        for (const [key, value] of Object.entries(values)) {
            Object.defineProperty(video, key, { configurable: true, value });
        }
    }

    beforeEach(() => {
        now = 0;
        nextFrame = undefined;
        image = frame(14);
        video = document.createElement('video');
        setVideo({ videoWidth: 1920, videoHeight: 1080, clientWidth: 1920, clientHeight: 1080,
            paused: false, ended: false, seeking: false, readyState: 4 });
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
            nextFrame = callback;
            return 1;
        });
        vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {
            nextFrame = undefined;
        });
        readPixels.mockReset().mockImplementation(() => image);
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
            drawImage: vi.fn(), getImageData: readPixels
        } as unknown as CanvasRenderingContext2D);
        controller = new AutoAspectRatio(video);
    });

    afterEach(() => controller.destroy());

    it('waits for stable frames, then locks Auto for the rest of playback', () => {
        sample(3);
        expect(video.style.transform).toBe('');
        sample(1);
        const zoom = video.style.transform;
        expect(zoom).toBe(`scale(${108 / 78})`);
        image = frame();
        sample(10);
        expect(video.style.transform).toBe(zoom);
        expect(readPixels).toHaveBeenCalledTimes(4);
    });

    it('Dynamic follows both directions and Auto freezes the current crop', () => {
        controller.setMode('auto-dynamic');
        sample();
        expect(video.style.transform).toBe(`scale(${108 / 78})`);
        image = frame();
        sample();
        expect(video.style.transform).toBe('scale(1)');
        image = frame(14);
        sample();
        expect(video.style.transform).toBe(`scale(${108 / 78})`);
        controller.setMode('auto');
        image = frame();
        sample();
        expect(video.style.transform).toBe(`scale(${108 / 78})`);
    });

    it.each([24, 60, 120])('applies both boundary changes on their first frame at %i fps', fps => {
        controller.setMode('auto-dynamic');
        sample(1, 1000 / fps);
        const zoom = video.style.transform;
        expect(zoom).toBe(`scale(${108 / 78})`);
        image = frame();
        sample(1, 1000 / fps);
        expect(video.style.transform).toBe('scale(1)');
        image = frame(14, 14, 6, 0);
        sample(1, 1000 / fps);
        expect(video.style.transform).toBe(zoom);
        expect(readPixels).toHaveBeenCalledTimes(3);
    });

    it('reads every advancing Dynamic frame but skips duplicate fallback callbacks', () => {
        controller.setMode('auto-dynamic');
        sample(1, 10);
        sample(4, 10);
        expect(readPixels).toHaveBeenCalledTimes(5);
        sample(1, 10);
        expect(readPixels).toHaveBeenCalledTimes(6);
        now += 100;
        const callback = nextFrame;
        nextFrame = undefined;
        callback?.(now);
        expect(readPixels).toHaveBeenCalledTimes(6);
    });

    it('cancels frame sampling on pause, suspension, manual mode and destruction', () => {
        controller.setMode('auto-dynamic');
        expect(nextFrame).toBeDefined();
        setVideo({ paused: true });
        video.dispatchEvent(new Event('pause'));
        expect(nextFrame).toBeUndefined();
        setVideo({ paused: false });
        video.dispatchEvent(new Event('playing'));
        expect(nextFrame).toBeDefined();
        controller.suspend();
        expect(nextFrame).toBeUndefined();
        controller.resume();
        expect(nextFrame).toBeDefined();
        controller.setMode('cover');
        expect(nextFrame).toBeUndefined();
        controller.setMode('auto-dynamic');
        controller.destroy();
        video.dispatchEvent(new Event('playing'));
        expect(nextFrame).toBeUndefined();
    });

    it('uses presented-video-frame callbacks when available and cancels them', () => {
        const requestFrame = vi.fn((callback: FrameRequestCallback) => {
            nextFrame = callback;
            return 42;
        });
        const cancelFrame = vi.fn(() => {
            nextFrame = undefined;
        });
        Object.defineProperty(video, 'requestVideoFrameCallback', { value: requestFrame });
        Object.defineProperty(video, 'cancelVideoFrameCallback', { value: cancelFrame });
        controller.setMode('auto-dynamic');
        sample(1, 1000 / 60);
        expect(video.style.transform).toBe(`scale(${108 / 78})`);
        image = frame();
        sample(1, 1000 / 60);
        expect(video.style.transform).toBe('scale(1)');
        expect(window.requestAnimationFrame).not.toHaveBeenCalled();
        controller.setMode('auto');
        expect(cancelFrame).toHaveBeenCalledWith(42);
        expect(nextFrame).toBeUndefined();
    });

    it('uses presented frame timestamps even when the playback clock is rounded', () => {
        let nextVideoFrame: VideoFrameRequestCallback | undefined;
        Object.defineProperty(video, 'requestVideoFrameCallback', {
            value: (callback: VideoFrameRequestCallback) => {
                nextVideoFrame = callback;
                return 42;
            }
        });
        Object.defineProperty(video, 'cancelVideoFrameCallback', { value: vi.fn() });
        controller.setMode('auto-dynamic');
        nextVideoFrame?.(0, { mediaTime: 1 / 24 } as VideoFrameCallbackMetadata);
        expect(video.style.transform).toBe(`scale(${108 / 78})`);
        image = frame();
        nextVideoFrame?.(0, { mediaTime: 2 / 24 } as VideoFrameCallbackMetadata);
        expect(video.currentTime).toBe(0);
        expect(video.style.transform).toBe('scale(1)');
        expect(readPixels).toHaveBeenCalledTimes(2);
    });

    it('holds the crop through ambiguous frames and reacts to the first clear frame', () => {
        controller.setMode('auto-dynamic');
        sample(1, 1000 / 24);
        const zoom = video.style.transform;
        for (const ambiguousFrame of [frame(0, 0, 0), frame(14, 14, 12), frame(14, 0)]) {
            image = ambiguousFrame;
            sample(1, 1000 / 24);
            expect(video.style.transform).toBe(zoom);
        }
        image = frame();
        sample(1, 1000 / 24);
        expect(video.style.transform).toBe('scale(1)');
    });

    it('recomputes locked zoom for window and video dimension changes', () => {
        sample();
        setVideo({ clientWidth: 1080, clientHeight: 1080 });
        window.dispatchEvent(new Event('resize'));
        expect(video.style.transform).toBe(`scale(${getAutoScale(video, 14 / 108)})`);
        setVideo({ videoWidth: 1280, videoHeight: 720 });
        video.dispatchEvent(new Event('resize'));
        expect(readPixels).toHaveBeenCalledTimes(4);
        expect(video.style.transform).toBe(`scale(${getAutoScale(video, 14 / 108)})`);
    });

    it('also removes display letterboxing from a wide video without encoded bars', () => {
        setVideo({ videoWidth: 2400, videoHeight: 1000 });
        image = frame();
        sample();
        expect(video.style.transform).toBe('scale(1.35)');
    });

    it('clears zoom for manual modes and does not read their frames', () => {
        sample();
        controller.setMode('cover');
        sample();
        expect(video.style.transform).toBe('');
        controller.setMode('fill');
        sample();
        expect(video.style.transform).toBe('');
        expect(readPixels).toHaveBeenCalledTimes(4);
    });

    it('skips paused, seeking, stalled and unavailable frames', () => {
        setVideo({ paused: true });
        sample();
        setVideo({ paused: false, seeking: true });
        sample();
        setVideo({ seeking: false, readyState: 1 });
        sample();
        expect(readPixels).not.toHaveBeenCalled();
        setVideo({ readyState: 4 });
        sample(1);
        now += 500;
        video.dispatchEvent(new Event('timeupdate'));
        expect(readPixels).toHaveBeenCalledTimes(1);
    });

    it('discards pending evidence across seeks', () => {
        sample(3);
        video.dispatchEvent(new Event('seeking'));
        sample(1);
        expect(video.style.transform).toBe('');
        sample(3);
        expect(video.style.transform).toBe(`scale(${108 / 78})`);
    });

    it('preserves the startup crop across a stream restart', () => {
        sample();
        controller.suspend();
        image = frame();
        sample();
        expect(video.style.transform).toBe('');
        expect(readPixels).toHaveBeenCalledTimes(4);
        controller.resume();
        sample();
        expect(video.style.transform).toBe(`scale(${108 / 78})`);
        expect(readPixels).toHaveBeenCalledTimes(4);
    });

    it('bounds startup detection but allows Dynamic to keep watching', () => {
        image = frame(0, 0, 0);
        sample(65);
        expect(readPixels).toHaveBeenCalledTimes(60);
        expect(video.style.transform).toBe('');
        controller.setMode('auto-dynamic');
        image = frame(14);
        sample();
        expect(video.style.transform).toBe(`scale(${108 / 78})`);
    });

    it('fails safely once when browser pixel access is blocked', () => {
        readPixels.mockImplementation(() => {
            throw new DOMException('Tainted canvas', 'SecurityError');
        });
        sample(10);
        expect(readPixels).toHaveBeenCalledTimes(1);
        expect(video.style.transform).toBe('');
    });

    it('releases listeners and zoom when playback ends', () => {
        sample(2);
        controller.destroy();
        sample(5);
        window.dispatchEvent(new Event('resize'));
        expect(readPixels).toHaveBeenCalledTimes(2);
        expect(video.style.transform).toBe('');
    });
});
