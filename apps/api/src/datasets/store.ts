import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ColumnSchema, DatasetDetail, DatasetSummary } from '@voicequery/shared';
import type { Db } from '../db/client.ts';
import { config } from '../config/env.ts';
import { createDatasetFile, evictInstance, DATASET_TABLE } from '../analytics/duckdb.ts';
import { parseCsv, CsvValidationError } from './csv.ts';
import {
  SAMPLE_COLUMNS,
  SAMPLE_DATASET_ID,
  SAMPLE_DATASET_NAME,
  generateSampleRows,
} from './sample.ts';
import { logger } from '../lib/logger.ts';

/**
 * Dataset lifecycle.
 *
 * Storage paths are derived from a server-generated UUID only. No part of a
 * path comes from the uploaded filename or any client-supplied id, so a
 * crafted name cannot escape the data directory.
 *
 * Every read goes through `loadDataset(db, id, userId)`, which filters on
 * ownership in SQL. The shared sample dataset has a NULL owner and is the only
 * row any user may read without matching on user_id.
 */

const PREVIEW_ROWS = 8;

interface DatasetRow {
  id: string;
  user_id: string | null;
  name: string;
  kind: 'sample' | 'upload';
  storage_path: string;
  row_count: number;
  column_count: number;
  size_bytes: string | number;
  columns_json: string;
  preview_json: string;
  warnings_json: string;
  expires_at: string | Date | null;
  created_at: string | Date;
}

const iso = (v: string | Date | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();

function toSummary(row: DatasetRow): DatasetSummary {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    rowCount: Number(row.row_count),
    columnCount: Number(row.column_count),
    sizeBytes: Number(row.size_bytes),
    createdAt: iso(row.created_at)!,
    expiresAt: iso(row.expires_at),
  };
}

function toDetail(row: DatasetRow): DatasetDetail {
  return {
    ...toSummary(row),
    columns: JSON.parse(row.columns_json) as ColumnSchema[],
    preview: JSON.parse(row.preview_json) as Record<string, unknown>[],
    warnings: JSON.parse(row.warnings_json) as string[],
  };
}

export interface LoadedDataset extends DatasetDetail {
  storagePath: string;
  ownerId: string | null;
}

function dataDir(): string {
  return path.resolve(config().DATA_DIR, 'datasets');
}

/* -------------------------------- reading --------------------------------- */

export async function listDatasets(db: Db, userId: string): Promise<DatasetSummary[]> {
  const rows = await db.query<DatasetRow>(
    `SELECT * FROM datasets
      WHERE user_id = $1 OR kind = 'sample'
      ORDER BY kind DESC, created_at DESC`,
    [userId],
  );
  return rows.map(toSummary);
}

/**
 * Loads a dataset the user is allowed to see. Returns null for a dataset that
 * does not exist *and* for one owned by someone else — the caller cannot tell
 * the two apart, so this does not leak the existence of other users' data.
 */
export async function loadDataset(
  db: Db,
  datasetId: string,
  userId: string,
): Promise<LoadedDataset | null> {
  const rows = await db.query<DatasetRow>(
    `SELECT * FROM datasets
      WHERE id = $1 AND (user_id = $2 OR kind = 'sample')
      LIMIT 1`,
    [datasetId, userId],
  );
  const row = rows[0];
  if (!row) return null;

  if (row.expires_at && new Date(iso(row.expires_at)!).getTime() < Date.now()) {
    return null;
  }

  return { ...toDetail(row), storagePath: row.storage_path, ownerId: row.user_id };
}

/* -------------------------------- writing --------------------------------- */

export interface CreateFromCsvInput {
  db: Db;
  userId: string;
  name: string;
  content: string;
}

