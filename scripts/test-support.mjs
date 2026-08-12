import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

import { handle } from '../src/backend/router.ts';
import { ReconstructionSession } from '../src/backend/session-object.ts';

const doStorage = () => {
    const db = new DatabaseSync(':memory:');
    const state = { alarm: null };
    const sql = {
        exec: (query, ...bindings) => {
            const statement = db.prepare(query);
            const reads = /^\s*(SELECT|PRAGMA)/i.test(query) || /\bRETURNING\b/i.test(query);
            const rows = reads ? statement.all(...bindings) : (statement.run(...bindings), []);
            return { toArray: () => rows };
        }
    };
    return {
        sql,
        setAlarm: async (at) => {
            state.alarm = at;
        },
        deleteAlarm: async () => {
            state.alarm = null;
        },
        getAlarm: async () => state.alarm,
        tableNames: () => db.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name),
        deleteAll: async () => {
            for (const { name } of db.prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
                db.exec(`DROP TABLE "${name}"`);
            }
            state.alarm = null;
        }
    };
};

const sqlStorage = () => doStorage().sql;

const sessionNamespace = (env) => {
    const objects = new Map();
    const storages = new Map();
    return {
        idFromName: name => name,
        get: (id) => {
            if (!objects.has(id)) {
                const storage = doStorage();
                storages.set(id, storage);
                objects.set(id, new ReconstructionSession({ storage }, env));
            }
            return objects.get(id);
        },
        forget: id => objects.delete(id),
        storageOf: id => storages.get(id),
        count: () => objects.size
    };
};

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

export { call, doStorage, envFor, listenOnRandomPort, sendJson, signInWithApiKey, sqlStorage };
