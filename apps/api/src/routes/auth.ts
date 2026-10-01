import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SessionState } from '@voicequery/shared';
import {
  createGuestSession,
  createSession,
  destroySession,
  newUserId,
  readSession,
  type AuthenticatedSession,
} from '../auth/session.ts';
import { countGuestQuestions } from '../ai/pipeline.ts';
import { fakeVerify, hashPassword, verifyPassword } from '../auth/password.ts';
import { createAccountWithFreeGrant, getBalance } from '../credits/ledger.ts';
import { getKey } from '../byok/keyStore.ts';
import { config } from '../config/env.ts';
import { requireAuth, requireCsrf, sendError } from '../lib/http.ts';
import { logger } from '../lib/logger.ts';

/**
 * Deliberately permissive: this is a portfolio demo, and anything that looks
 * like a sign-up form stops people trying it. No email format is required and
 * no minimum password length is imposed — "demo"/"demo" is a valid account.
 *
 * Nothing is ever sent to the address, so requiring a real one bought nothing.
 * The field stays named `email` because it is the account's unique identity
 * and the column it lives in; it is simply a username now.
 *
 * Still trimmed and lower-cased so " Demo " and "demo" are the same account
 * rather than two, and still length-capped so the column cannot be used as a
 * storage dump.
 */
const CredentialsSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.string().min(1, 'Enter a username.').max(254, 'That is too long.')),
  password: z.string().min(1, 'Enter a password.').max(200, 'That password is too long.'),
});

/**
 * Renders the client's view of the session.
 *
 * `known` must be passed on the register/login paths: the session cookie was
 * just set on the *reply*, so it is not yet present on the request and
 * re-reading it there would report the caller as signed out.
 */
async function buildState(
  req: Parameters<typeof readSession>[1],
  db: Parameters<typeof readSession>[0],
  known?: AuthenticatedSession,
): Promise<SessionState> {
  const cfg = config();
  const session = known ?? (await readSession(db, req));
  if (!session) {
    return {
      user: null,
      credits: 0,
      freeGrantIssued: false,
      aiMode: cfg.demoMode ? 'demo' : 'platform',
      creditsApply: cfg.demoMode ? cfg.DEMO_CONSUMES_CREDITS : true,
      byokProvider: null,
      csrfToken: null,
      guest: null,
    };
  }

  // A guest has no credit account and always runs on the demo provider.
  if (session.user.isGuest) {
    const used = await countGuestQuestions(db, session.user.id);
    return {
      user: session.user,
      credits: 0,
      freeGrantIssued: false,
      aiMode: 'demo',
      creditsApply: false,
      byokProvider: null,
      csrfToken: session.csrfToken,
      guest: {
        questionsUsed: used,
        questionsLimit: cfg.GUEST_QUESTION_LIMIT,
        exhausted: used >= cfg.GUEST_QUESTION_LIMIT,
      },
    };
  }

  const credits = await getBalance(db, session.user.id);
  const rows = await db.query<{ free_grant_issued: boolean }>(
    `SELECT free_grant_issued FROM credit_accounts WHERE user_id = $1`,
    [session.user.id],
  );

  const byok = getKey(session.user.id);
  const aiMode = byok ? 'byok' : cfg.demoMode ? 'demo' : 'platform';

  // Mirrors resolveProvider(): a user's own key never spends our credits, and
  // neither does the demo provider unless the operator opted in.
  const creditsApply =
    aiMode === 'byok' ? false : aiMode === 'demo' ? cfg.DEMO_CONSUMES_CREDITS : true;

  return {
    user: session.user,
    credits,
    freeGrantIssued: Boolean(rows[0]?.free_grant_issued),
    aiMode,
    creditsApply,
    byokProvider: byok?.providerId ?? null,
    csrfToken: session.csrfToken,
    guest: null,
  };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/auth/session', async (request) => buildState(request, request.db));

  /**
   * Starts an anonymous demo session. No credentials, no credits, sample
   * dataset only, and always the demo provider — so this endpoint cannot be
   * used to spend the operator's AI budget.
   */
  app.post('/api/auth/guest', async (request, reply) => {
    const cfg = config();
    if (!cfg.GUEST_MODE_ENABLED) {
      return sendError(
        reply,
        403,
        'guest_disabled',
        'Anonymous demo access is disabled on this deployment. Please sign in.',
      );
    }

    // Already signed in? Hand back the existing session rather than orphaning
    // it behind a new guest one.
    const existing = await readSession(request.db, request);
    if (existing) return buildState(request, request.db, existing);

    const created = await createGuestSession(request.db, reply);
    logger.info({ userId: created.user.id }, 'guest session started');
    return buildState(request, request.db, created);
  });

  app.post('/api/auth/register', async (request, reply) => {
    const parsed = CredentialsSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(
        reply,
        400,
        'validation',
        parsed.error.issues[0]?.message ?? 'Invalid details.',
        'validation',
      );
    }
    const { email, password } = parsed.data;

    const existing = await request.db.query<{ id: string }>(
      `SELECT id FROM users WHERE email = $1`,
      [email],
    );
    if (existing.length > 0) {
      return sendError(
        reply,
        409,
        'email_taken',
        'That username is already taken. Try signing in instead.',
      );
    }

    const userId = newUserId();
    const passwordHash = await hashPassword(password);

    // Account creation and the one-time free grant are one transaction, so a
    // user can never exist without exactly the configured number of credits.
    await request.db.transaction(async (tx) => {
      await tx.query(`INSERT INTO users (id, email, password_hash) VALUES ($1,$2,$3)`, [
        userId,
        email,
        passwordHash,
      ]);
      await createAccountWithFreeGrant(tx, userId);
    });

    const created = await createSession(request.db, userId, reply);
    logger.info({ userId }, 'user registered');
    return buildState(request, request.db, created);
  });

  app.post('/api/auth/login', async (request, reply) => {
    const parsed = CredentialsSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'validation', 'Enter a username and password.', 'validation');
    }
    const { email, password } = parsed.data;

    const rows = await request.db.query<{ id: string; password_hash: string }>(
      `SELECT id, password_hash FROM users WHERE email = $1`,
      [email],
    );
    const user = rows[0];

    if (!user) {
      // Spend comparable CPU so timing does not reveal whether the account exists.
      await fakeVerify();
      return sendError(reply, 401, 'invalid_credentials', 'Incorrect username or password.');
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return sendError(reply, 401, 'invalid_credentials', 'Incorrect username or password.');
    }

    // An account created before the grant logic (or by a failed migration)
    // still gets exactly one grant here; the flag makes it idempotent.
    await request.db.transaction(async (tx) => createAccountWithFreeGrant(tx, user.id));

    const created = await createSession(request.db, user.id, reply);
    return buildState(request, request.db, created);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const session = await requireAuth(request, reply);
    if (!session) return reply;
    if (!requireCsrf(request, reply, session)) return reply;

    await destroySession(request.db, request, reply);
    return buildState(request, request.db);
  });
}
