import { classifyApiStatus, classifyThrown, type FailureClass } from './failure';
import type { components } from './schema';

type Problem = components['schemas']['Problem'];
type FieldError = components['schemas']['FieldError'];

class GenesisError extends Error {
    readonly failureClass: FailureClass;

    constructor(message?: string, failureClass: FailureClass = 'network-interrupted',
        options?: { cause?: unknown }) {
        super(message);
        this.name = 'GenesisError';
        this.failureClass = failureClass;
        if (options && 'cause' in options) this.cause = options.cause;
    }
}

class TransportError extends GenesisError {
    constructor(message: string, cause: unknown) {
        super(message, classifyThrown(cause), { cause });
        this.name = 'TransportError';
    }
}

class ApiError extends GenesisError {
    readonly status: number;

    readonly code: string;

    readonly detail: string;

    readonly title: string;

    readonly requestId?: string;

    readonly errors: FieldError[];

    readonly required?: number;

    readonly available?: number;

    readonly holdReason?: string;

    constructor(status: number, code: string, detail: string, problem: Partial<Problem> = {}) {
        super(`[${status} ${code}] ${detail}`, classifyApiStatus(status));
        this.status = status;
        this.code = code;
        this.detail = detail;
        this.name = 'ApiError';
        this.title = problem.title ?? '';
        this.requestId = problem.request_id ?? undefined;
        this.errors = Array.isArray(problem.errors) ? problem.errors : [];
        this.required = problem.required ?? undefined;
        this.available = problem.available ?? undefined;
        this.holdReason = problem.hold_reason ?? undefined;
    }
}

class AuthError extends ApiError {
    override name = 'AuthError';
}

class InsufficientCreditsError extends ApiError {
    override name = 'InsufficientCreditsError';
}

class NotFoundError extends ApiError {
    override name = 'NotFoundError';
}

class ValidationError extends ApiError {
    override name = 'ValidationError';
}

class UploadError extends GenesisError {
    readonly status?: number;

    readonly detail?: string;

    constructor(message: string, status?: number,
        failureClass: FailureClass = 'permanent',
        options?: { cause?: unknown; detail?: string }) {
        super(message, failureClass, options);
        this.status = status;
        this.name = 'UploadError';
        this.detail = options?.detail;
    }
}

const BY_STATUS: Record<number, typeof ApiError> = {
    401: AuthError,
    402: InsufficientCreditsError,
    403: AuthError,
    404: NotFoundError,
    422: ValidationError
};

const REASON_PHRASES: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    408: 'Request Timeout',
    409: 'Conflict',
    410: 'Gone',
    413: 'Content Too Large',
    422: 'Unprocessable Content',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout'
};

const reasonPhrase = (response: Response): string => response.statusText || REASON_PHRASES[response.status] || `HTTP ${response.status}`;

const isProblemType = (response: Response): boolean => {
    const type = response.headers.get('content-type') ?? '';
    return type.split(';', 1)[0].trim().toLowerCase() === 'application/problem+json';
};

const asProblem = (response: Response, body: unknown): Problem | undefined => {
    if (!isProblemType(response) || typeof body !== 'object' || body === null) return undefined;
    return typeof (body as Partial<Problem>).code === 'string' ? (body as Problem) : undefined;
};

const jsonBody = async (response: Response): Promise<unknown> => {
    try {
        return JSON.parse(await response.text());
    } catch {
        return undefined;
    }
};

const humanLine = (problem: Partial<Problem>, reason: string): string => {
    if (problem.detail) return problem.detail;
    const errors = Array.isArray(problem.errors) ? problem.errors : [];
    if (errors.length) {
        return errors
        .map(e => `${e?.pointer ?? e?.parameter ?? e?.header}: ${e?.detail}`)
        .join('; ');
    }
    return problem.title || reason;
};

const toApiError = (response: Response, body: unknown): ApiError => {
    const problem: Partial<Problem> = asProblem(response, body) ?? {};
    const Ctor = BY_STATUS[response.status] ?? ApiError;
    return new Ctor(response.status, problem.code ?? 'error',
        humanLine(problem, reasonPhrase(response)), problem);
};

const peekErrorCode = async (response: Response): Promise<string | undefined> => {
    if (!isProblemType(response)) return undefined;
    return asProblem(response, await jsonBody(response.clone()))?.code;
};

const unwrap = <T>(result: { data?: T; error?: unknown; response: Response }): T => {
    if (!result.response.ok) throw toApiError(result.response, result.error);
    return result.data as T;
};

const raiseForResponse = async (response: Response): Promise<never> => {
    throw toApiError(response, await jsonBody(response));
};

export {
    ApiError,
    AuthError,
    GenesisError,
    InsufficientCreditsError,
    NotFoundError,
    TransportError,
    UploadError,
    ValidationError,
    peekErrorCode,
    raiseForResponse,
    unwrap
};
