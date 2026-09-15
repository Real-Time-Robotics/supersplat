import { HttpError } from './http-error';
import type { TokenSet } from './session';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/;
const ACCOUNT_NOT_SET_UP = 'Account is not fully set up';

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

const validateLogin = (email: string, password: string): void => {
    validateEmail(email);
    if (!password || password.length > 256) {
        throw new HttpError(400, 'Enter your password.', 'invalid_password');
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

const oidcConfig = async (baseUrl: string): Promise<{ issuer: string; clientId: string }> => {
    const config = await gatewayJson(baseUrl, '/v1/config');
    const issuer = String(config?.oidc_issuer || '').replace(/\/$/, '');
    const clientId = String(config?.oidc_client_id || '');
    if (!issuer || !clientId) {
        throw new HttpError(503, 'Genesis authentication is not configured.', 'auth_not_configured');
    }
    return { issuer, clientId };
};

const tokenRequest = async (issuer: string, body: URLSearchParams,
    fallback: string, code: string): Promise<TokenSet> => {
    const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
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

const passwordLogin = async (baseUrl: string, email: string,
    password: string): Promise<TokenSet> => {
    const { issuer, clientId } = await oidcConfig(baseUrl);
    return tokenRequest(issuer, new URLSearchParams({
        grant_type: 'password',
        client_id: clientId,
        username: email,
        password,
        scope: 'openid'
    }), 'Email or password is incorrect.', 'login_failed');
};

const refreshTokens = async (baseUrl: string, refreshToken: string): Promise<TokenSet> => {
    const { issuer, clientId } = await oidcConfig(baseUrl);
    return tokenRequest(issuer, new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refreshToken
    }), 'The session has expired.', 'session_expired');
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
    type TokenSet,
    creditBalance,
    errorDetail,
    gatewayJson,
    passwordLogin,
    refreshTokens,
    registerUser,
    validateLogin,
    validateRegistration
};
