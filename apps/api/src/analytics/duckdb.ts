import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import type { QueryResult } from '@voicequery/shared';
import { config } from '../config/env.ts';
import { wrapWithCount, wrapWithRowLimit } from './sqlGuard.ts';

/**
 * The isolated analytics engine.
 *
 * Every dataset is its own DuckDB file. A query only ever runs against the
 * single file belonging to the selected dataset, so cross-user access is
 * prevented by physical separation rather than by a WHERE clause the model
 * could omit.
 *
 * This module is the *second* safety layer. sqlGuard.ts validates the query
 * structurally; the settings below make the engine itself refuse file access,
 * network egress, extension loading and writes — and then lock the
 * configuration so nothing executed later can turn those back on. Verified
 * behaviour: with these settings DuckDB rejects `read_csv_auto(...)`,
 * `INSTALL`, `ATTACH`, `COPY ... TO`, `glob()` and
 * `SET enable_external_access=true`.
 */

/** The single table name exposed to generated SQL. */
export const DATASET_TABLE = 't';

const READONLY_CONFIG = (): Record<string, string> => ({
  access_mode: 'READ_ONLY',
  // Blocks all filesystem and network reachability from inside SQL.
  enable_external_access: 'false',
  // Caps how much memory one analytical query may consume.
  memory_limit: config().DUCKDB_MEMORY_LIMIT,
  threads: String(config().DUCKDB_THREADS),
  autoinstall_known_extensions: 'false',
  autoload_known_extensions: 'false',
  // Must come last in intent: after this, no SET can relax anything above.
  lock_configuration: 'true',
});

export class QueryTimeoutError extends Error {
  constructor(ms: number) {
    super(`Query exceeded the ${ms}ms time limit.`);
    this.name = 'QueryTimeoutError';
  }
}

export class QueryExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryExecutionError';
  }
}

/* ----------------------------- instance cache ----------------------------- */

interface CachedInstance {
  instance: DuckDBInstance;
  lastUsed: number;
}

const instances = new Map<string, CachedInstance>();
const MAX_CACHED = 8;

async function getReadOnlyInstance(storagePath: string): Promise<DuckDBInstance> {
  const cached = instances.get(storagePath);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.instance;
  }

  if (instances.size >= MAX_CACHED) {
    const oldest = [...instances.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    if (oldest) {
      oldest[1].instance.closeSync();
      instances.delete(oldest[0]);
    }
  }

  const instance = await DuckDBInstance.create(storagePath, READONLY_CONFIG());
  instances.set(storagePath, { instance, lastUsed: Date.now() });
  return instance;
}

/** Drops any cached handle so the underlying file can be deleted. */
export function evictInstance(storagePath: string): void {
  const cached = instances.get(storagePath);
  if (cached) {
    cached.instance.closeSync();
    instances.delete(storagePath);
  }
}

export function closeAllInstances(): void {
  for (const [, cached] of instances) cached.instance.closeSync();
  instances.clear();
}

/* -------------------------------- execution ------------------------------- */

/**
 * Runs `fn` against a fresh read-only connection, interrupting it if it
 * outlives the timeout. DuckDB's `interrupt()` cancels the in-flight query;
 * the promise then rejects and we surface a timeout rather than hanging the
 * request.
 */
async function withConnection<T>(
  storagePath: string,
  timeoutMs: number,
  fn: (conn: DuckDBConnection) => Promise<T>,
): Promise<T> {
  const instance = await getReadOnlyInstance(storagePath);
  const conn = await instance.connect();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      conn.interrupt();
    } catch {
      /* connection already finished */
    }
  }, timeoutMs);

  try {
    return await fn(conn);
  } catch (err) {
    if (timedOut) throw new QueryTimeoutError(timeoutMs);
    throw new QueryExecutionError(cleanDuckDbError(err));
  } finally {
    clearTimeout(timer);
    try {
      conn.closeSync();
    } catch {
      /* already closed */
    }
  }
}

/** Keeps engine internals out of user-facing messages. */
function cleanDuckDbError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.split('\n')[0]?.replace(/^\w+ Error: /, '') ?? 'Query failed.';
}

