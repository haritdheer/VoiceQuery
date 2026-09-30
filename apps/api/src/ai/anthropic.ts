import Anthropic from '@anthropic-ai/sdk';
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { TokenUsage } from '@voicequery/shared';
import { config } from '../config/env.ts';
import {
  ProviderError,
  SqlPlanSchema,
  type AiProvider,
  type ExplanationRequest,
  type ProviderResponse,
  type SqlPlan,
  type SqlPlanRequest,
} from './provider.ts';
import {
  EXPLAIN_SYSTEM_PROMPT,
  SQL_SYSTEM_PROMPT,
  buildExplainUserMessage,
  buildSqlUserMessage,
} from './prompts.ts';
import { safeErrorMessage } from '../lib/logger.ts';

/**
 * Anthropic provider.
 *
 * The SQL step uses structured outputs (`messages.parse` + `zodOutputFormat`)
 * so the plan arrives schema-valid rather than being scraped out of prose.
 */

function toUsage(usage: Anthropic.Usage | undefined): TokenUsage | null {
  if (!usage) return null;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? undefined,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? undefined,
  };
}

/** Maps SDK exceptions onto the pipeline's error vocabulary. */
function translateError(err: unknown): ProviderError {
  // Ordered most specific first; every subclass check must precede APIError.
  if (err instanceof AuthenticationError) {
    return new ProviderError('The API key was rejected by Anthropic.', 'auth');
  }
  if (err instanceof PermissionDeniedError) {
    return new ProviderError('This API key is not permitted to use the Messages API.', 'auth');
  }
  if (err instanceof RateLimitError) {
    return new ProviderError('The AI provider is rate limiting requests.', 'rate_limit', true);
  }
  if (err instanceof APIUserAbortError) {
    return new ProviderError('The request was cancelled.', 'timeout');
  }
  if (err instanceof APIConnectionTimeoutError) {
    return new ProviderError('The AI provider timed out.', 'timeout', true);
  }
  if (err instanceof APIConnectionError) {
    return new ProviderError('Could not reach the AI provider.', 'unavailable', true);
  }
  if (err instanceof APIError) {
    const status = err.status ?? 0;
    const retryable = status >= 500;
    return new ProviderError(
      `The AI provider returned an error (${status || 'unknown'}).`,
      retryable ? 'unavailable' : 'invalid_response',
      retryable,
    );
  }
  return new ProviderError(safeErrorMessage(err), 'unavailable');
}

export class AnthropicProvider implements AiProvider {
  readonly id = 'anthropic';
  readonly simulated = false;
  private readonly client: Anthropic;

  private readonly model: string;

  constructor(apiKey: string, model: string) {
    this.model = model;
    this.client = new Anthropic({
      apiKey,
      timeout: config().AI_TIMEOUT_MS,
      maxRetries: 1,
    });
  }

  async generateSqlPlan(req: SqlPlanRequest): Promise<ProviderResponse<SqlPlan>> {
    const cfg = config();
    try {
      const response = await this.client.messages.parse(
        {
          model: this.model,
          max_tokens: cfg.AI_MAX_OUTPUT_TOKENS,
          // The system prompt is stable across every request, so caching it
          // pays off immediately on the second question.
          system: [
            { type: 'text', text: SQL_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
          ],
          messages: [
            {
              role: 'user',
              content: buildSqlUserMessage(req.question, req.schemaText, req.history),
            },
          ],
          output_config: { format: zodOutputFormat(SqlPlanSchema) },
        },
        { signal: req.signal },
      );

      if (response.stop_reason === 'refusal') {
        throw new ProviderError(
          'The AI provider declined to answer this request.',
          'invalid_response',
        );
      }

      const parsed = response.parsed_output;
      if (!parsed) {
        throw new ProviderError(
          'The AI provider returned a response that did not match the expected format.',
          'invalid_response',
        );
      }

      return { value: parsed, usage: toUsage(response.usage), simulated: false };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw translateError(err);
    }
  }

  async explain(req: ExplanationRequest): Promise<ProviderResponse<string>> {
    const cfg = config();
    try {
      const response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: 1_000,
          system: [
            { type: 'text', text: EXPLAIN_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
          ],
          messages: [{ role: 'user', content: buildExplainUserMessage(req) }],
        },
        { signal: req.signal },
      );

      if (response.stop_reason === 'refusal') {
        throw new ProviderError(
          'The AI provider declined to summarise these results.',
          'invalid_response',
        );
      }

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();

      if (!text) {
        throw new ProviderError('The AI provider returned an empty explanation.', 'invalid_response');
      }

      return { value: text, usage: toUsage(response.usage), simulated: false };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw translateError(err);
    }
  }
}

/**
 * Checks a user-supplied key using the provider's documented mechanism.
 *
 * This issues one real (tiny) Messages request, which bills a few tokens to
 * the key owner's account. The UI discloses that before the user submits.
 */
export async function validateAnthropicKey(
  apiKey: string,
  model: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const client = new Anthropic({ apiKey, timeout: 15_000, maxRetries: 0 });
  try {
    await client.messages.create({
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });
    return { ok: true };
  } catch (err) {
    const translated = translateError(err);
    return { ok: false, message: translated.message };
  }
}
