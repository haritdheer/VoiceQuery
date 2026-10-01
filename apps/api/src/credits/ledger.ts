import { randomUUID } from 'node:crypto';
import type { LedgerEntry, LedgerReason } from '@voicequery/shared';
import type { Db } from '../db/client.ts';
import { config } from '../config/env.ts';

/**
 * Credit accounting.
 *
 * Invariants, all enforced in the database rather than in application memory:
 *
 *  - `credit_accounts.balance` has a CHECK (balance >= 0), so an over-spend is
 *    impossible even if a caller forgets to check first.
 *  - Every mutation takes `SELECT ... FOR UPDATE` on the account row inside a
 *    transaction, so two concurrent analyses cannot both see the last credit.
 *  - Every mutation writes a ledger row, so the balance is always auditable
 *    and reconcilable.
 *  - Reservations carry an idempotency key with a UNIQUE index, so a retried
 *    request reuses the original reservation instead of charging twice.
 *
 * The client's credit counter is display-only and is never trusted; the user
 * id always comes from the session, never from the request body.
 */

export class InsufficientCreditsError extends Error {
  constructor(readonly balance: number) {
    super('Not enough credits to run this analysis.');
    this.name = 'InsufficientCreditsError';
  }
}

interface AccountRow {
  user_id: string;
  balance: number;
  free_grant_issued: boolean;
}

async function lockAccount(tx: Db, userId: string): Promise<AccountRow> {
  const rows = await tx.query<AccountRow>(
    `SELECT user_id, balance, free_grant_issued
       FROM credit_accounts WHERE user_id = $1 FOR UPDATE`,
    [userId],
  );
  const row = rows[0];
  if (!row) throw new Error(`No credit account for user ${userId}.`);
  return { ...row, balance: Number(row.balance) };
}

async function writeLedger(
  tx: Db,
  params: {
    userId: string;
    delta: number;
    reason: LedgerReason;
    balanceAfter: number;
    note?: string | null;
    idempotencyKey?: string | null;
    state?: 'final' | 'reserved' | 'committed' | 'refunded';
    refundOf?: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `INSERT INTO credit_ledger
       (id, user_id, delta, reason, balance_after, note, state, refund_of, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id,
      params.userId,
      params.delta,
      params.reason,
      params.balanceAfter,
      params.note ?? null,
      params.state ?? 'final',
      params.refundOf ?? null,
      params.idempotencyKey ?? null,
    ],
  );
  return id;
}

/**
 * Creates the account and issues the one-time free grant.
 *
 * `free_grant_issued` makes this exactly-once: deleting the ledger rows or
 * calling this twice cannot produce a second grant.
 */
export async function createAccountWithFreeGrant(tx: Db, userId: string): Promise<number> {
  const free = config().FREE_CREDITS;

  await tx.query(
    `INSERT INTO credit_accounts (user_id, balance, free_grant_issued)
     VALUES ($1, 0, FALSE) ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );

  const account = await lockAccount(tx, userId);
  if (account.free_grant_issued) return account.balance;

  const balanceAfter = account.balance + free;
  await tx.query(
    `UPDATE credit_accounts
        SET balance = $2, free_grant_issued = TRUE, updated_at = now()
      WHERE user_id = $1`,
    [userId, balanceAfter],
  );
  await writeLedger(tx, {
    userId,
    delta: free,
    reason: 'free_grant',
    balanceAfter,
    note: `Welcome grant of ${free} free questions`,
  });
  return balanceAfter;
}

export async function getBalance(db: Db, userId: string): Promise<number> {
  const rows = await db.query<{ balance: number }>(
    `SELECT balance FROM credit_accounts WHERE user_id = $1`,
    [userId],
  );
  return Number(rows[0]?.balance ?? 0);
}

export interface Reservation {
  ledgerId: string;
  balanceAfter: number;
  /** True when an earlier identical request already reserved this credit. */
  replayed: boolean;
}

/**
 * Atomically takes one credit for an analysis that is about to run.
 *
 * Throws InsufficientCreditsError when the balance is zero. Because the whole
 * read-check-write happens under a row lock, N parallel requests against a
 * balance of 1 produce exactly one success.
 */
