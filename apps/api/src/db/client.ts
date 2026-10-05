import nodeFs from 'node:fs';
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

/**
 * Stops two dev servers from sharing one data directory.
 *
 * PGlite does not guard this itself — verified: two processes opened the same
 * directory at the same time and both started cleanly, no error, no lock.
 * They are then two Postgres clusters writing the same files, which corrupts
 * the cluster and leaves the *next* start failing with an unreadable WASM
 * abort, long after the mistake.
 *
 * PGlite's own postmaster.pid is no help: it contains a constant `-42` rather
 * than a real process id, so it cannot tell a live instance from an abandoned
 * one. This writes a real pid alongside it instead.
 *
 * A lock naming a process that is gone is stale — an unclean exit, which on
 * Windows is most exits — and is reclaimed silently. Only a live process
 * blocks startup.
 */
const LOCK_FILE = 'vq-dev.lock';

async function acquireDataDirLock(dataDir: string): Promise<() => void> {
  const { readFile, writeFile, mkdir } = await import('node:fs/promises');
  const lockPath = nodePath.join(nodePath.resolve(dataDir), LOCK_FILE);

  await mkdir(nodePath.resolve(dataDir), { recursive: true });

  try {
    const held = Number((await readFile(lockPath, 'utf8')).trim());
    if (Number.isInteger(held) && held > 0 && held !== process.pid) {
      let alive = false;
      try {
        // Signal 0 checks for existence without touching the process.
        process.kill(held, 0);
        alive = true;
      } catch {
        alive = false; // gone, or not ours to signal
      }
      if (alive) {
        throw new Error(
          [
            `Another dev server (pid ${held}) is already using ${nodePath.resolve(dataDir)}.`,
            '',
            'Two servers sharing one data directory corrupt the database —',
            'PGlite does not prevent it, so this check does.',
            '',
            'Use the server you already have, or stop it before starting a',
            'second one. To run two deliberately, give this one its own',
            'directory and port:',
            '',
            '    DATA_DIR=.data-2 PORT=8788 npm run dev:api',
          ].join('\n'),
        );
      }
    }
  } catch (err) {
    // Rethrow our own refusal; a missing or unreadable lock is fine.
    if (err instanceof Error && err.message.startsWith('Another dev server')) throw err;
  }

  await writeFile(lockPath, String(process.pid), 'utf8');
  return () => {
    try {
      // Synchronous on purpose: this also runs from exit handlers, where a
      // promise would never get the chance to settle.
      nodeFs.unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  };
}

async function createPgliteDb(dataDir: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');

  // PGlite creates its own directory but not the parents, so make sure the
  // enclosing data directory exists first.
  if (!dataDir.startsWith('memory://')) {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(nodePath.dirname(nodePath.resolve(dataDir)), { recursive: true });
  }

  // Refuse before opening, not after: by the time PGlite has failed, two
  // instances have already been writing to the same files.
  const releaseLock = dataDir.startsWith('memory://')
    ? () => {}
    : await acquireDataDirLock(dataDir);

  /*
   * With the lock above holding off the concurrent-access case, a failure
   * here means the cluster itself is damaged. PGlite reports that as a bare
   * WASM `RuntimeError: Aborted()` over ten frames of `wasm-function[13300]`,
   * naming neither Postgres nor the directory nor any way forward.
   */
  const pg = await PGlite.create(dataDir).catch((err: unknown) => {
    releaseLock();
    if (dataDir.startsWith('memory://')) throw err;
    throw new Error(
      [
        `The local database at ${nodePath.resolve(dataDir)} is damaged.`,
        '',
        'Clear it and start again:',
        '',
        '    npm run db:reset',
        '',
        'It holds local accounts and chat history and nothing else, so this is',
        'safe — production is real Postgres and the sample dataset is recreated',
        'on the next start.',
        '',
        'The usual cause is an unclean exit. On Windows that is most exits:',
        'tsx watch kills the process in a way Node cannot catch, so the',
        'graceful shutdown never runs and every file save during development',
        'is effectively a hard kill. `npm run dev:api:noreload` avoids it, at',
        'the cost of restarting the API yourself after backend edits.',
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
      if (inTx) return;
      await pg.close();
      releaseLock();
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
