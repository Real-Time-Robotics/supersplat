import { DatabaseSync } from 'node:sqlite';

import { RateLimiter } from '../src/backend/rate-limiter.ts';
import { ReconstructionSession } from '../src/backend/session-object.ts';

const tableNamesOf = db => db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name);

const doStorage = () => {
    const db = new DatabaseSync(':memory:');
    const values = new Map();
    const state = { alarm: null };
    const sql = {
        exec: (query, ...bindings) => {
            const statement = db.prepare(query);
            // Match Workers for PRAGMA and RETURNING rows.
            const reads = /^\s*(SELECT|PRAGMA)/i.test(query) || /\bRETURNING\b/i.test(query);
            const rows = reads ? statement.all(...bindings) : (statement.run(...bindings), []);
            return { toArray: () => rows };
        }
    };
    return {
        sql,
        get: async key => structuredClone(values.get(key)),
        put: async (key, value) => {
            values.set(key, structuredClone(value));
        },
        setAlarm: async (at) => {
            state.alarm = at;
        },
        deleteAlarm: async () => {
            state.alarm = null;
        },
        getAlarm: async () => state.alarm,
        tableNames: () => tableNamesOf(db),
        deleteAll: async () => {
            for (const name of tableNamesOf(db)) db.exec(`DROP TABLE "${name}"`);
            values.clear();
            state.alarm = null;
        }
    };
};

const objectNamespace = (create) => {
    const objects = new Map();
    const storages = new Map();
    return {
        idFromName: name => name,
        get: (id) => {
            if (!objects.has(id)) {
                const storage = doStorage();
                storages.set(id, storage);
                objects.set(id, create({ storage }));
            }
            return objects.get(id);
        },
        storageOf: id => storages.get(id),
        count: () => objects.size
    };
};

const sessionNamespace = env => objectNamespace(ctx => new ReconstructionSession(ctx, env));

const limiterNamespace = () => objectNamespace(ctx => new RateLimiter(ctx, {}));

export { limiterNamespace, sessionNamespace };
