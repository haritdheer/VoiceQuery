import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PublicUser } from '@voicequery/shared';
import type { Db } from '../db/client.ts';
import { config } from '../config/env.ts';

/**
 * Cookie-based sessions.
 *
 * The raw session id exists only in the client's cookie; the database stores
 * its SHA-256. A leaked database backup therefore yields no usable sessions.
 *
 * CSRF uses the double-submit pattern: a token is minted with the session and
 * must be echoed in the X-CSRF-Token header on every mutating request. Because
 * the cookie is SameSite=Lax and the header cannot be set cross-origin without
 * CORS approval, a third-party site cannot forge a state-changing call.
 */

export const SESSION_COOKIE = 'vq_session';

const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');

export interface AuthenticatedSession {
  user: PublicUser;
  csrfToken: string;
}

export async function createSession(
  db: Db,
  userId: string,
  reply: FastifyReply,
): Promise<AuthenticatedSession> {
  const cfg = config();
  const raw = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + cfg.SESSION_TTL_HOURS * 3_600_000);

  await db.query(
    `INSERT INTO sessions (id_hash, user_id, csrf_token, expires_at) VALUES ($1,$2,$3,$4)`,
    [hashToken(raw), userId, csrfToken, expiresAt.toISOString()],
  );

  reply.setCookie(SESSION_COOKIE, raw, {
    httpOnly: true,
    sameSite: 'lax',
    secure: cfg.COOKIE_SECURE,
    domain: cfg.COOKIE_DOMAIN,
    path: '/',
    expires: expiresAt,
  });

  const users = await db.query<{
    id: string;
    email: string | null;
    is_guest: boolean;
    created_at: string | Date;
  }>(`SELECT id, email, is_guest, created_at FROM users WHERE id = $1`, [userId]);
  const u = users[0]!;
  return {
    user: {
      id: u.id,
      email: u.email,
      isGuest: Boolean(u.is_guest),
      createdAt: u.created_at instanceof Date ? u.created_at.toISOString() : String(u.created_at),
    },
    csrfToken,
  };
}

/**
 * Creates an anonymous guest account and signs it in.
 *
 * A guest is a real `users` row with no credentials, so every ownership
 * check, conversation and message path works unchanged. It carries an expiry
 * so the sweep can remove it along with everything it created.
 */
export async function createGuestSession(
  db: Db,
  reply: FastifyReply,
): Promise<AuthenticatedSession> {
  const cfg = config();
  const userId = randomUUID();
  const expiresAt = new Date(Date.now() + cfg.GUEST_TTL_HOURS * 3_600_000);

  await db.query(
    `INSERT INTO users (id, email, password_hash, is_guest, expires_at)
     VALUES ($1, NULL, NULL, TRUE, $2)`,
    [userId, expiresAt.toISOString()],
  );

  // Deliberately no credit account: a guest never reaches a paid provider,
  // so there is nothing to meter.
  return createSession(db, userId, reply);
}

/** Removes expired guest accounts; conversations cascade. */
export async function sweepExpiredGuests(db: Db): Promise<number> {
  const rows = await db.query<{ id: string }>(
    `DELETE FROM users
      WHERE is_guest = TRUE AND expires_at IS NOT NULL AND expires_at < now()
     RETURNING id`,
  );
  return rows.length;
}

export async function readSession(
  db: Db,
  request: FastifyRequest,
): Promise<AuthenticatedSession | null> {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return null;

  const rows = await db.query<{
    user_id: string;
    csrf_token: string;
    expires_at: string | Date;
    email: string | null;
    is_guest: boolean;
    created_at: string | Date;
  }>(
    `SELECT s.user_id, s.csrf_token, s.expires_at, u.email, u.is_guest, u.created_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = $1`,
    [hashToken(raw)],
  );
  const row = rows[0];
  if (!row) return null;

  const expires = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
  if (expires.getTime() < Date.now()) {
    await db.query(`DELETE FROM sessions WHERE id_hash = $1`, [hashToken(raw)]);
    return null;
  }

  return {
    user: {
      id: row.user_id,
      email: row.email,
      isGuest: Boolean(row.is_guest),
      createdAt:
        row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    },
    csrfToken: row.csrf_token,
  };
}

export async function destroySession(db: Db, request: FastifyRequest, reply: FastifyReply) {
  const raw = request.cookies[SESSION_COOKIE];
  if (raw) await db.query(`DELETE FROM sessions WHERE id_hash = $1`, [hashToken(raw)]);
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export async function sweepExpiredSessions(db: Db): Promise<number> {
  const rows = await db.query<{ id_hash: string }>(
    `DELETE FROM sessions WHERE expires_at < now() RETURNING id_hash`,
  );
  return rows.length;
}

/** Constant-time CSRF comparison. */
export function csrfMatches(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const newUserId = () => randomUUID();
