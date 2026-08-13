import { formatBytes } from './utils';

/** Bytes moved so far plus the rate derived from them. Zero rate means "not known yet". */
type TransferRate = {
    loaded: number;
    total: number;
    bytesPerSecond: number;
    etaSeconds: number;
};

const WINDOW_MS = 8_000;

const MIN_ELAPSED_S = 0.4;

/**
 * Rate over a sliding window of progress ticks. One meter per concurrent transfer.
 */
class RateMeter {
    private key = '';
    private samples: { time: number; loaded: number }[] = [];

    constructor(private readonly now: () => number = () => performance.now()) {}

    sample(key: string, loaded: number, total: number): TransferRate {
        const now = this.now();
        if (this.key !== key) {
            this.key = key;
            this.samples = [{ time: now, loaded }];
        } else {
            this.samples.push({ time: now, loaded });
        }
        while (this.samples.length > 2 && now - this.samples[0].time > WINDOW_MS) {
            this.samples.shift();
        }
        const first = this.samples[0];
        const elapsed = (now - first.time) / 1000;
        const bytesPerSecond = elapsed >= MIN_ELAPSED_S ?
            Math.max(0, (loaded - first.loaded) / elapsed) : 0;
        const etaSeconds = total > loaded && bytesPerSecond > 0 ?
            (total - loaded) / bytesPerSecond : 0;
        return { loaded, total, bytesPerSecond, etaSeconds };
    }

    reset() {
        this.key = '';
        this.samples = [];
    }
}

/** "{number} MB/s", or '' */
const formatRate = (bytesPerSecond: number) => (
    bytesPerSecond > 0 ? `${formatBytes(bytesPerSecond)}/s` : ''
);

/**
 * The compact form for an upload row
 */
const formatEtaShort = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${Math.ceil(seconds % 60)}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
};

export { RateMeter, formatEtaShort, formatRate };
export type { TransferRate };
