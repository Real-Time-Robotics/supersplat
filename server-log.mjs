import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const RETENTION_DAYS = 14;

const SECRET_QUERY_KEYS = new Set([
    'x-amz-signature',
    'x-amz-credential',
    'x-amz-security-token',
    'signature',
    'token',
    'access_token',
    'key'
]);

const level = LEVELS[String(process.env.SUPERSPLAT_LOG_LEVEL || '').toLowerCase()] ?? LEVELS.info;

let logDir = null;
let stream = null;
let streamDay = null;

const dayStamp = (date = new Date()) => date.toISOString().slice(0, 10);

const pruneOldLogs = async (dir) => {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const names = await readdir(dir).catch(() => []);
    await Promise.all(names
    .filter(name => name.startsWith('server-') && name.endsWith('.log'))
    .map(async (name) => {
        const full = path.join(dir, name);
        const info = await stat(full).catch(() => null);
        if (info && info.mtimeMs < cutoff) await rm(full, { force: true }).catch(() => undefined);
    }));
};

/** Create the log directory and open today's file. Safe to call more than once. */
const initLogging = async (dir) => {
    logDir = dir;
    await mkdir(dir, { recursive: true });
    await pruneOldLogs(dir);
    return currentLogPath();
};

const currentLogPath = () => (logDir ? path.join(logDir, `server-${dayStamp()}.log`) : null);

const streamFor = () => {
    if (!logDir) return null;
    const today = dayStamp();
    if (stream && streamDay === today) return stream;
    stream?.end();
    streamDay = today;
    stream = createWriteStream(currentLogPath(), { flags: 'a' });
    // A logging failure must never take the server down with it.
    stream.on('error', () => undefined);
    return stream;
};

const redactUrl = (input) => {
    let url;
    try {
        url = new URL(String(input));
    } catch {
        return String(input).split('?')[0];
    }
    for (const name of [...url.searchParams.keys()]) {
        if (SECRET_QUERY_KEYS.has(name.toLowerCase())) url.searchParams.set(name, 'REDACTED');
    }
    return url.toString();
};

const isPlainObject = value => value != null && typeof value === 'object' && !Array.isArray(value);

const describeError = (error, depth = 0) => {
    if (error == null) return { message: String(error) };
    if (typeof error !== 'object') return { message: String(error) };

    const described = {
        name: error.name || error.constructor?.name || 'Error',
        message: error.message || String(error)
    };

    if (typeof error.code === 'string') described.code = error.code;
    if (error.errno != null) described.errno = error.errno;
    if (error.syscall != null) described.syscall = error.syscall;
    if (error.status != null) described.status = error.status;
    if (typeof error.detail === 'string') described.detail = error.detail;
    if (isPlainObject(error.data)) described.data = error.data;
    if (described.name === 'TimeoutError' || described.name === 'AbortError') {
        described.aborted = true;
    }
    if (typeof error.stack === 'string') {
        described.stack = error.stack.split('\n').slice(0, 12).join('\n');
    }

    if (depth < 4) {
        if (error.cause != null) described.cause = describeError(error.cause, depth + 1);
        if (Array.isArray(error.errors) && error.errors.length > 0) {
            described.errors = error.errors.slice(0, 8).map(e => describeError(e, depth + 1));
        }
    }
    return described;
};

const errorSummary = (error) => {
    const described = describeError(error);
    const codes = [];
    for (let node = described; node; node = node.cause) {
        if (node.code && !codes.includes(node.code)) codes.push(node.code);
        if (node.status != null && !codes.includes(`HTTP ${node.status}`)) codes.push(`HTTP ${node.status}`);
    }
    const inner = described.errors?.[0]?.code;
    if (inner && !codes.includes(inner)) codes.push(inner);
    return codes.length > 0 ? `${described.message} (${codes.join(' / ')})` : described.message;
};

const write = (levelName, event, fields) => {
    if (LEVELS[levelName] < level) return;
    const record = { ts: new Date().toISOString(), level: levelName, event, ...fields };
    let line;
    try {
        line = JSON.stringify(record);
    } catch {
        line = JSON.stringify({ ts: record.ts, level: levelName, event, note: 'record was not serializable' });
    }
    streamFor()?.write(`${line}\n`);

    const context = Object.entries(fields || {})
    .filter(([k, v]) => k !== 'error' && k !== 'stack' && k !== 'summary' && v != null && typeof v !== 'object')
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
    const suffix = fields?.summary ? ` :: ${fields.summary}` : '';
    const target = levelName === 'error' ? console.error : levelName === 'warn' ? console.warn : console.log;
    target(`[recon] ${event}${context ? ` ${context}` : ''}${suffix}`);
};

const logger = {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
    /** Attach a thrown value to a log record with its full cause chain. */
    fail: (event, error, fields = {}) => write('error', event, {
        ...fields,
        summary: errorSummary(error),
        error: describeError(error)
    })
};

const instrumentFetch = (fetchImpl, { gatewayOrigin, context = {} } = {}) => {
    const attempts = new Map();

    return async (input, init) => {
        const isRequest = typeof input === 'object' && input !== null && !(input instanceof URL);
        const url = isRequest ? String(input.url ?? '') : String(input);
        const method = String(init?.method ?? (isRequest ? input.method : undefined) ?? 'GET').toUpperCase();

        let origin = '';
        let route = url;
        try {
            const parsed = new URL(url);
            origin = parsed.origin;
            route = parsed.pathname;
        } catch {
            // A relative or malformed URL: keep the raw string as the route.
        }
        const target = gatewayOrigin && origin === gatewayOrigin ? 'gateway' : 'store';

        const key = `${method} ${target}:${route}`;
        const attempt = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, attempt);

        const base = { ...context, target, method, route, attempt, url: redactUrl(url) };
        const started = Date.now();
        let response;
        try {
            response = await fetchImpl(input, init);
        } catch (error) {
            logger.fail('http.error', error, { ...base, ms: Date.now() - started });
            throw error;
        }

        const ms = Date.now() - started;
        const fields = { ...base, ms, status: response.status };
        const contentLength = response.headers.get('content-length');
        if (contentLength) fields.bytes = Number(contentLength);

        if (response.status >= 400) {
            fields.body = await response.clone().text()
            .then(text => text.slice(0, 2000))
            .catch(() => '<unreadable>');
            logger.error('http.status', fields);
        } else if (ms > 15_000) {
            logger.warn('http.slow', fields);
        } else {
            logger.debug('http.ok', fields);
        }
        return response;
    };
};

export { describeError, errorSummary, initLogging, instrumentFetch, logger, redactUrl, currentLogPath };
