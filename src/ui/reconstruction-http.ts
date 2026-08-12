type Listener = () => void;
// `RequestInit` is not in the lint config's global set; this is the same type.
type FetchInit = Parameters<typeof fetch>[1];

const listeners = new Set<Listener>();
let ended = false;

/**
 * Called once when the backend says the session is over. Everything holding live state --
 * the account label, the pollers, the SSE streams, the submission loop -- listens here, so
 * an expired session cannot leave the app looking signed in.
 */
const onSessionEnded = (listener: Listener): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

const endSession = (): void => {
    if (ended) return;      // one announcement per expiry, however many calls saw the 401
    ended = true;
    for (const listener of [...listeners]) listener();
};

/** A fresh sign-in re-arms the guard. */
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

/**
 * The one way the client talks to /api/reconstruction. A 401 means the session is gone --
 * retrying it can only fail the same way, so it is announced instead.
 */
const reconFetch = async (path: string, init: FetchInit = {}): Promise<Response> => {
    const response = await fetch(path, init);
    if (await isSessionRefusal(response)) endSession();
    return response;
};

/** reconFetch plus the JSON unwrap every caller was doing by hand. */
const reconJson = async <T>(path: string, init: FetchInit = {}): Promise<T> => {
    const response = await reconFetch(path, init);
    const payload = await response.json().catch(() => ({})) as any;
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
    return payload as T;
};

export { endSession, onSessionEnded, reconFetch, reconJson, sessionIsOver, sessionRestored };