export interface RunOptions {
  storagePath: string;
  /** Must already have passed validateSql(). */
  sql: string;
  maxRows: number;
  timeoutMs?: number;
}

/**
 * Executes a validated analytical query.
 *
 * Row capping happens *outside* the query, so aggregates are computed across
 * the whole dataset and only the delivered rows are limited. `totalRows` is
 * the true size of the result set, so the UI can say "showing 500 of 12,480"
 * honestly.
 */
export async function runAnalyticalQuery(opts: RunOptions): Promise<QueryResult> {
  const timeoutMs = opts.timeoutMs ?? config().QUERY_TIMEOUT_MS;

  return withConnection(opts.storagePath, timeoutMs, async (conn) => {
    // DuckDB's own parser is a third, independent check that the string is a
    // single statement — it does not share a code path with node-sql-parser.
    const extracted = await conn.extractStatements(opts.sql);
    if (extracted.count !== 1) {
      throw new QueryExecutionError('Only a single statement may be executed.');
    }

    const limited = await conn.runAndReadAll(wrapWithRowLimit(opts.sql, opts.maxRows));
    const allRows = limited.getRowObjectsJson() as Record<string, unknown>[];
    const columns = limited.columnNames();

    const truncated = allRows.length > opts.maxRows;
    const rows = truncated ? allRows.slice(0, opts.maxRows) : allRows;

    let totalRows = rows.length;
    if (truncated) {
      const counted = await conn.runAndReadAll(wrapWithCount(opts.sql));
      const first = counted.getRowObjectsJson()[0] as { _vq_total?: unknown } | undefined;
      totalRows = Number(first?._vq_total ?? rows.length);
    }

    return { columns, rows, totalRows, truncated };
  });
}

/* ------------------------------- ingestion -------------------------------- */

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * Creates a dataset file from parsed CSV rows.
 *
 * Values are staged as VARCHAR and then converted with TRY_CAST into the
 * inferred types. That ordering is deliberate: TRY_CAST yields NULL for a
 * value that does not fit its column instead of aborting the whole upload, so
 * one malformed cell in row 40,000 degrades to a null rather than losing the
 * user's file. Cell values are appended as bound values and never concatenated
 * into SQL text.
 */
export async function createDatasetFile(
  storagePath: string,
  columns: { name: string; sqlType: string }[],
  rows: (string | null)[][],
): Promise<void> {
  // Writable instance, still with external access disabled. The path is
  // backend-generated, never influenced by the uploaded file's contents.
  const instance = await DuckDBInstance.create(storagePath, {
    access_mode: 'READ_WRITE',
    enable_external_access: 'false',
    memory_limit: config().DUCKDB_MEMORY_LIMIT,
    threads: String(config().DUCKDB_THREADS),
    autoinstall_known_extensions: 'false',
    autoload_known_extensions: 'false',
  });
  const conn = await instance.connect();
  try {
    // 1. Stage every column as text so no cell can abort ingestion.
    const stagingCols = columns.map((_, i) => `c${i} VARCHAR`).join(', ');
    await conn.run(`CREATE TABLE _vq_staging (${stagingCols})`);

    if (rows.length > 0) {
      const appender = await conn.createAppender('_vq_staging');
      for (const row of rows) {
        for (let i = 0; i < columns.length; i++) {
          const value = row[i];
          if (value === null || value === undefined) appender.appendNull();
          else appender.appendVarchar(value);
        }
        appender.endRow();
      }
      appender.closeSync();
    }

    // 2. Project into the typed analysis table. TRY_CAST turns an
    //    unconvertible value into NULL rather than failing the upload.
    const projection = columns
      .map((c, i) =>
        c.sqlType === 'VARCHAR'
          ? `c${i} AS ${quoteIdent(c.name)}`
          : `TRY_CAST(c${i} AS ${c.sqlType}) AS ${quoteIdent(c.name)}`,
      )
      .join(', ');
    await conn.run(`CREATE TABLE ${DATASET_TABLE} AS SELECT ${projection} FROM _vq_staging`);
    await conn.run('DROP TABLE _vq_staging');
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}
