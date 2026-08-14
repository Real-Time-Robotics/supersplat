const HOP_BY_HOP = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade',
    'content-encoding', 'content-length'
]);
const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept', 'idempotency-key', 'last-event-id'];

const PROXY_PREFIX = '/api/gp';

class ProxyDenied extends Error {}

/**
 * Forward one request to the gateway under the session's api key
 */
const proxyToGateway = async (request: Request, apiKey: string,
    baseUrl: string): Promise<Response> => {
    const incoming = new URL(request.url);
    const origin = new URL(baseUrl).origin;
    const target = new URL(incoming.pathname.slice(PROXY_PREFIX.length) + incoming.search, baseUrl);
    if (target.origin !== origin || !target.pathname.startsWith('/v1/')) throw new ProxyDenied();

    const headers = new Headers({ Authorization: `Bearer ${apiKey}` });
    for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
    }
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const init: Record<string, any> = { method: request.method, headers, signal: request.signal };
    if (hasBody) {
        init.body = request.body;
        init.duplex = 'half';
    }
    const upstream = await fetch(target, init);

    const responseHeaders = new Headers();
    for (const [name, value] of upstream.headers) {
        if (!HOP_BY_HOP.has(name.toLowerCase())) responseHeaders.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
};

export { PROXY_PREFIX, ProxyDenied, proxyToGateway };
