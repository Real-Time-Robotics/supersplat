type CacheScope =
    | { kind: 'run'; datasetId: string; pipeline: string; runName: string; created: string | number }
    | { kind: 'job'; jobId: string };

type IndexEntry = { size: number; seq: number };

const CACHE_NAME = 'genesis-artifacts-v1';
const INDEX_KEY = 'genesis.artifact-cache.index';
const DEFAULT_CEILING_BYTES = 16 * 1024 ** 3;
// Reserve headroom because browser quotas are approximate.
const QUOTA_SHARE = 0.8;

const part = (value: string | number) => encodeURIComponent(String(value));

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

    /** A cached body is a disk handle, so measuring it beats trusting a declared size. */
    private async sizeOf(response: Response): Promise<number> {
        try {
            return (await response.clone().blob()).size;
        } catch {
            return Number(response.headers.get('content-length')) || 0;
        }
    }

    async budget(): Promise<number> {
        try {
            const quota = (await navigator.storage.estimate()).quota ?? 0;
            if (quota > 0) return Math.floor(Math.min(this.ceiling, quota * QUOTA_SHARE));
        } catch {
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

    async read(scope: CacheScope, name: string): Promise<Blob | null> {
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
        const blob = await hit.blob();
        index[key] = { size: blob.size, seq: this.nextSeq(index) };
        this.writeIndex(index);
        return blob;
    }

    /**
     * Take a response body into the cache and hand back the cached copy, so the bytes
     * go from the network to disk without ever being a JS value. `onBytes` reports each
     * chunk as it passes. Null means the cache declined before reading anything, so the
     * body is still the caller's to use; once bytes flow, failure throws instead.
     */
    async store(scope: CacheScope, name: string, response: Response, expectedSize: number,
        onBytes: (count: number) => void): Promise<Blob | null> {
        if (!response.body) return null;
        let cache: Cache;
        try {
            cache = await this.open();
        } catch {
            return null;
        }
        const budget = await this.budget();
        if (expectedSize > budget) return null;

        const key = cacheKeyFor(scope, name);
        const headers = new Headers();
        const contentType = response.headers.get('Content-Type');
        if (contentType) headers.set('Content-Type', contentType);
        const counted = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                onBytes(chunk.byteLength);
                controller.enqueue(chunk);
            }
        }));
        try {
            await cache.put(key, new Response(counted, { headers }));
        } catch (error) {
            // The body is spent, so make room for the retry that has to happen elsewhere.
            if (isQuotaError(error)) await this.evictOldestHalf(key);
            throw error;
        }
        const hit = await cache.match(key);
        if (!hit) throw new Error('The cache dropped the artifact as it was stored.');
        const blob = await hit.blob();
        const index = this.readIndex();
        index[key] = { size: blob.size, seq: this.nextSeq(index) };
        this.writeIndex(index);
        // Trim after the write, not before: a cancelled download must not cost the user
        // entries that nothing replaced.
        await this.evictTo(budget - blob.size, key);
        return blob;
    }

    async remove(scope: CacheScope, name: string): Promise<void> {
        await this.forget(cacheKeyFor(scope, name));
    }

    /** Every entry of one job or run, for when the server no longer has it either. */
    async removeScope(scope: CacheScope): Promise<void> {
        // Keep the empty name's trailing '/': `created: 111` must not match `created: 1110`.
        const prefix = cacheKeyFor(scope, '');
        const index = this.readIndex();
        const gone = Object.keys(index).filter(key => key.startsWith(prefix));
        if (!gone.length) return;
        const cache = await this.open();
        await Promise.all(gone.map(key => cache.delete(key)));
        for (const key of gone) delete index[key];
        this.writeIndex(index);
    }

    async clear(): Promise<void> {
        const cache = await this.open();
        await Promise.all(Object.keys(this.readIndex()).map(key => cache.delete(key)));
        for (const request of await cache.keys()) await cache.delete(request.url);
        this.writeIndex({});
    }

    async reconcile(): Promise<void> {
        const index = this.readIndex();
        const cache = await this.open();
        const reconciled: Record<string, IndexEntry> = {};
        let seq = this.nextSeq(index);
        for (const request of await cache.keys()) {
            const known = index[request.url];
            if (known?.size) {
                reconciled[request.url] = known;
                continue;
            }
            const response = await cache.match(request.url);
            if (!response) continue;      // evicted between keys() and match()
            reconciled[request.url] = {
                size: await this.sizeOf(response),
                seq: known?.seq ?? seq++
            };
        }
        this.writeIndex(reconciled);
    }

    private async forget(key: string): Promise<void> {
        await (await this.open()).delete(key);
        const index = this.readIndex();
        delete index[key];
        this.writeIndex(index);
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
