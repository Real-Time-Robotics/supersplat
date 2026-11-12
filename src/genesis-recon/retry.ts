import { peekErrorCode } from './errors';

type RetryOptions = {
    maxAttempts?: number;
    backoff?: number;
};

type Sleep = (seconds: number, signal?: AbortSignal) => Promise<void>;

const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS']);
const READ_RETRY_STATUS = new Set([429, 502, 503, 504]);
const WRITE_RETRY_STATUS = new Set([429]);
const NON_RETRYABLE_429 = new Set(['hourly_credit_ceiling']);
const MAX_RETRY_AFTER = 60;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BACKOFF = 0.5;

const isNonRetryable429 = async (response: Response): Promise<boolean> => {
    if (response.status !== 429) return false;
    return NON_RETRYABLE_429.has((await peekErrorCode(response)) ?? '');
};

const isInProgress = async (response: Response): Promise<boolean> => {
    if (response.status !== 409) return false;
    return (await peekErrorCode(response)) === 'idempotency_in_progress';
};

const resolveRetry = (opts: RetryOptions = {}): Required<RetryOptions> => ({
    maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    backoff: opts.backoff ?? DEFAULT_BACKOFF
});

const parseRetryAfter = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
    const when = Date.parse(trimmed);
    if (Number.isNaN(when)) return null;
    return Math.max((when - Date.now()) / 1000, 0);
};

const delayFor = (response: Response | null, attempt: number, backoff: number): number => {
    const raw = response?.headers.get('Retry-After');
    if (raw) {
        const parsed = parseRetryAfter(raw);
        if (parsed !== null) return Math.min(parsed, MAX_RETRY_AFTER);
    }
    return backoff * 2 ** attempt;
};

const methodOf = (input: RequestInfo | URL, init?: RequestInit): string => {
    if (init?.method) return init.method.toUpperCase();
    if (typeof input === 'object' && 'method' in input) return (input as Request).method.toUpperCase();
    return 'GET';
};

const callerSignal = (input: RequestInfo | URL, init?: RequestInit): AbortSignal | undefined => init?.signal ?? (input instanceof Request ? input.signal : undefined);

const hasIdempotencyKey = (input: RequestInfo | URL, init?: RequestInit): boolean => {
    if (new Headers(init?.headers).has('Idempotency-Key')) return true;
    if (typeof input === 'object' && 'headers' in input) {
        return (input as Request).headers.has('Idempotency-Key');
    }
    return false;
};

const realSleep: Sleep = (seconds, signal) => new Promise<void>((resolve) => {
    if (signal?.aborted) {
        resolve();
        return;
    }
    const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
    }, seconds * 1000);
    function onAbort() {
        clearTimeout(timer);
        resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
});

const createRetryingFetch = (fetchImpl: typeof fetch, opts: RetryOptions = {},
    sleepImpl: Sleep = realSleep): typeof fetch => {
    const { maxAttempts, backoff } = resolveRetry(opts);
    if (maxAttempts < 1) throw new Error('maxAttempts must be >= 1');

    return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const method = methodOf(input, init);
        const idempotent = IDEMPOTENT.has(method);
        const allowedStatus = idempotent ? READ_RETRY_STATUS : WRITE_RETRY_STATUS;
        const keyed = hasIdempotencyKey(input, init);
        const retryNetworkError = idempotent || keyed;
        const signal = callerSignal(input, init);
        let lastErr: unknown;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const final = attempt === maxAttempts - 1;
            let response: Response;
            try {
                const attemptInput = input instanceof Request ? input.clone() : input;
                response = await fetchImpl(attemptInput, init);
            } catch (e) {
                if (!retryNetworkError || final || signal?.aborted) throw e;
                lastErr = e;
                await sleepImpl(delayFor(null, attempt, backoff), signal);
                continue;
            }
            const retryable = !final && (
                (allowedStatus.has(response.status) && !(await isNonRetryable429(response))) ||
                (keyed && await isInProgress(response)));
            if (!retryable) return response;
            await response.body?.cancel().catch(() => {});
            await sleepImpl(delayFor(response, attempt, backoff), signal);
        }
        throw lastErr;
    }) as typeof fetch;
};

export { callerSignal, createRetryingFetch, delayFor, parseRetryAfter, resolveRetry };
export type { RetryOptions };
