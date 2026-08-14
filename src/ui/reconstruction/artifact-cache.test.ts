import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { ArtifactCache, cacheKeyFor } from './artifact-cache';

class FakeCache {
    store = new Map<string, { body: Uint8Array; headers: Record<string, string> }>();
    limit = Infinity;
    failNextPut: Error | null = null;

    async match(key: string) {
        const hit = this.store.get(key);
        return hit ? new Response(hit.body, { headers: hit.headers }) : undefined;
    }

    async put(key: string, response: Response) {
        if (this.failNextPut) {
            const error = this.failNextPut;
            this.failNextPut = null;
            throw error;
        }
        const headers = Object.fromEntries(response.headers as any);
        const body = new Uint8Array(await response.arrayBuffer());
        const others = [...this.store.entries()]
        .filter(([name]) => name !== key)
        .reduce((sum, [, entry]) => sum + entry.body.length, 0);
        if (others + body.length > this.limit) {
            const error = new Error('quota');
            error.name = 'QuotaExceededError';
            throw error;
        }
        this.store.set(key, { body, headers });
    }

    seedLegacy(key: string, size: number, headers: Record<string, string> = {}) {
        this.store.set(key, { body: new Uint8Array(size), headers });
    }

    async delete(key: string) {
        return this.store.delete(key);
    }

    async keys() {
        return [...this.store.keys()].map(url => new Request(url));
    }
}

let cache: FakeCache;

const install = () => {
    cache = new FakeCache();
    const values = new Map<string, string>();
    (globalThis as any).caches = { open: async () => cache };
    (globalThis as any).localStorage = {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key)
    };
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { storage: { estimate: async () => ({ quota: 1024 * 1024 }) } }
    });
};

const scope = {
    kind: 'run', datasetId: 'ds1', pipeline: 'splat', runName: 'standard', created: 111
} as const;
const responseOf = (size: number, headers?: Record<string, string>) => new Response(
    new Blob([new Uint8Array(size)]).stream(), { headers });

/** Seed the cache the way production does: a response body, streamed in. */
const seed = (artifacts: ArtifactCache, name: string, size: number, declared = size) => {
    return artifacts.store(scope, name, responseOf(size), declared, () => {});
};

beforeEach(install);

