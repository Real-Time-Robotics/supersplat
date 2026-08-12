type Listener = () => void;
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const listeners = new Set<Listener>();
let ended = false;

const onSessionEnded = (listener: Listener): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

const endSession = (): void => {
    if (ended) return;
    ended = true;
    for (const listener of [...listeners]) listener();
};

const sessionRestored = (): void => {
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

const reconFetch = async (input: FetchInput, init: FetchInit = {}): Promise<Response> => {
    const response = await fetch(input, init);
    const path = apiPath(input);
    const internal = path?.startsWith('/api/reconstruction') || path?.startsWith('/api/gp');
    if (internal && await isSessionRefusal(response)) endSession();
    const method = init.method ?? (input instanceof Request ? input.method : 'GET');
    if (path === '/api/reconstruction/session' && method.toUpperCase() === 'DELETE') endSession();
    return response;
};

const reconJson = async <T>(path: FetchInput, init: FetchInit = {}): Promise<T> => {
    const response = await reconFetch(path, init);
    const payload = await response.json().catch(() => ({})) as any;
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
    return payload as T;
};

export { endSession, onSessionEnded, reconFetch, reconJson, sessionIsOver, sessionRestored };
