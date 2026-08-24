type Listener = () => void;
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const listeners = new Set<Listener>();
let ended = false;
type SessionScope = { controller: AbortController };
let currentScope: SessionScope = { controller: new AbortController() };

const onSessionEnded = (listener: Listener): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

const endSession = (scope: SessionScope = currentScope): void => {
    if (scope !== currentScope || ended) return;
    ended = true;
    scope.controller.abort();
    for (const listener of [...listeners]) listener();
};

const sessionRestored = (): void => {
    currentScope.controller.abort();
    currentScope = { controller: new AbortController() };
    ended = false;
};

const sessionIsOver = (): boolean => ended;

const isSessionRefusal = async (response: Response): Promise<boolean> => {
    if (response.status !== 401) return false;
    try {
        const payload = await response.clone().json() as { code?: string };
        return payload.code !== 'invalid_api_key';
    } catch {
        return true;
    }
};

const apiPath = (input: FetchInput): string | null => {
    const raw = input instanceof Request ? input.url : String(input);
    try {
        const base = globalThis.location?.origin ?? 'https://local.invalid';
        const url = new URL(raw, base);
        if (!raw.startsWith('/') && globalThis.location && url.origin !== location.origin) return null;
        return url.pathname;
    } catch {
        return null;
    }
};

const sessionSignal = (input: FetchInput, init: FetchInit, scope: SessionScope): {
    signal: AbortSignal;
    release: () => void;
} => {
    const signals = [
        scope.controller.signal,
        init.signal,
        input instanceof Request ? input.signal : undefined
    ].filter((signal): signal is AbortSignal => Boolean(signal));
    if (signals.length === 1) return { signal: signals[0], release: () => undefined };

    const controller = new AbortController();
    const abort = () => controller.abort();
    for (const signal of signals) {
        if (signal.aborted) {
            abort();
            break;
        }
        signal.addEventListener('abort', abort, { once: true });
    }
    return {
        signal: controller.signal,
        release: () => signals.forEach(signal => signal.removeEventListener('abort', abort))
    };
};

const reconFetch = async (input: FetchInput, init: FetchInit = {}): Promise<Response> => {
    const scope = currentScope;
    const scoped = sessionSignal(input, init, scope);
    let response: Response;
    try {
        response = await fetch(input, { ...init, signal: scoped.signal });
    } finally {
        scoped.release();
    }
    const path = apiPath(input);
    const internal = path?.startsWith('/api/reconstruction') || path?.startsWith('/api/gp');
    if (internal && await isSessionRefusal(response)) endSession(scope);
    const method = init.method ?? (input instanceof Request ? input.method : 'GET');
    if (path === '/api/reconstruction/session' && method.toUpperCase() === 'DELETE') endSession(scope);
    return response;
};

export { endSession, onSessionEnded, reconFetch, sessionIsOver, sessionRestored };
