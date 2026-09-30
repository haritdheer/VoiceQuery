process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

import { afterEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/db/client.ts';
import { migrate } from '../src/db/migrate.ts';

/**
 * Migration tests.
 *
 * These exist because of a real bug: `CREATE TABLE IF NOT EXISTS` is a no-op
 * once the table exists, so adding a column to schema.sql silently did nothing
 * to a database created by an earlier version — and the next statement that
 * referenced the new column failed at boot. Every other test starts from an
 * empty database, which is exactly why none of them caught it.
 *
 * So: one test for a fresh database, and one that builds the *old* schema
 * first and then migrates over it.
 */

let db: Db | null = null;

afterEach(async () => {
  await db?.close();
  db = null;
});

/** The users/credit_ledger shape as it existed before guests. */
const OLD_SCHEMA = [
  `CREATE TABLE users (
     id            TEXT PRIMARY KEY,
     email         TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE credit_accounts (
     user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     balance           INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
     free_grant_issued BOOLEAN NOT NULL DEFAULT FALSE,
     updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE credit_ledger (
     id              TEXT PRIMARY KEY,
     user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     delta           INTEGER NOT NULL,
     reason          TEXT NOT NULL,
     balance_after   INTEGER NOT NULL,
     note            TEXT,
     idempotency_key TEXT,
     created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
];

async function columnExists(handle: Db, table: string, column: string): Promise<boolean> {
  const rows = await handle.query<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

describe('migrations on a fresh database', () => {
  it('creates every table', async () => {
    db = await createDb();
    await migrate(db);

    for (const table of [
      'users',
      'sessions',
      'credit_accounts',
      'credit_ledger',
      'datasets',
      'conversations',
      'messages',
      'idempotency_records',
      'purchases',
      'payment_events',
    ]) {
      const rows = await db.query<{ n: string | number }>(
        `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name = $1`,
        [table],
      );
      expect(Number(rows[0]?.n ?? 0), `${table} should exist`).toBe(1);
    }
  });

  it('is safe to run repeatedly', async () => {
    db = await createDb();
    await migrate(db);
    await migrate(db);
    await migrate(db);

    await db.query(
      `INSERT INTO users (id, email, password_hash) VALUES ('u1', 'a@b.c', 'x')`,
    );
    const rows = await db.query(`SELECT id FROM users`);
    expect(rows).toHaveLength(1);
  });
});

describe('migrations over an earlier schema', () => {
  it('adds the guest columns to an existing users table', async () => {
    db = await createDb();
    for (const statement of OLD_SCHEMA) await db.query(statement);

    // An account created by the old version, which must survive the upgrade.
    await db.query(
      `INSERT INTO users (id, email, password_hash) VALUES ('legacy', 'old@user.test', 'hash')`,
    );

    expect(await columnExists(db, 'users', 'is_guest')).toBe(false);

    await migrate(db);

    expect(await columnExists(db, 'users', 'is_guest')).toBe(true);
    expect(await columnExists(db, 'users', 'expires_at')).toBe(true);

    // The existing row is intact and defaulted to a real account.
    const legacy = await db.query<{ email: string; is_guest: boolean }>(
      `SELECT email, is_guest FROM users WHERE id = 'legacy'`,
    );
    expect(legacy[0]?.email).toBe('old@user.test');
    expect(legacy[0]?.is_guest).toBe(false);
  });

  it('allows a guest row after upgrading', async () => {
    db = await createDb();
    for (const statement of OLD_SCHEMA) await db.query(statement);
    await migrate(db);

    // The old NOT NULLs on email/password_hash would reject this.
    await db.query(
      `INSERT INTO users (id, email, password_hash, is_guest, expires_at)
       VALUES ('g1', NULL, NULL, TRUE, now() + interval '1 day')`,
    );
    const rows = await db.query<{ is_guest: boolean }>(
      `SELECT is_guest FROM users WHERE id = 'g1'`,
    );
    expect(rows[0]?.is_guest).toBe(true);
  });

  it('enforces the credentials CHECK after upgrading', async () => {
    db = await createDb();
    for (const statement of OLD_SCHEMA) await db.query(statement);
    await migrate(db);

    // A guest with credentials is incoherent and must be rejected.
    await expect(
      db.query(
        `INSERT INTO users (id, email, password_hash, is_guest)
         VALUES ('bad', 'x@y.z', 'hash', TRUE)`,
      ),
    ).rejects.toThrow();

    // So is a real account without them.
    await expect(
      db.query(
        `INSERT INTO users (id, email, password_hash, is_guest)
         VALUES ('bad2', NULL, NULL, FALSE)`,
      ),
    ).rejects.toThrow();
  });

  it('adds the ledger state columns to an existing credit_ledger', async () => {
    db = await createDb();
    for (const statement of OLD_SCHEMA) await db.query(statement);
    await db.query(
      `INSERT INTO users (id, email, password_hash) VALUES ('u1', 'a@b.c', 'x')`,
    );
    await db.query(
      `INSERT INTO credit_ledger (id, user_id, delta, reason, balance_after)
       VALUES ('l1', 'u1', 2, 'free_grant', 2)`,
    );

    expect(await columnExists(db, 'credit_ledger', 'state')).toBe(false);

    await migrate(db);

    expect(await columnExists(db, 'credit_ledger', 'state')).toBe(true);
    expect(await columnExists(db, 'credit_ledger', 'refund_of')).toBe(true);

    // The pre-existing row gets the sensible default rather than a NULL.
    const rows = await db.query<{ state: string }>(
      `SELECT state FROM credit_ledger WHERE id = 'l1'`,
    );
    expect(rows[0]?.state).toBe('final');
  });

  it('still keeps emails unique for real accounts', async () => {
    db = await createDb();
    for (const statement of OLD_SCHEMA) await db.query(statement);
    await migrate(db);

    await db.query(
      `INSERT INTO users (id, email, password_hash) VALUES ('a', 'dupe@test.io', 'h')`,
    );
    await expect(
      db.query(`INSERT INTO users (id, email, password_hash) VALUES ('b', 'dupe@test.io', 'h')`),
    ).rejects.toThrow();

    // But many guests may share a NULL email.
    await db.query(
      `INSERT INTO users (id, email, password_hash, is_guest) VALUES ('g1', NULL, NULL, TRUE)`,
    );
    await db.query(
      `INSERT INTO users (id, email, password_hash, is_guest) VALUES ('g2', NULL, NULL, TRUE)`,
    );
    const guests = await db.query(`SELECT id FROM users WHERE is_guest = TRUE`);
    expect(guests).toHaveLength(2);
  });
});
