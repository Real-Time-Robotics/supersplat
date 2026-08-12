import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

import { handle } from '../src/backend/router.ts';
import { ReconstructionSession } from '../src/backend/session-object.ts';

/**
 * The shape Cloudflare hands a Durable Object as `ctx.storage`, over real SQLite -- so the
 * schema and every statement in session-object.ts are exercised, not stubbed. `deleteAll`
 * drops the tables, which is what it does to a SQLite-backed object: a no-op here hid a
 * "no such table: session" that every request after a logout would have hit.
 */
const doStorage = () => {
    const db = new DatabaseSync(':memory:');
    const state = { alarm: null };
    const sql = {
        exec: (query, ...bindings) => {
            const statement = db.prepare(query);
            const reads = /^\s*SELECT/i.test(query);
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

/** A stand-in for the DO namespace binding: one live object per session id. */
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
        // Tests reach in to drive what only the runtime would: eviction, and the alarm.
        forget: id => objects.delete(id),
        storageOf: id => storages.get(id)
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

/** Call the backend the way a browser would. `path` is origin-relative. */
const call = (env, path, init = {}) =>
    handle(new Request(`https://editor.test${path}`, init), env);

/** Sign in with an api key and return the cookie pair for subsequent requests. */
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
