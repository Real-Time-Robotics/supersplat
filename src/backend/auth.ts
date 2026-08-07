import { HttpError } from './http-error';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/;

const errorDetail = (payload: any, fallback: string): string => {
    const detail = payload?.detail ?? payload?.error_description ?? payload?.error ?? fallback;
    if (typeof detail === 'string') return detail;
    if (detail && typeof detail.message === 'string') return detail.message;
    return fallback;
};

const validateLogin = (email: string, password: string): void => {
    if (!EMAIL_PATTERN.test(email) || email.length > 255) {
        throw new HttpError(400, 'Enter a valid email address.', 'invalid_email');
    }
    if (!password || password.length > 256) {
        throw new HttpError(400, 'Enter your password.', 'invalid_password');
    }
};

const validateRegistration = (input: {
    firstName: string; lastName: string; email: string;
    password: string; confirmPassword: string;
}): void => {
    validateLogin(input.email, input.password);
    if (!input.firstName || input.firstName.length > 100) {
        throw new HttpError(400, 'First Name is required.', 'invalid_first_name');
    }
    if (!input.lastName || input.lastName.length > 100) {
        throw new HttpError(400, 'Last Name is required.', 'invalid_last_name');
    }
    if (input.password.length < 6) {
        throw new HttpError(400, 'Password must contain at least 6 characters.', 'password_too_short');
    }
    if (!input.confirmPassword || input.password !== input.confirmPassword) {
        throw new HttpError(400, 'Passwords do not match.', 'password_mismatch');
    }
};

const gatewayJson = async (baseUrl: string, pathname: string,
    init: Record<string, any> = {}): Promise<any> => {
    const response = await fetch(new URL(pathname, `${baseUrl.replace(/\/$/, '')}/`), init);
    const payload = response.status === 204 ?
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

const passwordLogin = async (baseUrl: string, email: string,
    password: string): Promise<string> => {
    const config = await gatewayJson(baseUrl, '/v1/config');
    const issuer = String(config?.oidc_issuer || '').replace(/\/$/, '');
    const clientId = String(config?.oidc_client_id || '');
    if (!issuer || !clientId) {
        throw new HttpError(503, 'Genesis authentication is not configured.', 'auth_not_configured');
    }
    const body = new URLSearchParams({
        grant_type: 'password',
        client_id: clientId,
        username: email,
        password,
        scope: 'openid'
    });
    const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    });
    const payload = await response.json().catch((): null => null) as any;
    if (!response.ok || !payload?.access_token) {
        throw new HttpError(
            response.status === 400 || response.status === 401 ? 401 : response.status,
            errorDetail(payload, 'Email or password is incorrect.'),
            'login_failed'
        );
    }
    return payload.access_token;
};

const createSuperSplatKey = async (baseUrl: string,
    accessToken: string): Promise<{ apiKey: string; customerId: string }> => {
    const headers = { Authorization: `Bearer ${accessToken}` };
    const listed = await gatewayJson(baseUrl, '/v1/api-keys', { headers });
    const keys = Array.isArray(listed) ? listed : (listed?.api_keys || listed?.keys || []);
    const existing = keys.filter((key: any) => key?.name === 'SuperSplat Reconstruction' &&
        !key?.revoked_at);
    await Promise.all(existing.map((key: any) => gatewayJson(baseUrl, `/v1/api-keys/${encodeURIComponent(key.id)}`, {
        method: 'DELETE',
        headers
    })));
    const created = await gatewayJson(baseUrl, '/v1/api-keys', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'SuperSplat Reconstruction' })
    });
    const apiKey = created?.key || created?.api_key;
    if (!apiKey) {
        throw new HttpError(502, 'Genesis did not return the newly created API key.',
            'missing_api_key');
    }
    return { apiKey, customerId: created?.customer_id || '' };
};

const registerUser = (baseUrl: string, input: {
    firstName: string; lastName: string; email: string; password: string;
}): Promise<any> => gatewayJson(baseUrl, '/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        first_name: input.firstName,
        last_name: input.lastName,
        email: input.email,
        password: input.password
    })
});

export {
    createSuperSplatKey,
    creditBalance,
    errorDetail,
    gatewayJson,
    passwordLogin,
    registerUser,
    validateLogin,
    validateRegistration
};
