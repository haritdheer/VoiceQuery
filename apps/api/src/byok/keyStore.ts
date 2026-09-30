import { createHash } from 'node:crypto';

/**
 * Bring-your-own-key storage.
 *
 * Deliberately in-memory and short-lived. A user's provider key is held only
 * for the life of their session (or `ttlMs`, whichever is shorter) and never:
 *
 *   - written to the application database,
 *   - written to a log line or an error message,
 *   - placed in a URL, query string or analytics event,
 *   - returned to the browser after it is set.
 *
 * The browser never persists it either — the client keeps it in memory for the
 * single POST that installs it and then forgets it. The tradeoff is that keys
 * do not survive an API restart, which is the correct default; the README
 * documents what encrypted-at-rest persistence would require if that changes.
 */

export interface StoredKey {
  providerId: string;
  apiKey: string;
  /** Model id, for providers where the user chooses one. */
  model: string | null;
  expiresAt: number;
  /** Non-reversible identifier, safe to log for abuse accounting. */
  fingerprint: string;
}

const keys = new Map<string, StoredKey>();

/** Sessions are the scoping unit so a key dies with the session. */
export type KeyScope = string;

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;

export function fingerprint(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 12);
}

export function storeKey(
  scope: KeyScope,
  providerId: string,
  apiKey: string,
  model: string | null = null,
  ttlMs = DEFAULT_TTL_MS,
): StoredKey {
  const record: StoredKey = {
    providerId,
    apiKey,
    model,
    expiresAt: Date.now() + ttlMs,
    fingerprint: fingerprint(apiKey),
  };
  keys.set(scope, record);
  return record;
}

export function getKey(scope: KeyScope): StoredKey | null {
  const record = keys.get(scope);
  if (!record) return null;
  if (record.expiresAt < Date.now()) {
    keys.delete(scope);
    return null;
  }
  return record;
}

export function deleteKey(scope: KeyScope): boolean {
  return keys.delete(scope);
}

export function sweepExpiredKeys(): number {
  const now = Date.now();
  let removed = 0;
  for (const [scope, record] of keys) {
    if (record.expiresAt < now) {
      keys.delete(scope);
      removed++;
    }
  }
  return removed;
}

/** Test helper. */
export function clearAllKeys(): void {
  keys.clear();
}
