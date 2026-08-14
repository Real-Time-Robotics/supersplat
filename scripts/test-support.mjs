import { once } from 'node:events';

import { handle } from '../src/backend/router.ts';
import { sessionNamespace } from './session-namespace.mjs';

const listenOnRandomPort = async (server) => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server.address().port;
};

const sendJson = (res, status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
};

const envFor = (gatewayPort) => {
    const env = { GENESIS_BASE_URL: `http://127.0.0.1:${gatewayPort}` };
    env.RECON_SESSIONS = sessionNamespace(env);
    return env;
};

const call = (env, path, init = {}) =>
    handle(new Request(`https://editor.test${path}`, init), env);

const signInWithApiKey = async (env, apiKey = 'gp_live_test') => {
    const response = await call(env, '/api/reconstruction/session/api-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey })
    });
    if (response.status !== 200) throw new Error(`sign-in returned ${response.status}`);
    return response.headers.getSetCookie()[0].split(';')[0];
};

export { call, envFor, listenOnRandomPort, sendJson, signInWithApiKey };
