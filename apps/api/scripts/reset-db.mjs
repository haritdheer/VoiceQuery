/**
 * Deletes the local PGlite cluster.
 *
 * Exists because an unclean exit can leave the embedded cluster unopenable,
 * and on Windows that happens more often than it should: `tsx watch` kills
 * the process in a way Node cannot catch there, so the graceful shutdown in
 * server.ts never runs and every file save during development is effectively
 * a hard kill.
 *
 * Safe by construction — it refuses to touch anything but the pglite
 * directory under DATA_DIR, leaves uploaded dataset files alone, and does
 * nothing at all when a real DATABASE_URL is configured.
 */
import { rm, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

for (const candidate of ['../../../.env', '../../.env']) {
  try {
    process.loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), candidate));
  } catch {
    /* not there */
  }
}

if (process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRESQL_URL) {
  console.error(
    'DATABASE_URL is set, so this project is using a real Postgres server.\n' +
      'This script only ever deletes the local embedded database, and will not\n' +
      'touch a real one. Nothing was changed.',
  );
  process.exit(1);
}

const dataDir = process.env.DATA_DIR ?? '.data';
const target = path.resolve(dataDir, 'pglite');

try {
  await access(target);
} catch {
  console.log(`Nothing to remove — ${target} does not exist.`);
  process.exit(0);
}

await rm(target, { recursive: true, force: true });
console.log(
  [
    `Removed ${target}`,
    '',
    'Local accounts and chat history are gone. Uploaded dataset files were',
    'left in place, and the sample dataset is recreated on the next start.',
  ].join('\n'),
);
