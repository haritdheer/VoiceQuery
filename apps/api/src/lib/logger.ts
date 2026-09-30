import pino from 'pino';
import { config } from '../config/env.ts';

/**
 * Structured logging with aggressive redaction.
 *
 * Two rules this codebase holds to:
 *   1. No API key, password, cookie or session token is ever logged.
 *   2. No dataset cell contents are ever logged — only counts, column names
 *      and types. Call sites are responsible for the second; the redaction
 *      list below enforces the first.
 */

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-csrf-token"]',
  'req.headers["stripe-signature"]',
  'res.headers["set-cookie"]',
  'apiKey',
  'api_key',
  'password',
  'passwordHash',
  'password_hash',
  'sessionId',
  'token',
  'secret',
  '*.apiKey',
  '*.password',
  '*.token',
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  base: { service: 'voicequery-api' },
  transport:
    process.env.NODE_ENV === 'development' && !process.env.NO_PRETTY_LOGS
      ? undefined
      : undefined,
});

/**
 * Last-resort scrubber for strings that may embed a provider key, used on
 * error messages before they reach a log line or an HTTP response.
 * Anthropic keys look like `sk-ant-...`; the generic `sk-` form covers others.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-[redacted]')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{12,}/gi, 'Bearer [redacted]');
}

export function safeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactSecrets(raw);
}

export const isSilent = () => config().isTest;
