type FailureClass =
    | 'network-interrupted'
    | 'deadline-exceeded'
    | 'credential-expired'
    | 'peer-unavailable'
    | 'quota-exceeded'
    | 'unauthenticated'
    | 'cancelled'
    | 'permanent';

const RETRYABLE = new Set<FailureClass>([
    'network-interrupted',
    'deadline-exceeded',
    'credential-expired',
    'peer-unavailable'
]);

const TRANSPORT_CODES = new Set([
    'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT',
    'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPROTO',
    'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_CLOSED',
    'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'
]);

const isRetryable = (cls: FailureClass): boolean => RETRYABLE.has(cls);

const classifyApiStatus = (status: number): FailureClass => {
    if (status === 401 || status === 403) return 'unauthenticated';
    if (status === 402 || status === 413 || status === 507) return 'quota-exceeded';
    if (status === 429 || (status >= 500 && status <= 599)) return 'peer-unavailable';
    return 'permanent';
};

const classifyStoreStatus = (status: number): FailureClass => {
    if (status === 403) return 'credential-expired';
    if (status === 413) return 'quota-exceeded';
    if (status === 429 || (status >= 500 && status <= 599)) return 'peer-unavailable';
    return 'permanent';
};

const classifyThrown = (err: unknown): FailureClass => {
    for (let node: unknown = err, depth = 0; node != null && depth < 4; depth++) {
        const name = (node as { name?: unknown }).name;
        if (name === 'TimeoutError') return 'deadline-exceeded';
        if (name === 'AbortError') return 'cancelled';
        const code = (node as { code?: unknown }).code;
        if (typeof code === 'string' && TRANSPORT_CODES.has(code)) return 'network-interrupted';
        if (node instanceof TypeError) return 'network-interrupted';
        node = (node as { cause?: unknown }).cause;
    }
    return 'network-interrupted';
};

export { classifyApiStatus, classifyStoreStatus, classifyThrown, isRetryable };
export type { FailureClass };
