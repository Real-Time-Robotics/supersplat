export {};   // a module, so the `self` below shadows the DOM global instead of clashing with it

declare let self: ServiceWorkerGlobalScope;

self.addEventListener('install', () => {
    // Do not wait for every tab to close -- that wait is the bug being undone.
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        // Only the bundle caches. genesis-artifacts-v1 is the user's downloaded models,
        // written and read straight from the page (see reconstruction-artifact-cache.ts).
        await Promise.all(names
        .filter(name => name.startsWith('superSplat-'))
        .map(name => caches.delete(name)));
        await self.registration.unregister();
    })());
});
