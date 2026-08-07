const SESSION_COOKIE = 'genesis_reconstruction_session';
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const IV_BYTES = 12;

type SessionData = { apiKey: string; label: string; customerId: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// The secret is an arbitrary-length string
const keyFor = async (secret: string): Promise<CryptoKey> => {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
    return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
};

const toBase64Url = (bytes: Uint8Array): string => {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]+$/, '');
};

const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> | null => {
    try {
        const padded = text.replace(/-/g, '+').replace(/_/g, '/');
        const binary = atob(padded + '='.repeat((4 - padded.length % 4) % 4));
        return Uint8Array.from(binary, character => character.charCodeAt(0));
    } catch {
        return null;
    }
};

const sealSession = async (data: SessionData, secret: string, now: number): Promise<string> => {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const payload = encoder.encode(JSON.stringify({ ...data, exp: now + SESSION_LIFETIME_MS }));
    const sealed = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv }, await keyFor(secret), payload
    ));
    const joined = new Uint8Array(iv.length + sealed.length);
    joined.set(iv);
    joined.set(sealed, iv.length);
    return toBase64Url(joined);
};

const openSession = async (token: string, secret: string,
    now: number): Promise<SessionData | null> => {
    const joined = token ? fromBase64Url(token) : null;
    if (!joined || joined.length <= IV_BYTES) return null;
    try {
        const plain = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: joined.subarray(0, IV_BYTES) },
            await keyFor(secret),
            joined.subarray(IV_BYTES)
        );
        const parsed = JSON.parse(decoder.decode(plain));
        if (typeof parsed?.exp !== 'number' || parsed.exp <= now) return null;
        if (typeof parsed.apiKey !== 'string' || !parsed.apiKey) return null;
        return {
            apiKey: parsed.apiKey,
            label: String(parsed.label ?? ''),
            customerId: String(parsed.customerId ?? '')
        };
    } catch {
        return null;
    }
};

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

export {
    SESSION_COOKIE,
    SESSION_LIFETIME_MS,
    type SessionData,
    openSession,
    readCookie,
    sealSession,
    sessionCookieHeader
};
