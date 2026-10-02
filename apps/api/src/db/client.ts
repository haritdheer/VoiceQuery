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
    const path = await import('node:path');
    await mkdir(path.dirname(path.resolve(dataDir)), { recursive: true });
  }

  /*
   * A corrupt or still-locked data directory surfaces as a bare WASM
   * `RuntimeError: Aborted()` with a stack full of `wasm-function[13300]`
   * and no mention of Postgres, the directory, or what to do — which reads
   * like the app is broken rather than like local state needs clearing.
   *
   * The usual cause is a dev server killed hard: PGlite is a single embedded
   * instance, so it leaves a postmaster.pid behind and can leave the cluster
   * mid-write. Deleting the directory is safe here and nowhere else —
   * production is real Postgres, and the sample dataset re-seeds on boot.
   */
  const pg = await PGlite.create(dataDir).catch((err: unknown) => {
    if (dataDir.startsWith('memory://')) throw err;
    throw new Error(
      [
        `The local database at ${dataDir} could not be opened.`,
        '',
        'This is usually a dev server that was killed rather than stopped,',
        'leaving the embedded Postgres cluster locked or half-written.',
        '',
        'It holds only local accounts and chat history. To reset it:',
        '',
        `  rm -rf ${dataDir}`,
        '',
        'The sample dataset is recreated on the next start.',
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
