import nodePath from 'node:path';
import { config } from '../config/env.ts';

/**
 * One narrow database interface over two Postgres drivers:
 *
 *  - `postgres` (postgres.js) against a real server — the production path.
 *  - `@electric-sql/pglite`, which is genuine Postgres compiled to WASM, used
 *    for local dev and tests so the repo runs with no external services.
 *
 * Both speak the same dialect, so there is exactly one set of SQL in this
 * codebase. Queries are positional-parameter only; no string interpolation of
 * user input anywhere.
 */

export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
  /**
   * Runs `fn` inside a transaction, rolling back if it throws.
   * Nested calls reuse the outer transaction.
   */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly driver: 'postgres' | 'pglite';
}

/* ------------------------------- postgres.js ------------------------------ */

async function createPostgresDb(url: string): Promise<Db> {
  const { default: postgres } = await import('postgres');
  const sql = postgres(url, { max: 10, onnotice: () => {} });

  const wrap = (handle: ReturnType<typeof postgres>, inTx: boolean): Db => ({
    driver: 'postgres',
    async query<T>(text: string, params: readonly unknown[] = []) {
      return (await handle.unsafe(text, params as never[])) as unknown as T[];
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      if (inTx) return fn(wrap(handle, true));
      return handle.begin(async (tx) => fn(wrap(tx as never, true))) as Promise<T>;
    },
    async close() {
      if (!inTx) await handle.end({ timeout: 5 });
    },
  });

  return wrap(sql, false);
}

/* --------------------------------- PGlite --------------------------------- */

async function createPgliteDb(dataDir: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');

  // PGlite creates its own directory but not the parents, so make sure the
  // enclosing data directory exists first.
  if (!dataDir.startsWith('memory://')) {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(nodePath.dirname(nodePath.resolve(dataDir)), { recursive: true });
  }

  /*
   * A directory that cannot be opened surfaces as a bare WASM
   * `RuntimeError: Aborted()` over ten frames of `wasm-function[13300]`,
   * naming neither Postgres nor the directory nor any way forward.
   *
   * Two quite different things produce it, and they want opposite responses:
   * a second dev server competing for the directory (nothing is wrong — stop
   * one of them), or a genuinely damaged cluster (delete it). PGlite writes a
   * constant `-42` into postmaster.pid rather than a real process id, so the
   * lock file cannot distinguish them and neither can we.
   *
   * So the message asks rather than guesses, and puts the harmless check
   * first. Getting that order wrong is not cosmetic: deleting the directory
   * while another instance holds it open is itself a way to corrupt it.
   */
  const pg = await PGlite.create(dataDir).catch((err: unknown) => {
    if (dataDir.startsWith('memory://')) throw err;
    const { PORT } = config();
    const resolved = nodePath.resolve(dataDir);
    throw new Error(
      [
        `The local database at ${resolved} could not be opened.`,
        '',
        'Two things cause this. Check them in this order.',
        '',
        '1. Another dev server already has it open. PGlite is a single',
        '   embedded instance, so only one process can hold the directory.',
        '   This is the common case and nothing is wrong — you already have',
        `   a server running. This one wanted port ${PORT}; look there first,`,
        '   and anywhere else you may have started it:',
        '',
        `     Windows        netstat -ano | findstr :${PORT}`,
        `     macOS / Linux  lsof -i :${PORT}`,
        '',
        '   If something is listening, that is it. Use it, or stop it before',
        '   starting another.',
        '',
        '2. Only if nothing is listening: the cluster is damaged. It holds',
        '   local accounts and chat history and nothing else, so clearing it',
        '   is safe — production is real Postgres, and the sample dataset is',
        '   recreated on the next start.',
        '',
        '     npm run db:reset',
        '',
        '   On Windows this happens more often than it should: tsx watch',
        '   kills the process in a way Node cannot catch there, so the',
        '   graceful shutdown never runs and every file save during dev is',
        '   effectively a hard kill. `npm run dev:api:noreload` avoids it at',
        '   the cost of restarting the API yourself.',
        '',
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
      ].join('\n'),
      { cause: err },
    );
  });

  type Queryable = { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }> };

  const wrap = (handle: Queryable, inTx: boolean): Db => ({
    driver: 'pglite',
    async query<T>(text: string, params: readonly unknown[] = []) {
      const res = await handle.query(text, params as unknown[]);
      return res.rows as T[];
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      if (inTx) return fn(wrap(handle, true));
      const result = await pg.transaction(async (tx) => fn(wrap(tx as Queryable, true)));
      return result as T;
    },
    async close() {
      if (!inTx) await pg.close();
    },
  });

  return wrap(pg as Queryable, false);
}

/* --------------------------------- factory -------------------------------- */

let instance: Db | null = null;

export async function createDb(overrideUrl?: string): Promise<Db> {
  const cfg = config();
  const url = overrideUrl ?? cfg.DATABASE_URL;
  if (url) return createPostgresDb(url);

  if (cfg.isProd) throw new Error('DATABASE_URL is required in production.');
  // `memory://` keeps tests hermetic; dev persists so logins survive a restart.
  return createPgliteDb(cfg.isTest ? 'memory://' : `${cfg.DATA_DIR}/pglite`);
}

export async function getDb(): Promise<Db> {
  instance ??= await createDb();
  return instance;
}

export async function closeDb(): Promise<void> {
  if (instance) {
    await instance.close();
    instance = null;
  }
}