test('the cache key includes created so a rerun cannot serve the old model', () => {
    const first = cacheKeyFor(scope, 'point_cloud.ply');
    const second = cacheKeyFor({ ...scope, created: 222 }, 'point_cloud.ply');
    assert.notEqual(first, second);
    assert.match(first, /^https:\/\/artifact\.local\//);
});

test('a stored artifact reads back', async () => {
    const artifacts = new ArtifactCache(64);
    await seed(artifacts, 'a.ply', 10);
    assert.ok(artifacts.has(scope, 'a.ply'));
    assert.equal((await artifacts.read(scope, 'a.ply'))?.size, 10);
});

test('exceeding the budget evicts the least recently used entry first', async () => {
    const artifacts = new ArtifactCache(30);
    await seed(artifacts, 'old.ply', 10);
    await seed(artifacts, 'mid.ply', 10);
    await artifacts.read(scope, 'old.ply');          // old.ply is now the most recent
    await seed(artifacts, 'new.ply', 15);
    assert.equal(artifacts.has(scope, 'mid.ply'), false, 'mid.ply was least recently used');
    assert.ok(artifacts.has(scope, 'old.ply'));
    assert.ok(artifacts.has(scope, 'new.ply'));
});

test('a body is measured by what arrived, not by what the server declared', async () => {
    const artifacts = new ArtifactCache(1024);

    const cached = await seed(artifacts, 'stream.ply', 50, 40);

    assert.equal(cached?.size, 50);
    assert.equal((await artifacts.usage()).bytes, 50);
});

test('every byte is reported as it passes, without buffering the body', async () => {
    const artifacts = new ArtifactCache(1024);
    let counted = 0;

    await artifacts.store(scope, 'stream.ply', responseOf(50), 50, (bytes) => {
        counted += bytes;
    });

    assert.equal(counted, 50);
});

test('an artifact larger than the budget is declined with its body untouched', async () => {
    const artifacts = new ArtifactCache(1024);
    const response = responseOf(10);

    const cached = await artifacts.store(scope, 'big.ply', response, 2048, () => {});

    assert.equal(cached, null);
    assert.equal(artifacts.has(scope, 'big.ply'), false);
    assert.equal(response.bodyUsed, false, 'the caller still has to be able to read it');
    assert.equal((await response.blob()).size, 10);
});

test('an artifact of unknown size is still streamed rather than declined', async () => {
    const artifacts = new ArtifactCache(1024);

    const cached = await seed(artifacts, 'unsized.ply', 50, 0);

    assert.equal(cached?.size, 50);
    assert.ok(artifacts.has(scope, 'unsized.ply'));
});

test('a quota refusal frees room for the retry instead of storing a partial entry', async () => {
    const artifacts = new ArtifactCache(1024);
    await seed(artifacts, 'old.ply', 10);
    await seed(artifacts, 'newer.ply', 10);
    cache.limit = 5;

    await assert.rejects(seed(artifacts, 'big.ply', 100));

    assert.equal(artifacts.has(scope, 'big.ply'), false);
    assert.equal(artifacts.has(scope, 'old.ply'), false, 'the oldest half made way');
    assert.ok(artifacts.has(scope, 'newer.ply'));
});

test('a cancelled download costs the user nothing already cached', async () => {
    const artifacts = new ArtifactCache(30);
    await seed(artifacts, 'old.ply', 10);
    await seed(artifacts, 'newer.ply', 10);
    cache.failNextPut = new DOMException('aborted', 'NetworkError');

    await assert.rejects(seed(artifacts, 'incoming.ply', 15));

    assert.ok(artifacts.has(scope, 'old.ply'), 'eviction must not run ahead of the write');
    assert.ok(artifacts.has(scope, 'newer.ply'));
    assert.equal((await artifacts.usage()).bytes, 20);
});

test('remove drops one entry and clear drops all', async () => {
    const artifacts = new ArtifactCache(1024);
    await seed(artifacts, 'a.ply', 10);
    await seed(artifacts, 'b.ply', 10);
    await artifacts.remove(scope, 'a.ply');
    assert.equal(artifacts.has(scope, 'a.ply'), false);
    assert.ok(artifacts.has(scope, 'b.ply'));
    await artifacts.clear();
    assert.equal((await artifacts.usage()).entries, 0);
});

test('the budget never exceeds 80 percent of the browser quota', async () => {
    const artifacts = new ArtifactCache(4 * 1024 ** 3);
    assert.equal((await artifacts.usage()).budget, Math.floor(1024 * 1024 * 0.8));
});

test('startup reconciles an index that drifted from the cache', async () => {
    const artifacts = new ArtifactCache(1024);
    await seed(artifacts, 'a.ply', 10);
    await cache.delete(cacheKeyFor(scope, 'a.ply'));     // cache lost it, index still lists it
    const reopened = new ArtifactCache(1024);
    await reopened.reconcile();
    assert.equal((await reopened.usage()).entries, 0);
});

test('a body whose index entry was lost is measured, not counted as free', async () => {
    const store = new ArtifactCache(1024);
    await seed(store, 'model.ply', 400);
    localStorage.removeItem('genesis.artifact-cache.index');

    await store.reconcile();

    assert.equal((await store.usage()).bytes, 400);
    assert.equal((await store.usage()).entries, 1);
});

test('reconcile keeps what the index already knew and measures only the rest', async () => {
    const store = new ArtifactCache(4096);
    await seed(store, 'a.ply', 100);
    await seed(store, 'b.ply', 200);
    const index = JSON.parse(localStorage.getItem('genesis.artifact-cache.index'));
    delete index[cacheKeyFor(scope, 'b.ply')];
    localStorage.setItem('genesis.artifact-cache.index', JSON.stringify(index));

    await store.reconcile();

    assert.equal((await store.usage()).bytes, 300);
});

test('an entry with no content-length is still sized correctly', async () => {
    const store = new ArtifactCache(4096);
    cache.seedLegacy(cacheKeyFor(scope, 'legacy.ply'), 512);

    await store.reconcile();

    assert.equal((await store.usage()).bytes, 512,
        'a size of 0 would make it free to hold and invisible to eviction');
});

test('an index entry whose body is gone is dropped', async () => {
    const store = new ArtifactCache(4096);
    await seed(store, 'a.ply', 100);
    cache.store.clear();

    await store.reconcile();

    assert.deepEqual(await store.usage(), { bytes: 0, entries: 0, budget: 4096 });
});

test('eviction after a reconcile drops the oldest recovered entry, not a random one', async () => {
    const store = new ArtifactCache(1000);
    cache.seedLegacy(cacheKeyFor(scope, 'old.ply'), 400);
    cache.seedLegacy(cacheKeyFor(scope, 'newer.ply'), 400);
    await store.reconcile();

    await seed(store, 'incoming.ply', 400);

    assert.equal(store.has(scope, 'old.ply'), false);
    assert.equal(store.has(scope, 'newer.ply'), true);
    assert.equal(store.has(scope, 'incoming.ply'), true);
});

test('a large entry recovered without an index is not treated as weightless', async () => {
    const store = new ArtifactCache(1000);
    cache.seedLegacy(cacheKeyFor(scope, 'huge.ply'), 900);
    await store.reconcile();

    await seed(store, 'incoming.ply', 300);

    assert.equal((await store.usage()).bytes, 300);
    assert.equal(store.has(scope, 'huge.ply'), false, 'a 900-byte entry cannot count as 0');
});

test('a cached artifact keeps its content type', async () => {
    const store = new ArtifactCache(4096);
    await store.store(scope, 'model.ply',
        responseOf(8, { 'Content-Type': 'application/octet-stream' }), 8, () => {});

    const hit = await store.read(scope, 'model.ply');
    assert.equal(hit?.type, 'application/octet-stream');
});
