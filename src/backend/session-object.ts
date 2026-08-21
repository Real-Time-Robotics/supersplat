import { refreshTokens } from './auth';
import {
    SessionState,
    type SessionInput,
    type SessionKind,
    type SessionRecord,
    type SessionStorage
} from './session';

const SCHEMA = `CREATE TABLE IF NOT EXISTS session(
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  version           INTEGER NOT NULL DEFAULT 1,
  kind              TEXT    NOT NULL,
  access_token      TEXT    NOT NULL DEFAULT '',
  refresh_token     TEXT    NOT NULL DEFAULT '',
  access_expires_at INTEGER NOT NULL DEFAULT 0,
  api_key           TEXT    NOT NULL DEFAULT '',
  label             TEXT    NOT NULL DEFAULT '',
  customer_id       TEXT    NOT NULL DEFAULT '',
  expires_at        INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
)`;

type SessionRow = {
    version: number;
    kind: string;
    access_token: string;
    refresh_token: string;
    access_expires_at: number;
    api_key: string;
    label: string;
    customer_id: string;
    expires_at: number;
    created_at: number;
    updated_at: number;
};

const missingTable = (error: unknown): boolean => String(error).includes('no such table: session');

const sqliteStorage = (sql: SqlStorage): SessionStorage => ({
    read(): SessionRecord | null {
        let row;
        try {
            [row] = sql.exec<SessionRow>('SELECT * FROM session WHERE id = 1').toArray();
        } catch (error) {
            if (missingTable(error)) return null;
            throw error;
        }
        if (!row) return null;
        return {
            version: Number(row.version),
            kind: row.kind as SessionKind,
            accessToken: row.access_token,
            refreshToken: row.refresh_token,
            accessExpiresAt: Number(row.access_expires_at),
            apiKey: row.api_key,
            label: row.label,
            customerId: row.customer_id,
            expiresAt: Number(row.expires_at),
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at)
        };
    },
    write(record: SessionRecord): void {
        sql.exec(
            `INSERT INTO session(id, version, kind, access_token, refresh_token, access_expires_at,
                                 api_key, label, customer_id, expires_at, created_at,
                                 updated_at)
             VALUES(1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               version = excluded.version,
               kind = excluded.kind,
               access_token = excluded.access_token,
               refresh_token = excluded.refresh_token,
               access_expires_at = excluded.access_expires_at,
               api_key = excluded.api_key,
               label = excluded.label,
               customer_id = excluded.customer_id,
               expires_at = excluded.expires_at,
               updated_at = excluded.updated_at`,
            record.version, record.kind, record.accessToken, record.refreshToken, record.accessExpiresAt,
            record.apiKey, record.label, record.customerId, record.expiresAt,
            record.createdAt, record.updatedAt
        );
    },
    writeIfVersion(record: SessionRecord, version: number): boolean {
        try {
            return sql.exec(
                `UPDATE session SET version = ?, kind = ?, access_token = ?, refresh_token = ?,
                                    access_expires_at = ?, api_key = ?, label = ?, customer_id = ?,
                                    expires_at = ?, created_at = ?, updated_at = ?
                   WHERE id = 1 AND version = ? RETURNING version`,
                record.version, record.kind, record.accessToken, record.refreshToken,
                record.accessExpiresAt, record.apiKey, record.label, record.customerId,
                record.expiresAt, record.createdAt, record.updatedAt, version
            ).toArray().length === 1;
        } catch (error) {
            if (missingTable(error)) return false;
            throw error;
        }
    },
    clear(version?: number): boolean {
        const query = version === undefined ?
            'DELETE FROM session RETURNING version' :
            'DELETE FROM session WHERE version = ? RETURNING version';
        try {
            return sql.exec(query, ...(version === undefined ? [] : [version])).toArray().length > 0;
        } catch (error) {
            if (missingTable(error)) return false;
            throw error;
        }
    }
});

const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
    status, headers: { 'Content-Type': 'application/json' }
});

class ReconstructionSession {
    readonly #state: SessionState;
    readonly #ctx: DurableObjectState;
    #schemaReady = false;

    constructor(ctx: DurableObjectState, env: { GENESIS_BASE_URL: string }) {
        this.#ctx = ctx;
        this.#state = new SessionState(sqliteStorage(ctx.storage.sql), {
            refreshTokens: token => refreshTokens(env.GENESIS_BASE_URL, token)
        });
    }

    #ensureSchema(): void {
        if (this.#schemaReady) return;
        const sql = this.#ctx.storage.sql;
        sql.exec(SCHEMA);
        const columns = sql.exec<{ name: string }>('PRAGMA table_info(session)').toArray();
        if (!columns.some(column => column.name === 'version')) {
            sql.exec('ALTER TABLE session ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
        }
        this.#schemaReady = true;
    }

    async #erase(): Promise<void> {
        await this.#ctx.storage.deleteAlarm?.();
        await this.#ctx.storage.deleteAll?.();
        this.#schemaReady = false;
    }

    async alarm(): Promise<void> {
        await this.#erase();
    }

    async fetch(request: Request): Promise<Response> {
        this.#ensureSchema();
        const { pathname } = new URL(request.url);
        if (pathname === '/create') {
            const account = this.#state.create(await request.json() as SessionInput);
            const expiresAt = this.#state.expiresAt();
            if (expiresAt) await this.#ctx.storage.setAlarm?.(expiresAt);
            return json({ account });
        }
        if (pathname === '/credential') {
            const credential = await this.#state.credential();
            if (!credential) await this.#erase();
            return credential ? json(credential) : json({ error: 'expired' }, 401);
        }
        if (pathname === '/reauthenticate') {
            const credential = await this.#state.reauthenticate();
            if (!credential) await this.#erase();
            return credential ? json(credential) : json({ error: 'expired' }, 401);
        }
        if (pathname === '/destroy') {
            this.#state.destroy();
            await this.#erase();
            return new Response(null, { status: 204 });
        }
        return json({ error: 'not found' }, 404);
    }
}

export { ReconstructionSession };
