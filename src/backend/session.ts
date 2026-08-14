const SESSION_COOKIE = 'genesis_reconstruction_session';
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const ACCESS_REFRESH_MARGIN_MS = 60_000;
const SESSION_ID_BYTES = 32;
const SESSION_ID_RE = /^[\w-]{43}$/;

type SessionKind = 'oidc' | 'api-key';

type SessionRecord = {
    version: number;
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

type Credential = { token: string; kind: SessionKind; account: Account };

type TokenSet = { accessToken: string; refreshToken: string; expiresIn: number };

type SessionInput = {
    kind: SessionKind; label: string; customerId: string;
    accessToken?: string; refreshToken?: string; expiresIn?: number; apiKey?: string;
};

interface SessionStorage {
    read(): SessionRecord | null;
    write(record: SessionRecord): void;
    writeIfVersion(record: SessionRecord, version: number): boolean;
    clear(version?: number): boolean;
}

const toBase64Url = (bytes: Uint8Array): string => {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]+$/, '');
};

const newSessionId = (): string => toBase64Url(crypto.getRandomValues(new Uint8Array(SESSION_ID_BYTES)));
const isSessionId = (value: string): boolean => SESSION_ID_RE.test(value);

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

/** Coalesces refreshes and fences stale writes. */
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

    create(input: SessionInput): Account {
        const now = this.#now();
        const record: SessionRecord = {
            version: 1,
            kind: input.kind,
            accessToken: input.accessToken ?? '',
            refreshToken: input.refreshToken ?? '',
            accessExpiresAt: input.expiresIn ? now + input.expiresIn * 1000 : 0,
            apiKey: input.apiKey ?? '',
            label: input.label,
            customerId: input.customerId,
            expiresAt: now + SESSION_LIFETIME_MS,
            createdAt: now,
            updatedAt: now
        };
        this.#storage.write(record);
        return accountOf(record);
    }

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
            this.#storage.clear(record.version);
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
        if (!record || !record.refreshToken) {
            this.#storage.clear(record?.version);
            return null;
        }
        let tokens: TokenSet;
        try {
            tokens = await this.#refreshTokens(record.refreshToken);
        } catch {
            this.#storage.clear(record.version);
            return null;
        }
        const now = this.#now();
        const renewed: SessionRecord = {
            ...record,
            version: record.version + 1,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken || record.refreshToken,
            accessExpiresAt: now + tokens.expiresIn * 1000,
            updatedAt: now
        };
        return this.#storage.writeIfVersion(renewed, record.version) ? renewed : null;
    }
}

export {
    SESSION_COOKIE,
    SESSION_LIFETIME_MS,
    SessionState,
    type Account,
    type Credential,
    type SessionKind,
    type SessionInput,
    type SessionRecord,
    type SessionStorage,
    type TokenSet,
    isSessionId,
    newSessionId,
    readCookie,
    sessionCookieHeader
};
