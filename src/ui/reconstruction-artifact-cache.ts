type CacheScope =
    | { kind: 'run'; datasetId: string; pipeline: string; runName: string; created: string | number }
    | { kind: 'job'; jobId: string };

type IndexEntry = { size: number; seq: number };

const CACHE_NAME = 'genesis-artifacts-v1';
const INDEX_KEY = 'genesis.artifact-cache.index';
const DEFAULT_CEILING_BYTES = 4 * 1024 ** 3;
// Leave the browser headroom: at 100% of the reported quota a write fails outright, and
// the quota is an estimate rather than a promise.
const QUOTA_SHARE = 0.8;

const part = (value: string | number) => encodeURIComponent(String(value));

/**
 * A synthetic key, never fetched.
 */
const cacheKeyFor = (scope: CacheScope, name: string): string => {
    const tail = scope.kind === 'job' ?
        `job/${part(scope.jobId)}` :
        `run/${part(scope.datasetId)}/${part(scope.pipeline)}/${part(scope.runName)}/${part(scope.created)}`;
    return `https://artifact.local/${tail}/${part(name)}`;
};

const isQuotaError = (error: unknown): boolean => (error as Error)?.name === 'QuotaExceededError';

class ArtifactCache {
    private readonly ceiling: number;

    constructor(ceiling = DEFAULT_CEILING_BYTES) {
        this.ceiling = ceiling;
    }

    private readIndex(): Record<string, IndexEntry> {
        try {
            return JSON.parse(localStorage.getItem(INDEX_KEY) || '{}') || {};
        } catch {
            return {};
        }
    }

    private writeIndex(index: Record<string, IndexEntry>): void {
        try {
            localStorage.setItem(INDEX_KEY, JSON.stringify(index));
        } catch {
        }
    }

    private nextSeq(index: Record<string, IndexEntry>): number {
        return Object.values(index).reduce((high, entry) => Math.max(high, entry.seq), 0) + 1;
    }

    private open(): Promise<Cache> {
        return caches.open(CACHE_NAME);
    }

    async budget(): Promise<number> {
        try {
            const quota = (await navigator.storage.estimate()).quota ?? 0;
            if (quota > 0) return Math.floor(Math.min(this.ceiling, quota * QUOTA_SHARE));
        } catch {
            // No Storage API: fall back to our own ceiling.
        }
        return this.ceiling;
    }

    async usage(): Promise<{ bytes: number; entries: number; budget: number }> {
        const index = this.readIndex();
        const entries = Object.values(index);
        return {
            bytes: entries.reduce((sum, entry) => sum + entry.size, 0),
            entries: entries.length,
            budget: await this.budget()
        };
    }

    has(scope: CacheScope, name: string): boolean {
        return cacheKeyFor(scope, name) in this.readIndex();
    }

    async read(scope: CacheScope, name: string): Promise<Response | null> {
        const key = cacheKeyFor(scope, name);
        const index = this.readIndex();
        const hit = await (await this.open()).match(key);
        if (!hit) {
            if (index[key]) {
                delete index[key];
                this.writeIndex(index);
            }
            return null;
        }
        index[key] = { size: index[key]?.size ?? 0, seq: this.nextSeq(index) };
        this.writeIndex(index);
        return hit;
    }

    async write(scope: CacheScope, name: string, response: Response): Promise<void> {
        const key = cacheKeyFor(scope, name);
        let bytes: Uint8Array<ArrayBuffer>;
        try {
            bytes = new Uint8Array(await response.arrayBuffer());
        } catch {
            return;
        }
        const budget = await this.budget();
        if (bytes.byteLength > budget) return;
        await this.evictTo(budget - bytes.byteLength, key);
        if (await this.put(key, bytes)) return;
        await this.evictOldestHalf(key);
        await this.put(key, bytes);
    }

    async remove(scope: CacheScope, name: string): Promise<void> {
        await this.forget(cacheKeyFor(scope, name));
    }

    async clear(): Promise<void> {
        const cache = await this.open();
        await Promise.all(Object.keys(this.readIndex()).map(key => cache.delete(key)));
        for (const request of await cache.keys()) await cache.delete(request.url);
        this.writeIndex({});
    }

    async reconcile(): Promise<void> {
        const index = this.readIndex();
        const present = new Set((await (await this.open()).keys()).map(request => request.url));
        const reconciled: Record<string, IndexEntry> = {};
        for (const url of present) {
            reconciled[url] = index[url] ?? { size: 0, seq: 0 };
        }
        this.writeIndex(reconciled);
    }

    private async forget(key: string): Promise<void> {
        await (await this.open()).delete(key);
        const index = this.readIndex();
        delete index[key];
        this.writeIndex(index);
    }

    private async put(key: string, bytes: Uint8Array<ArrayBuffer>): Promise<boolean> {
        try {
            await (await this.open()).put(key, new Response(bytes));
        } catch (error) {
            if (!isQuotaError(error)) throw error;
            return false;
        }
        const index = this.readIndex();
        index[key] = { size: bytes.byteLength, seq: this.nextSeq(index) };
        this.writeIndex(index);
        return true;
    }

    private async evictTo(target: number, exempt: string): Promise<void> {
        const index = this.readIndex();
        const ordered = Object.entries(index)
        .filter(([key]) => key !== exempt)
        .sort((a, b) => a[1].seq - b[1].seq);
        let used = Object.entries(index)
        .filter(([key]) => key !== exempt)
        .reduce((sum, [, entry]) => sum + entry.size, 0);
        for (const [key, entry] of ordered) {
            if (used <= target) return;
            await this.forget(key);
            used -= entry.size;
        }
    }

    private async evictOldestHalf(exempt: string): Promise<void> {
        const ordered = Object.entries(this.readIndex())
        .filter(([key]) => key !== exempt)
        .sort((a, b) => a[1].seq - b[1].seq);
        for (const [key] of ordered.slice(0, Math.ceil(ordered.length / 2))) {
            await this.forget(key);
        }
    }
}

const artifactCache = new ArtifactCache();

export { ArtifactCache, type CacheScope, artifactCache, cacheKeyFor };
