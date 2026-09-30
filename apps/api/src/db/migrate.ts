import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import type { Db } from './client.ts';
import { getDb, closeDb } from './client.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Applies schema.sql. Every statement in it is written to be idempotent, so
 * this doubles as "create" and "bring up to date" for the first version.
 */
export async function migrate(db: Db): Promise<void> {
  const sql = await readFile(path.join(here, 'schema.sql'), 'utf8');
  // PGlite's wire protocol rejects multi-statement strings, so the file is
  // split into single statements. Line comments are stripped first, otherwise
  // a statement introduced by a comment block would be mistaken for one.
  // Safe here because schema.sql contains no string literals or dollar-quoted
  // bodies that could hold a `--` or `;`.
  const statements = sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const statement of statements) {
    await db.query(statement);
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const db = await getDb();
  await migrate(db);
  // eslint-disable-next-line no-console
  console.log(`Migrations applied (driver: ${db.driver}).`);
  await closeDb();
}
