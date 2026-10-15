const SAMPLE_WIDTH = 192;
const SAMPLE_HEIGHT = 108;
const SAMPLE_INTERVAL = 500;
const STABLE_SAMPLES = 4;
const STARTUP_SAMPLES = 60;
const TOLERANCE = 2 / SAMPLE_HEIGHT;

const COLOR_TOLERANCE = 5;
const MAX_BAR_VALUE = 20;
const EDGE_AGREEMENT = 0.75;
const BOUNDARY_TOLERANCE = 2;
const PICTURE_ROWS = 3;

function colorDistance(data: Uint8ClampedArray, offset: number, reference: number[]): number {
    return Math.max(
        Math.abs(data[offset] - reference[0]),
        Math.abs(data[offset + 1] - reference[1]),
        Math.abs(data[offset + 2] - reference[2])
    );
}

function boundaryConsensus(votes: number[], minimumVotes: number): number | null {
    // Require a horizontal boundary across most columns, allowing two rows of soft edge.
    // Unresolved columns still count against the quorum; a small bright patch cannot win.
    for (let depth = 0; depth < votes.length; depth++) {
        const count = votes.slice(depth, depth + BOUNDARY_TOLERANCE + 1).reduce((sum, vote) => sum + vote, 0);
        if (count < minimumVotes) continue;
        let cumulative = 0;
        for (let inset = depth; inset <= Math.min(depth + BOUNDARY_TOLERANCE, votes.length - 1); inset++) {
            cumulative += votes[inset];
            if (cumulative >= count / 2) return inset;
        }
    }
    return null;
}

function findEdge({ data, width, height }: ImageData, columns: number[], fromBottom: boolean) {
    const offsetAt = (x: number, depth: number) => ((fromBottom ? height - 1 - depth : depth) * width + x) * 4;
    const edgeOffsets = columns.flatMap(x => [offsetAt(x, 0), offsetAt(x, 1)]);
    // A median resists isolated edge noise without assuming that encoded black is RGB zero.
    const reference = [0, 1, 2].map(channel => {
        const values = edgeOffsets.map(offset => data[offset + channel]).sort((a, b) => a - b);
        return values[Math.floor(values.length / 2)];
    });

    if (Math.max(...reference) > MAX_BAR_VALUE) {
        // Clear picture content at both outer edges means there are no black bars.
        const pictureColumns = columns.filter(x => {
            for (let y = 0; y < PICTURE_ROWS; y++) {
                const offset = offsetAt(x, y);
                if (Math.max(data[offset], data[offset + 1], data[offset + 2]) <= MAX_BAR_VALUE) return false;
            }
            return true;
        });
        return pictureColumns.length >= columns.length * EDGE_AGREEMENT ? { inset: 0, reference } : null;
    }

    const matching = edgeOffsets.filter(offset => colorDistance(data, offset, reference) <= COLOR_TOLERANCE);
    if (matching.length < edgeOffsets.length * EDGE_AGREEMENT) return null;

    const limit = Math.ceil(height * 0.25);
    const votes = new Array<number>(limit).fill(0);
    for (const x of columns) {
        let pictureRows = 0;
        for (let y = 0; y < limit + PICTURE_ROWS - 1; y++) {
            // Always compare to the fixed bar color, so gradual changes cannot drift past it.
            pictureRows = colorDistance(data, offsetAt(x, y), reference) > COLOR_TOLERANCE ? pictureRows + 1 : 0;
            if (pictureRows === PICTURE_ROWS) {
                votes[y - PICTURE_ROWS + 1]++;
                break;
            }
        }
    }

    const inset = boundaryConsensus(votes, columns.length * EDGE_AGREEMENT);
    return inset === null ? null : { inset, reference };
}

/** Returns the symmetric encoded bar height as a fraction, or null for an ambiguous frame. */
export function detectLetterbox(image: ImageData): number | null {
    const { width, height } = image;
    if (width < 32 || height < 12) return null;
    // Sixteen columns in each side strip avoid centered captions and extreme-edge logos.
    const columns = Array.from({ length: 16 }, (_, index) => (index + 0.5) / 16 * 0.2)
        .flatMap(position => [Math.floor(width * (0.1 + position)), Math.floor(width * (0.7 + position))]);
    const top = findEdge(image, columns, false);
    const bottom = findEdge(image, columns, true);
    if (!top || !bottom || Math.abs(top.inset - bottom.inset) > BOUNDARY_TOLERANCE) return null;
    if (top.inset === 0 && bottom.inset === 0) return 0;
    if (top.reference.some((value, channel) => Math.abs(value - bottom.reference[channel]) > COLOR_TOLERANCE)) return null;
    // Keep the smaller inset so a slightly uneven boundary does not cut into the picture.
    return Math.min(top.inset, bottom.inset) / height;
}

export function getAutoScale(video: HTMLVideoElement, inset: number): number {
    const { clientWidth, clientHeight, videoWidth, videoHeight } = video;
    if (!clientWidth || !clientHeight || !videoWidth || !videoHeight) return 1;
    const containedHeight = Math.min(clientHeight, clientWidth * videoHeight / videoWidth);
    // One sampled row of overscan covers rounding at downsampled bar edges.
    const crop = inset > 0 ? inset + 1 / SAMPLE_HEIGHT : 0;
    return clientHeight / (containedHeight * (1 - 2 * crop));
}

