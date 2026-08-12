import { refreshTokens } from './auth';
import { SessionState, type SessionRecord, type SessionStorage } from './session';

/**
 * SQLite-backed, which is the only kind of Durable Object the Workers Free plan offers.
 * One object per session id: it holds the credentials the browser never sees, and its
 * single-threadedness is what makes "refresh exactly once" achievable at all.
 */
const SCHEMA = `CREATE TABLE IF NOT EXISTS session(
  id                INTEGER PRIMARY KEY CHECK (id = 1),
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

type SqlStorage = {
    exec: (query: string, ...bindings: unknown[]) => { toArray: () => any[] };
};

const sqliteStorage = (sql: SqlStorage): SessionStorage => ({
    read(): SessionRecord | null {
        const [row] = sql.exec('SELECT * FROM session WHERE id = 1').toArray();
        if (!row) return null;
        return {
            kind: row.kind,
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
            `INSERT INTO session(id, kind, access_token, refresh_token, access_expires_at,
                                 api_key, label, customer_id, expires_at, created_at,
                                 updated_at)
             VALUES(1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               kind = excluded.kind,
               access_token = excluded.access_token,
               refresh_token = excluded.refresh_token,
               access_expires_at = excluded.access_expires_at,
               api_key = excluded.api_key,
               label = excluded.label,
               customer_id = excluded.customer_id,
               expires_at = excluded.expires_at,
               updated_at = excluded.updated_at`,
            record.kind, record.accessToken, record.refreshToken, record.accessExpiresAt,
            record.apiKey, record.label, record.customerId, record.expiresAt,
            record.createdAt, record.updatedAt
        );
    },
    clear(): void {
        sql.exec('DELETE FROM session');
    }
});

const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
    status, headers: { 'Content-Type': 'application/json' }
});

/**
 * Routes the object answers. Only the worker reaches these -- a Durable Object binding is
 * not addressable from outside the Worker.
 */
class ReconstructionSession {
    readonly #state: SessionState;
    readonly #ctx: any;

    constructor(ctx: any, env: { GENESIS_BASE_URL: string }) {
        this.#ctx = ctx;
        this.#ensureSchema();
        this.#state = new SessionState(sqliteStorage(ctx.storage.sql), {
            refreshTokens: token => refreshTokens(env.GENESIS_BASE_URL, token)
        });
    }

    /**
     * `deleteAll()` on a SQLite-backed object drops the database itself, tables included --
     * and the object stays in memory afterwards, so the next request would meet
     * "no such table: session". The schema is therefore re-asserted per request rather
     * than once per construction.
     */
    #ensureSchema(): void {
        this.#ctx.storage.sql.exec(SCHEMA);
    }

    /** Nothing is left of this session, on disk or on the clock. */
    async #erase(): Promise<void> {
        await this.#ctx.storage.deleteAlarm?.();
        await this.#ctx.storage.deleteAll?.();
        this.#ensureSchema();
    }

    /**
     * A session nobody comes back to must not sit on a refresh token until the account is
     * deleted. The alarm fires at the absolute expiry and clears the object out; it is the
     * only thing that runs without a request to trigger it.
     */
    async alarm(): Promise<void> {
        this.#ensureSchema();
        await this.#erase();
    }

    async fetch(request: Request): Promise<Response> {
        this.#ensureSchema();
        const { pathname } = new URL(request.url);
        if (pathname === '/create') {
            const account = this.#state.create(await request.json() as any);
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
            // Security: the object's own storage goes too, so a replayed cookie cannot
            // find a shell of the session it used to name.
            await this.#erase();
            return new Response(null, { status: 204 });
        }
        return json({ error: 'not found' }, 404);
    }
}

export { ReconstructionSession, SCHEMA, sqliteStorage };