export async function createDatasetFromCsv(input: CreateFromCsvInput): Promise<DatasetDetail> {
  const cfg = config();
  const byteLength = Buffer.byteLength(input.content, 'utf8');

  if (byteLength > cfg.MAX_UPLOAD_BYTES) {
    throw new CsvValidationError(
      `The file is ${(byteLength / 1024 / 1024).toFixed(1)} MB, above the ${(
        cfg.MAX_UPLOAD_BYTES /
        1024 /
        1024
      ).toFixed(0)} MB limit.`,
    );
  }

  const parsed = parseCsv(input.content, {
    maxRows: cfg.MAX_ROWS,
    maxColumns: cfg.MAX_COLUMNS,
  });

  const id = randomUUID();
  await mkdir(dataDir(), { recursive: true });
  // Path is built from the generated UUID alone.
  const storagePath = path.join(dataDir(), `${id}.duckdb`);

  await createDatasetFile(
    storagePath,
    parsed.columns.map((c, i) => ({ name: c.name, sqlType: parsed.sqlTypes[i]! })),
    parsed.rows,
  );

  const preview = buildPreview(parsed.columns, parsed.rows, PREVIEW_ROWS);
  const expiresAt = new Date(Date.now() + cfg.DATASET_TTL_HOURS * 3_600_000);

  await input.db.query(
    `INSERT INTO datasets
       (id, user_id, name, kind, storage_path, row_count, column_count, size_bytes,
        columns_json, preview_json, warnings_json, expires_at)
     VALUES ($1,$2,$3,'upload',$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      id,
      input.userId,
      input.name.slice(0, 120),
      storagePath,
      parsed.rowCount,
      parsed.columns.length,
      byteLength,
      JSON.stringify(parsed.columns),
      JSON.stringify(preview),
      JSON.stringify(parsed.warnings),
      expiresAt.toISOString(),
    ],
  );

  // Row counts and column names only — never cell contents.
  logger.info(
    { datasetId: id, rows: parsed.rowCount, columns: parsed.columns.length },
    'dataset created',
  );

  const loaded = await loadDataset(input.db, id, input.userId);
  if (!loaded) throw new Error('Dataset disappeared immediately after creation.');

  // Strip server-internal fields explicitly. Narrowing the declared return
  // type is not enough — the object would still carry the absolute storage
  // path into the JSON response.
  const { storagePath: _storagePath, ownerId: _ownerId, ...safe } = loaded;
  return safe;
}

function buildPreview(
  columns: ColumnSchema[],
  rows: (string | null)[][],
  limit: number,
): Record<string, unknown>[] {
  return rows.slice(0, limit).map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((c, i) => {
      obj[c.name] = row[i];
    });
    return obj;
  });
}

export async function deleteDataset(db: Db, datasetId: string, userId: string): Promise<boolean> {
  // Ownership is part of the DELETE predicate, so another user's id simply
  // matches no rows. The sample dataset is excluded by the user_id match.
  const rows = await db.query<{ storage_path: string }>(
    `DELETE FROM datasets WHERE id = $1 AND user_id = $2 AND kind = 'upload'
     RETURNING storage_path`,
    [datasetId, userId],
  );
  const row = rows[0];
  if (!row) return false;

  evictInstance(row.storage_path);
  await rm(row.storage_path, { force: true }).catch(() => {});
  logger.info({ datasetId }, 'dataset deleted');
  return true;
}

/* ------------------------------- expiry sweep ------------------------------ */

/** Removes expired upload files and their metadata. Safe to call repeatedly. */
export async function sweepExpiredDatasets(db: Db): Promise<number> {
  const rows = await db.query<{ id: string; storage_path: string }>(
    `DELETE FROM datasets
      WHERE kind = 'upload' AND expires_at IS NOT NULL AND expires_at < now()
     RETURNING id, storage_path`,
  );
  for (const row of rows) {
    evictInstance(row.storage_path);
    await rm(row.storage_path, { force: true }).catch(() => {});
  }
  if (rows.length > 0) logger.info({ count: rows.length }, 'expired datasets swept');
  return rows.length;
}

/* ----------------------------- sample dataset ------------------------------ */

/**
 * Creates the shared sample dataset if it is not already present. It has a
 * NULL owner and no expiry, and is readable by every account.
 */
export async function ensureSampleDataset(db: Db): Promise<void> {
  const existing = await db.query<{ storage_path: string }>(
    `SELECT storage_path FROM datasets WHERE id = $1`,
    [SAMPLE_DATASET_ID],
  );

  const storagePath = path.join(dataDir(), 'sample-sales.duckdb');
  let fileExists = false;
  try {
    await stat(storagePath);
    fileExists = true;
  } catch {
    fileExists = false;
  }

  if (existing.length > 0 && fileExists) return;

  await mkdir(dataDir(), { recursive: true });
  evictInstance(storagePath);
  await rm(storagePath, { force: true }).catch(() => {});

  const sampleRows = generateSampleRows();
  const columnOrder = SAMPLE_COLUMNS.map((c) => c.name) as (keyof (typeof sampleRows)[number])[];

  await createDatasetFile(
    storagePath,
    SAMPLE_COLUMNS.map((c) => ({ name: c.name, sqlType: c.sqlType })),
    sampleRows.map((r) => columnOrder.map((k) => (r[k] === null ? null : String(r[k])))),
  );

  const columns: ColumnSchema[] = SAMPLE_COLUMNS.map((c) => {
    const values = sampleRows.map((r) => String(r[c.name as keyof (typeof sampleRows)[number]]));
    return {
      name: c.name,
      originalName: c.name,
      type: c.type as ColumnSchema['type'],
      nullable: false,
      sampleValues: [...new Set(values)].slice(0, 12),
      nullCount: 0,
    };
  });

  const preview = sampleRows.slice(0, PREVIEW_ROWS).map((r) => ({ ...r }));
  const sizeBytes = (await stat(storagePath)).size;

  await db.query(
    `INSERT INTO datasets
       (id, user_id, name, kind, storage_path, row_count, column_count, size_bytes,
        columns_json, preview_json, warnings_json, expires_at)
     VALUES ($1, NULL, $2, 'sample', $3, $4, $5, $6, $7, $8, '[]', NULL)
     ON CONFLICT (id) DO UPDATE SET
       storage_path = EXCLUDED.storage_path,
       row_count    = EXCLUDED.row_count,
       size_bytes   = EXCLUDED.size_bytes,
       columns_json = EXCLUDED.columns_json,
       preview_json = EXCLUDED.preview_json`,
    [
      SAMPLE_DATASET_ID,
      SAMPLE_DATASET_NAME,
      storagePath,
      sampleRows.length,
      SAMPLE_COLUMNS.length,
      sizeBytes,
      JSON.stringify(columns),
      JSON.stringify(preview),
    ],
  );

  logger.info({ rows: sampleRows.length }, 'sample dataset ready');
}

export { DATASET_TABLE };