/** Samples only advancing playback; the startup mode stops reading pixels after its first result. */
export default class AutoAspectRatio {
    private mode = 'auto';
    private inset: number | null = null;
    private candidate: number | null = null;
    private stableSamples = 0;
    private startupSamples = 0;
    private lastSample = -Infinity;
    private lastTime = -1;
    private unavailable = false;
    private suspended = false;
    private destroyed = false;
    private frameCallback: number | null = null;
    private usesVideoFrameCallback = false;
    private canvas: HTMLCanvasElement | null = null;
    private context: CanvasRenderingContext2D | null = null;

    constructor(private video: HTMLVideoElement) {
        video.addEventListener('timeupdate', this.onTimeUpdate);
        video.addEventListener('playing', this.scheduleFrame);
        video.addEventListener('pause', this.cancelFrame);
        video.addEventListener('ended', this.cancelFrame);
        video.addEventListener('seeking', this.resetCandidate);
        video.addEventListener('resize', this.apply);
        window.addEventListener('resize', this.apply);
    }

    setMode(mode: string) {
        this.mode = mode;
        this.resetCandidate();
        this.apply();
        this.cancelFrame();
        this.scheduleFrame();
    }

    suspend() {
        this.suspended = true;
        this.cancelFrame();
        this.resetCandidate();
        this.apply();
    }

    resume() {
        this.suspended = false;
        this.apply();
        this.scheduleFrame();
    }

    private onTimeUpdate = () => {
        if (this.mode !== 'auto-dynamic') this.sample();
    };

    private scheduleFrame = () => {
        if (this.frameCallback !== null || this.destroyed || this.suspended || this.unavailable
            || this.mode !== 'auto-dynamic' || this.video.paused || this.video.ended) return;

        // timeupdate can be hundreds of milliseconds apart. Follow presented frames instead.
        this.usesVideoFrameCallback = typeof this.video.requestVideoFrameCallback === 'function'
            && typeof this.video.cancelVideoFrameCallback === 'function';
        this.frameCallback = this.usesVideoFrameCallback ?
            this.video.requestVideoFrameCallback(this.onFrame) :
            window.requestAnimationFrame(this.onFrame);
    };

    private onFrame = (_now: number, metadata?: VideoFrameCallbackMetadata) => {
        this.frameCallback = null;
        if (this.destroyed) return;
        this.sample(metadata?.mediaTime);
        this.scheduleFrame();
    };

    private cancelFrame = () => {
        if (this.frameCallback === null) return;
        if (this.usesVideoFrameCallback) this.video.cancelVideoFrameCallback(this.frameCallback);
        else window.cancelAnimationFrame(this.frameCallback);
        this.frameCallback = null;
    };

    private resetCandidate = () => {
        this.candidate = null;
        this.stableSamples = 0;
    };

    private apply = () => {
        if (!this.suspended && (this.mode === 'auto' || this.mode === 'auto-dynamic') && this.inset !== null) {
            this.video.style.transform = `scale(${getAutoScale(this.video, this.inset)})`;
        } else {
            this.video.style.removeProperty('transform');
        }
    };

    private updateInset(inset: number) {
        if (this.inset === null || Math.abs(inset - this.inset) > TOLERANCE) {
            this.inset = inset;
            this.apply();
        }
    }

    private sample = (frameTime = this.video.currentTime) => {
        const video = this.video;
        if (this.suspended || this.unavailable || (this.mode !== 'auto' && this.mode !== 'auto-dynamic')
            || (this.mode === 'auto' && (this.inset !== null || this.startupSamples >= STARTUP_SAMPLES))
            || video.paused || video.ended || video.seeking || video.readyState < 2
            || !video.videoWidth || !video.videoHeight || frameTime === this.lastTime) return;

        const now = performance.now();
        if (this.mode === 'auto' && now - this.lastSample < SAMPLE_INTERVAL) return;
        this.lastSample = now;
        this.lastTime = frameTime;
        this.startupSamples++;

        let detected;
        try {
            if (!this.canvas) {
                this.canvas = document.createElement('canvas');
                this.canvas.width = SAMPLE_WIDTH;
                this.canvas.height = SAMPLE_HEIGHT;
                this.context = this.canvas.getContext('2d', { willReadFrequently: true });
            }
            if (!this.context) {
                this.unavailable = true;
                return;
            }
            this.context.drawImage(video, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
            detected = detectLetterbox(this.context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT));
        } catch {
            // Some remote or protected sources cannot be read. Keep playback and normal fit working.
            this.unavailable = true;
            this.canvas = null;
            this.context = null;
            return;
        }

        if (detected === null) {
            this.resetCandidate();
            return;
        }
        if (this.mode === 'auto-dynamic') {
            // Spatial checks already validated this frame. Do not wait for future frames.
            this.updateInset(detected);
            return;
        }
        if (this.candidate === null || Math.abs(detected - this.candidate) > TOLERANCE) {
            this.candidate = detected;
            this.stableSamples = 1;
            return;
        }
        this.stableSamples++;
        if (this.stableSamples >= STABLE_SAMPLES) this.updateInset(this.candidate);
    };

    destroy() {
        this.destroyed = true;
        this.cancelFrame();
        this.video.removeEventListener('timeupdate', this.onTimeUpdate);
        this.video.removeEventListener('playing', this.scheduleFrame);
        this.video.removeEventListener('pause', this.cancelFrame);
        this.video.removeEventListener('ended', this.cancelFrame);
        this.video.removeEventListener('seeking', this.resetCandidate);
        this.video.removeEventListener('resize', this.apply);
        window.removeEventListener('resize', this.apply);
        this.video.style.removeProperty('transform');
        this.canvas = null;
        this.context = null;
    }
}
