import { HttpError } from './http-error';
import type { TokenSet } from './session';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/;
const ACCOUNT_NOT_SET_UP = 'Account is not fully set up';

type OidcEnv = {
    OIDC_ISSUER: string;
    OIDC_CLIENT_ID: string;
    OIDC_CLIENT_SECRET?: string;
};

type OidcConfig = {
    issuer: string;
    clientId: string;
    clientSecret: string;
};

type PkcePair = {
    verifier: string;
    challenge: string;
};

const errorDetail = (payload: any, fallback: string): string => {
    const detail = payload?.detail ?? payload?.error_description ?? payload?.error ?? fallback;
    if (typeof detail === 'string') return detail;
    if (detail && typeof detail.message === 'string') return detail.message;
    return fallback;
};

const validateEmail = (email: string): void => {
    if (!EMAIL_PATTERN.test(email) || email.length > 255) {
        throw new HttpError(400, 'Enter a valid email address.', 'invalid_email');
    }
};

const validateRegistration = (input: {
    firstName: string; lastName: string; email: string;
}): void => {
    validateEmail(input.email);
    if (!input.firstName || input.firstName.length > 100) {
        throw new HttpError(400, 'First Name is required.', 'invalid_first_name');
    }
    if (!input.lastName || input.lastName.length > 100) {
        throw new HttpError(400, 'Last Name is required.', 'invalid_last_name');
    }
};

const gatewayJson = async (baseUrl: string, pathname: string,
    init: Record<string, any> = {}): Promise<any> => {
    const response = await fetch(new URL(pathname, `${baseUrl.replace(/\/$/, '')}/`), init);
    const payload: any = response.status === 204 ?
        null :
        await response.json().catch((): null => null);
    if (!response.ok) {
        throw new HttpError(
            response.status,
            errorDetail(payload, `Genesis API returned ${response.status}.`),
            payload?.code || 'gateway_error'
        );
    }
    return payload;
};

const creditBalance = (baseUrl: string, apiKey: string): Promise<any> => {
    return gatewayJson(baseUrl, '/billing/credits', {
        headers: { Authorization: `Bearer ${apiKey}` }
    });
};

const oidcConfig = (env: OidcEnv): OidcConfig => {
    const issuer = String(env.OIDC_ISSUER || '').replace(/\/$/, '');
    const clientId = String(env.OIDC_CLIENT_ID || '');
    const clientSecret = String(env.OIDC_CLIENT_SECRET || '');
    if (!issuer || !clientId || !clientSecret) {
        throw new HttpError(503, 'Genesis authentication is not configured.', 'auth_not_configured');
    }
    return { issuer, clientId, clientSecret };
};

const tokenRequest = async (config: OidcConfig, body: URLSearchParams,
    fallback: string, code: string): Promise<TokenSet> => {
    body.set('client_id', config.clientId);
    body.set('client_secret', config.clientSecret);
    const response = await fetch(`${config.issuer}/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    });
    const payload = await response.json().catch((): null => null) as any;
    if (payload?.error === 'invalid_grant' && payload?.error_description === ACCOUNT_NOT_SET_UP) {
        throw new HttpError(403,
            'Verify your email address first: open the link we sent you, then sign in.',
            'account_setup_required');
    }
    if (!response.ok || !payload?.access_token) {
        throw new HttpError(
            response.status === 400 || response.status === 401 ? 401 : response.status,
            errorDetail(payload, fallback),
            code
        );
    }
    return {
        accessToken: String(payload.access_token),
        refreshToken: String(payload.refresh_token || ''),
        expiresIn: Number(payload.expires_in) || 0
    };
};

const base64Url = (bytes: Uint8Array): string => {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]+$/, '');
};

const pkcePair = async (): Promise<PkcePair> => {
    const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return { verifier, challenge: base64Url(new Uint8Array(digest)) };
};

const callbackUrl = (request: Request): string => new URL(
    '/api/reconstruction/auth/callback', request.url
).toString();

const authorizationUrl = (request: Request, env: OidcEnv, input: {
    state: string;
    challenge: string;
    provider?: string | null;
}): string => {
    const config = oidcConfig(env);
    const params = new URLSearchParams({
        client_id: config.clientId,
        response_type: 'code',
        scope: 'openid profile email',
        redirect_uri: callbackUrl(request),
        state: input.state,
        code_challenge: input.challenge,
        code_challenge_method: 'S256'
    });
    if (input.provider) params.set('kc_idp_hint', input.provider);
    return `${config.issuer}/protocol/openid-connect/auth?${params}`;
};

const exchangeAuthorizationCode = (request: Request, env: OidcEnv,
    code: string, verifier: string): Promise<TokenSet> => tokenRequest(
    oidcConfig(env),
    new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: callbackUrl(request)
    }),
    'Sign-in could not be completed.',
    'login_failed'
);

const refreshTokens = (env: OidcEnv, refreshToken: string): Promise<TokenSet> => {
    return tokenRequest(oidcConfig(env), new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken
    }), 'The session has expired.', 'session_expired');
};

const userInfo = async (env: OidcEnv, accessToken: string): Promise<{
    email?: string;
    name?: string;
    preferred_username?: string;
}> => {
    const response = await fetch(`${oidcConfig(env).issuer}/protocol/openid-connect/userinfo`, {
        headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok) {
        throw new HttpError(502, 'Signed in, but the account profile could not be loaded.',
            'profile_unavailable');
    }
    return await response.json();
};

const registerUser = (baseUrl: string, input: {
    firstName: string; lastName: string; email: string;
}, visitor: { ip: string | null; proxySecret?: string }): Promise<any> => gatewayJson(baseUrl, '/v1/auth/register', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        ...(visitor.ip && visitor.proxySecret ?
            { 'X-Genesis-Client-IP': visitor.ip, 'X-Genesis-Proxy-Secret': visitor.proxySecret } :
            {})
    },
    body: JSON.stringify({
        first_name: input.firstName,
        last_name: input.lastName,
        email: input.email
    })
});

export {
    type OidcEnv,
    type TokenSet,
    authorizationUrl,
    callbackUrl,
    creditBalance,
    errorDetail,
    exchangeAuthorizationCode,
    gatewayJson,
    pkcePair,
    refreshTokens,
    registerUser,
    userInfo,
    validateRegistration
};
