import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiError } from '@voicequery/shared';
import type { Db } from '../db/client.ts';
import { csrfMatches, readSession, type AuthenticatedSession } from '../auth/session.ts';

/**
 * Request plumbing shared by every route.
 *
 * The two rules enforced here are the ones that matter most for a multi-user
 * app: the acting user always comes from the session cookie (never from a
 * request body or header the client controls), and every mutating request
 * must carry a matching CSRF token.
 */

declare module 'fastify' {
  interface FastifyRequest {
    session?: AuthenticatedSession;
    db: Db;
  }
}

export function sendError(
  reply: FastifyReply,
  status: number,
  error: string,
  message: string,
  code?: ApiError['code'],
  details?: unknown,
): FastifyReply {
  const body: ApiError = { error, message };
  if (code) body.code = code;
  if (details !== undefined) body.details = details;
  return reply.status(status).send(body);
}

/**
 * Rejects the request unless a valid session exists.
 * Returns the session so handlers can read `session.user.id` directly — this
 * is the only accepted source of the acting user's identity.
 */
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthenticatedSession | null> {
  const session = request.session ?? (await readSession(request.db, request)) ?? undefined;
  if (!session) {
    sendError(reply, 401, 'unauthenticated', 'Please sign in to continue.');
    return null;
  }
  request.session = session;
  return session;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Double-submit CSRF check. The token is issued with the session and must be
 * echoed in X-CSRF-Token; a cross-site form post cannot set that header.
 */
export function requireCsrf(
  request: FastifyRequest,
  reply: FastifyReply,
  session: AuthenticatedSession,
): boolean {
  if (!MUTATING.has(request.method)) return true;
  const provided = request.headers['x-csrf-token'];
  const token = Array.isArray(provided) ? provided[0] : provided;
  if (!csrfMatches(session.csrfToken, token)) {
    sendError(reply, 403, 'csrf_failed', 'Your session expired. Refresh the page and try again.');
    return false;
  }
  return true;
}

/** Convenience: auth + CSRF in one call. Returns null when either fails. */
export async function requireAuthedRequest(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthenticatedSession | null> {
  const session = await requireAuth(request, reply);
  if (!session) return null;
  if (!requireCsrf(request, reply, session)) return null;
  return session;
}

/**
 * Auth + CSRF, and refuses guests.
 *
 * Guests may explore the sample dataset with the demo provider, but anything
 * that costs storage or money — uploading a dataset, connecting a provider
 * key, buying credits — requires a real account.
 */
export async function requireAccount(
  request: FastifyRequest,
  reply: FastifyReply,
  action = 'do that',
): Promise<AuthenticatedSession | null> {
  const session = await requireAuthedRequest(request, reply);
  if (!session) return null;

  if (session.user.isGuest) {
    sendError(
      reply,
      403,
      'account_required',
      `Create a free account to ${action}.`,
      'account_required',
    );
    return null;
  }
  return session;
}
