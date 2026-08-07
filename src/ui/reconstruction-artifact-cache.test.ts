import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { ArtifactCache, cacheKeyFor } from './reconstruction-artifact-cache';

class FakeCache {
    store = new Map<string, Uint8Array>();
    limit = Infinity;

    async match(key: string) {
        const hit = this.store.get(key);
        return hit ? new Response(hit) : undefined;
    }

    async put(key: string, response: Response) {
        const body = new Uint8Array(await response.arrayBuffer());
        const others = [...this.store.entries()]
        .filter(([name]) => name !== key)
        .reduce((sum, [, bytes]) => sum + bytes.length, 0);
        if (others + body.length > this.limit) {
            const error = new Error('quota');
            error.name = 'QuotaExceededError';
            throw error;
        }
        this.store.set(key, body);
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
    // Node exposes `navigator` as a getter-only accessor, so it cannot be assigned.
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { storage: { estimate: async () => ({ quota: 1024 * 1024 }) } }
    });
};

const scope = {
    kind: 'run', datasetId: 'ds1', pipeline: 'splat', runName: 'standard', created: 111
} as const;
const bodyOf = (size: number) => new Response(new Uint8Array(size));

beforeEach(install);

test('the cache key includes created so a rerun cannot serve the old model', () => {
    const first = cacheKeyFor(scope, 'point_cloud.ply');
    const second = cacheKeyFor({ ...scope, created: 222 }, 'point_cloud.ply');
    assert.notEqual(first, second);
    assert.match(first, /^https:\/\/artifact\.local\//);
});

test('a written artifact reads back', async () => {
    const artifacts = new ArtifactCache(64);
    await artifacts.write(scope, 'a.ply', bodyOf(10));
    assert.ok(artifacts.has(scope, 'a.ply'));
    assert.equal((await (await artifacts.read(scope, 'a.ply')).arrayBuffer()).byteLength, 10);
});

test('exceeding the budget evicts the least recently used entry first', async () => {
    const artifacts = new ArtifactCache(30);
    await artifacts.write(scope, 'old.ply', bodyOf(10));
    await artifacts.write(scope, 'mid.ply', bodyOf(10));
    await artifacts.read(scope, 'old.ply');          // old.ply is now the most recent
    await artifacts.write(scope, 'new.ply', bodyOf(15));
    assert.equal(artifacts.has(scope, 'mid.ply'), false, 'mid.ply was least recently used');
    assert.ok(artifacts.has(scope, 'old.ply'));
    assert.ok(artifacts.has(scope, 'new.ply'));
});

test('QuotaExceededError never propagates to the caller', async () => {
    const artifacts = new ArtifactCache(1024);
    cache.limit = 5;
    await artifacts.write(scope, 'big.ply', bodyOf(100));   // must not throw
    assert.equal(artifacts.has(scope, 'big.ply'), false);
});

test('remove drops one entry and clear drops all', async () => {
    const artifacts = new ArtifactCache(1024);
    await artifacts.write(scope, 'a.ply', bodyOf(10));
    await artifacts.write(scope, 'b.ply', bodyOf(10));
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
    await artifacts.write(scope, 'a.ply', bodyOf(10));
    await cache.delete(cacheKeyFor(scope, 'a.ply'));     // cache lost it, index still lists it
    const reopened = new ArtifactCache(1024);
    await reopened.reconcile();
    assert.equal((await reopened.usage()).entries, 0);
});
