const IMAGE_EXTENSIONS = /\.(?:jpe?g|png|tiff?|bmp|webp)$/i;
const OPENABLE_ARTIFACT_EXTENSIONS = /\.(?:ply|splat|sog|ksplat|spz|glb|gltf)$/i;
const PREPARED_DATASET_KEY = 'genesis.reconstruction.preparedDataset';
const PIPELINE_KEY = 'genesis.reconstruction.pipeline';
const JOB_NOT_FOUND_GRACE = 3;

const delay = (ms: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
});

const messageOf = (error: unknown) => (
    error instanceof Error ? error.message : String(error)
);

/** An SSE frame's JSON object, or null for anything a typed reader can't use. */
const eventData = <T>(event: Event): T | null => {
    if (!(event instanceof MessageEvent)) return null;
    try {
        const data = JSON.parse(event.data) as unknown;
        return typeof data === 'object' && data !== null ? data as T : null;
    } catch {
        return null;
    }
};

const formatBytes = (bytes: number) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const unit = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const value = bytes / (1024 ** unit);
    return `${value.toFixed(unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
};

const formatDuration = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds < 0) return 'estimating…';
    if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))}s remaining`;
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.ceil(seconds % 60);
    if (minutes < 60) return `${minutes}m ${remainder}s remaining`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m remaining`;
};

const readJson = async <T = any>(response: Response): Promise<T> => {
    let body: any = {};
    try {
        body = await response.json();
    } catch {
        if (response.ok) {
            throw new Error(
                'The local server returned an invalid API response. Restart SuperSplat so the frontend and server use the same version.'
            );
        }
    }
    if (!response.ok) throw new Error(body.error || `Server returned ${response.status}`);
    return body as T;
};

export {
    IMAGE_EXTENSIONS,
    JOB_NOT_FOUND_GRACE,
    OPENABLE_ARTIFACT_EXTENSIONS,
    PIPELINE_KEY,
    PREPARED_DATASET_KEY,
    delay,
    eventData,
    formatBytes,
    formatDuration,
    messageOf,
    readJson
};
