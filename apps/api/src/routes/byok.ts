import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { validateAnthropicKey } from '../ai/anthropic.ts';
import { validateOpenAiCompatibleKey } from '../ai/openaiCompatible.ts';
import { deleteKey, getKey, storeKey } from '../byok/keyStore.ts';
import {
  PROVIDERS,
  PROVIDER_IDS,
  SUPPORTED_PROVIDERS,
  DEFAULT_ANTHROPIC_MODEL,
  isProviderId,
} from '../ai/providers.ts';
import { requireAccount, requireAuth, sendError } from '../lib/http.ts';
import { logger } from '../lib/logger.ts';

/**
 * Bring-your-own-key endpoints.
 *
 * The key arrives once in a POST body over HTTPS, is validated against the
 * provider, and is then held in server memory keyed by user id. It is never
 * returned to the client, never written to the database, and never logged —
 * only its fingerprint (a truncated SHA-256) appears in logs, for abuse
 * accounting.
 *
 * Providers that route to many models (OpenAI, OpenRouter) also take a model
 * id, which is validated in the same round trip: a mistyped model is the
 * other thing users get wrong, and finding out at connect time beats finding
 * out on their first question.
 */

const ConnectBody = z.object({
  providerId: z.string().min(1).max(40),
  apiKey: z.string().trim().min(10, 'That key looks too short.').max(500),
  /** Required for providers where the catalogue says requiresModel. */
  model: z.string().trim().min(1).max(120).optional(),
});

export async function byokRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/byok', async (request, reply) => {
    const session = await requireAuth(request, reply);
    if (!session) return reply;

    const key = getKey(session.user.id);
    return {
      connected: Boolean(key),
      providerId: key?.providerId ?? null,
      model: key?.model ?? null,
      fingerprint: key?.fingerprint ?? null,
      expiresAt: key ? new Date(key.expiresAt).toISOString() : null,
      providers: SUPPORTED_PROVIDERS,
    };
  });

  app.post('/api/byok', async (request, reply) => {
    const session = await requireAccount(request, reply, 'connect your own API key');
    if (!session) return reply;

    const parsed = ConnectBody.safeParse(request.body);
    if (!parsed.success) {
      return sendError(
        reply,
        400,
        'validation',
        parsed.error.issues[0]?.message ?? 'Provide a provider and an API key.',
        'validation',
      );
    }

    const { providerId, apiKey } = parsed.data;
    if (!isProviderId(providerId)) {
      return sendError(
        reply,
        400,
        'validation',
        `Unsupported provider. Choose one of: ${PROVIDER_IDS.join(', ')}.`,
        'validation',
      );
    }

    const definition = PROVIDERS[providerId];
    const model = parsed.data.model ?? null;

    if (definition.requiresModel && !model) {
      return sendError(
        reply,
        400,
        'validation',
        `Choose a ${definition.label} model (for example ${definition.modelPlaceholder}).`,
        'validation',
      );
    }

    // Validation uses each provider's documented mechanism — one minimal
    // request. The UI states beforehand that this bills a few tokens.
    const result =
      definition.kind === 'anthropic'
        ? await validateAnthropicKey(apiKey, model ?? DEFAULT_ANTHROPIC_MODEL)
        : await validateOpenAiCompatibleKey(definition, apiKey, model!);

    if (!result.ok) {
      // The failure reason is reported, but the key never appears in it.
      logger.warn({ userId: session.user.id, providerId }, 'byok validation failed');
      return sendError(reply, 400, 'byok_failed', result.message, 'byok_failed');
    }

    const stored = storeKey(session.user.id, providerId, apiKey, model);
    logger.info(
      { userId: session.user.id, providerId, model, fingerprint: stored.fingerprint },
      'byok key connected',
    );

    return {
      connected: true,
      providerId,
      model: stored.model,
      fingerprint: stored.fingerprint,
      expiresAt: new Date(stored.expiresAt).toISOString(),
    };
  });

  app.delete('/api/byok', async (request, reply) => {
    const session = await requireAccount(request, reply, 'manage API keys');
    if (!session) return reply;

    deleteKey(session.user.id);
    logger.info({ userId: session.user.id }, 'byok key disconnected');
    return { connected: false, providerId: null, model: null, fingerprint: null, expiresAt: null };
  });
}