export async function reserveCredit(
  db: Db,
  userId: string,
  idempotencyKey: string,
): Promise<Reservation> {
  return db.transaction(async (tx) => {
    const existing = await tx.query<{ id: string; balance_after: number }>(
      `SELECT id, balance_after FROM credit_ledger
        WHERE user_id = $1 AND idempotency_key = $2 AND reason = 'analysis_reserve'`,
      [userId, idempotencyKey],
    );
    const prior = existing[0];
    if (prior) {
      return { ledgerId: prior.id, balanceAfter: Number(prior.balance_after), replayed: true };
    }

    const account = await lockAccount(tx, userId);
    if (account.balance < 1) throw new InsufficientCreditsError(account.balance);

    const balanceAfter = account.balance - 1;
    await tx.query(
      `UPDATE credit_accounts SET balance = $2, updated_at = now() WHERE user_id = $1`,
      [userId, balanceAfter],
    );
    const ledgerId = await writeLedger(tx, {
      userId,
      delta: -1,
      reason: 'analysis_reserve',
      balanceAfter,
      note: 'Analysis started',
      idempotencyKey,
      state: 'reserved',
    });

    return { ledgerId, balanceAfter, replayed: false };
  });
}

/**
 * Marks a reservation as permanently spent after a successful analysis.
 * Balance is already decremented; this only closes out the audit record.
 */
export async function commitCredit(db: Db, userId: string, ledgerId: string): Promise<void> {
  await db.query(
    `UPDATE credit_ledger SET state = 'committed'
      WHERE id = $1 AND user_id = $2 AND state = 'reserved'`,
    [ledgerId, userId],
  );
}

/**
 * Returns a reserved credit after a failed analysis.
 *
 * Double refunds are prevented twice over: the state transition only fires
 * while the reservation is still 'reserved', and `credit_ledger_refund_once_idx`
 * makes a second refund row for the same reservation a constraint violation.
 * The original reservation row keeps its own reason and delta, so the ledger
 * still reads as a true history rather than being rewritten.
 */
export async function refundCredit(
  db: Db,
  userId: string,
  ledgerId: string,
  note: string,
): Promise<number> {
  return db.transaction(async (tx) => {
    const account = await lockAccount(tx, userId);

    const marked = await tx.query<{ id: string }>(
      `UPDATE credit_ledger SET state = 'refunded'
        WHERE id = $1 AND user_id = $2 AND state = 'reserved'
        RETURNING id`,
      [ledgerId, userId],
    );
    // Already refunded, already committed, or never reserved — leave as is.
    if (marked.length === 0) return account.balance;

    const balanceAfter = account.balance + 1;
    await tx.query(
      `UPDATE credit_accounts SET balance = $2, updated_at = now() WHERE user_id = $1`,
      [userId, balanceAfter],
    );
    await writeLedger(tx, {
      userId,
      delta: 1,
      reason: 'analysis_refund',
      balanceAfter,
      note: note.slice(0, 200),
      refundOf: ledgerId,
    });
    return balanceAfter;
  });
}

export async function listLedger(db: Db, userId: string, limit = 50): Promise<LedgerEntry[]> {
  const rows = await db.query<{
    id: string;
    delta: number;
    reason: LedgerReason;
    balance_after: number;
    note: string | null;
    created_at: string | Date;
  }>(
    `SELECT id, delta, reason, balance_after, note, created_at
       FROM credit_ledger WHERE user_id = $1
      ORDER BY created_at DESC, id DESC LIMIT $2`,
    [userId, limit],
  );

  return rows.map((r) => ({
    id: r.id,
    delta: Number(r.delta),
    reason: r.reason,
    balanceAfter: Number(r.balance_after),
    note: r.note,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}

/**
 * Audit helper: the ledger must always sum to the stored balance.
 * Exposed so tests can assert the two never drift apart.
 */
export async function reconcile(
  db: Db,
  userId: string,
): Promise<{ balance: number; ledgerSum: number; consistent: boolean }> {
  const [acct] = await db.query<{ balance: number }>(
    `SELECT balance FROM credit_accounts WHERE user_id = $1`,
    [userId],
  );
  const [sum] = await db.query<{ total: string | number }>(
    `SELECT COALESCE(SUM(delta), 0) AS total FROM credit_ledger WHERE user_id = $1`,
    [userId],
  );
  const balance = Number(acct?.balance ?? 0);
  const ledgerSum = Number(sum?.total ?? 0);
  return { balance, ledgerSum, consistent: balance === ledgerSum };
}
