const SESSION_COOKIE = 'genesis_reconstruction_session';
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
// Renew with this much of the access token's life left, so a request that starts valid
// does not expire while it is still in flight upstream.
const ACCESS_REFRESH_MARGIN_MS = 60_000;
const SESSION_ID_BYTES = 32;

type SessionKind = 'oidc' | 'api-key';

/**
 * What the Durable Object holds. None of it reaches the browser: the cookie carries an
 * opaque id, and every credential here is used server-side on the session's behalf.
 */
type SessionRecord = {
    kind: SessionKind;
    accessToken: string;
    refreshToken: string;
    accessExpiresAt: number;
    apiKey: string;
    label: string;
    customerId: string;
    expiresAt: number;
    createdAt: number;
    updatedAt: number;
};

type Account = { label: string; customerId: string };

/** The bearer to present to Genesis right now, and who it belongs to. */
type Credential = { token: string; kind: SessionKind; account: Account };

type TokenSet = { accessToken: string; refreshToken: string; expiresIn: number };

interface SessionStorage {
    read(): SessionRecord | null;
    write(record: SessionRecord): void;
    clear(): void;
}

const toBase64Url = (bytes: Uint8Array): string => {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]+$/, '');
};

const newSessionId = (): string => toBase64Url(crypto.getRandomValues(new Uint8Array(SESSION_ID_BYTES)));

const accountOf = (record: SessionRecord): Account => ({
    label: record.label, customerId: record.customerId
});

const readCookie = (request: Request, name: string): string | null => {
    for (const part of String(request.headers.get('cookie') ?? '').split(';')) {
        const trimmed = part.trim();
        const split = trimmed.indexOf('=');
        if (split < 0) continue;
        if (trimmed.slice(0, split) !== name) continue;
        try {
            return decodeURIComponent(trimmed.slice(split + 1));
        } catch {
            return trimmed.slice(split + 1);
        }
    }
    return null;
};

const sessionCookieHeader = (value: string,
    opts: { secure: boolean; maxAgeSeconds: number }): string => {
    const attributes = [
        `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
        'HttpOnly',
        'SameSite=Strict',
        'Path=/',
        `Max-Age=${opts.maxAgeSeconds}`
    ];
    if (opts.secure) attributes.push('Secure');
    return attributes.join('; ');
};

/**
 * One session's lifecycle, kept independent of where it is stored so it can be driven
 * without a Durable Object runtime. The object it runs inside is single-threaded, and
 * `#refreshing` keeps that true across the one await that leaves it: without it every
 * request arriving during a renewal starts a renewal of its own.
 */
class SessionState {
    readonly #storage: SessionStorage;
    readonly #now: () => number;
    readonly #refreshTokens: (refreshToken: string) => Promise<TokenSet>;
    #refreshing: Promise<SessionRecord | null> | null = null;

    constructor(storage: SessionStorage, deps: {
        refreshTokens: (refreshToken: string) => Promise<TokenSet>;
        now?: () => number;
    }) {
        this.#storage = storage;
        this.#refreshTokens = deps.refreshTokens;
        this.#now = deps.now ?? Date.now;
    }

    create(input: {
        kind: SessionKind; label: string; customerId: string;
        accessToken?: string; refreshToken?: string; expiresIn?: number; apiKey?: string;
    }): Account {
        const now = this.#now();
        const record: SessionRecord = {
            kind: input.kind,
            accessToken: input.accessToken ?? '',
            refreshToken: input.refreshToken ?? '',
            accessExpiresAt: input.expiresIn ? now + input.expiresIn * 1000 : 0,
            apiKey: input.apiKey ?? '',
            label: input.label,
            customerId: input.customerId,
            // Absolute, and never extended by activity: a session alive for a week ends,
            // whatever the user happens to be doing with it.
            expiresAt: now + SESSION_LIFETIME_MS,
            createdAt: now,
            updatedAt: now
        };
        this.#storage.write(record);
        return accountOf(record);
    }

    /** The credential to use now, renewed first if it is about to lapse. */
    async credential(): Promise<Credential | null> {
        const record = this.#live();
        if (!record) return null;
        if (record.kind === 'api-key') {
            return { token: record.apiKey, kind: 'api-key', account: accountOf(record) };
        }
        const fresh = record.accessExpiresAt - this.#now() > ACCESS_REFRESH_MARGIN_MS ?
            record :
            await this.#renew();
        if (!fresh) return null;
        return { token: fresh.accessToken, kind: 'oidc', account: accountOf(fresh) };
    }

    /**
     * Genesis rejected the credential anyway. One renewal is tried; anything else ends
     * the session, because a login screen is the only honest answer left.
     */
    async reauthenticate(): Promise<Credential | null> {
        const record = this.#live();
        if (!record || record.kind !== 'oidc') {
            this.destroy();
            return null;
        }
        const fresh = await this.#renew();
        if (!fresh) return null;
        return { token: fresh.accessToken, kind: 'oidc', account: accountOf(fresh) };
    }

    account(): Account | null {
        const record = this.#live();
        return record ? accountOf(record) : null;
    }

    /** When this session dies whatever happens, for whoever schedules the cleanup. */
    expiresAt(): number | null {
        return this.#storage.read()?.expiresAt ?? null;
    }

    destroy(): void {
        this.#storage.clear();
    }

    #live(): SessionRecord | null {
        const record = this.#storage.read();
        if (!record) return null;
        if (record.expiresAt <= this.#now()) {
            this.#storage.clear();
            return null;
        }
        return record;
    }

    #renew(): Promise<SessionRecord | null> {
        this.#refreshing ??= this.#renewOnce().finally(() => {
            this.#refreshing = null;
        });
        return this.#refreshing;
    }

    async #renewOnce(): Promise<SessionRecord | null> {
        const record = this.#live();
        // No refresh token means the session was only ever good for one access token's
        // lifetime. Minting a long-lived key to paper over that is not on the table.
        if (!record || !record.refreshToken) {
            this.destroy();
            return null;
        }
        let tokens: TokenSet;
        try {
            tokens = await this.#refreshTokens(record.refreshToken);
        } catch {
            this.destroy();
            return null;
        }
        const now = this.#now();
        const renewed: SessionRecord = {
            ...record,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken || record.refreshToken,
            accessExpiresAt: now + tokens.expiresIn * 1000,
            updatedAt: now
        };
        this.#storage.write(renewed);
        return renewed;
    }
}

export {
    ACCESS_REFRESH_MARGIN_MS,
    SESSION_COOKIE,
    SESSION_LIFETIME_MS,
    SessionState,
    type Account,
    type Credential,
    type SessionKind,
    type SessionRecord,
    type SessionStorage,
    type TokenSet,
    accountOf,
    newSessionId,
    readCookie,
    sessionCookieHeader
};
