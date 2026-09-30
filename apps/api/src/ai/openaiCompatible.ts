import OpenAI from 'openai';
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
} from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
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
import type { ProviderDefinition } from './providers.ts';
import { safeErrorMessage } from '../lib/logger.ts';

/**
 * Adapter for OpenAI and any OpenAI-wire-compatible endpoint.
 *
 * OpenRouter implements the same protocol at a different base URL, so one
 * class serves both — the differences (base URL, attribution headers, model
 * naming) live in the provider definition rather than in branching here.
 *
 * The one real behavioural difference is structured output support. OpenAI
 * honours `response_format: json_schema` with `strict: true`; on OpenRouter it
 * depends on which model you routed to. So the SQL step tries strict schema
 * mode and falls back to plain JSON mode, validating the result against the
 * same zod schema either way. A response that fails validation is an error,
 * never a silently accepted guess.
 */

function toUsage(usage: OpenAI.CompletionUsage | undefined): TokenUsage | null {
  if (!usage) return null;
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    cacheReadInputTokens: usage.prompt_tokens_details?.cached_tokens ?? undefined,
  };
}

function translateError(
  err: unknown,
  definition: ProviderDefinition,
  model?: string,
): ProviderError {
  const label = definition.label;

  // Most specific first; every subclass check must precede APIError.
  if (err instanceof AuthenticationError) {
    return new ProviderError(`The API key was rejected by ${label}.`, 'auth');
  }
  if (err instanceof PermissionDeniedError) {
    // 403 on OpenRouter can also mean a moderation or guardrail block, which
    // is not a key problem — say both rather than misdiagnose it.
    return new ProviderError(
      `${label} refused the request. The key may lack access to that model, or the request was blocked by the provider's content policy.`,
      'auth',
    );
  }
  if (err instanceof RateLimitError) {
    // OpenAI signals an exhausted balance as 429 + insufficient_quota, which
    // is not a transient blip — do not invite a pointless retry.
    if (/quota|billing|credit/i.test(`${err.code ?? ''} ${err.message}`)) {
      return new ProviderError(outOfCreditMessage(definition), 'auth');
    }
    return new ProviderError(`${label} is rate limiting requests.`, 'rate_limit', true);
  }
  if (err instanceof APIUserAbortError) {
    return new ProviderError('The request was cancelled.', 'timeout');
  }
  if (err instanceof APIConnectionTimeoutError) {
    return new ProviderError(`${label} timed out.`, 'timeout', true);
  }
  if (err instanceof APIConnectionError) {
    return new ProviderError(`Could not reach ${label}.`, 'unavailable', true);
  }
  if (err instanceof APIError) {
    const status = err.status ?? 0;

    // 402 Payment Required. OpenRouter returns this when the account or key
    // is out of credit; the fix is to top up, not to retry.
    if (status === 402) {
      return new ProviderError(outOfCreditMessage(definition), 'auth');
    }
    if (status === 404) {
      return new ProviderError(
        model
          ? `${label} does not recognise the model "${model}". Check the model id.`
          : `${label} does not recognise that model id.`,
        'invalid_response',
      );
    }
    // OpenRouter-specific routing failures, both genuinely transient.
    if (status === 502) {
      return new ProviderError(
        `The model you selected is unavailable right now. Try again, or pick a different model.`,
        'unavailable',
        true,
      );
    }
    if (status === 503) {
      return new ProviderError(
        `No provider is currently available for that model. Try a different model.`,
        'unavailable',
        true,
      );
    }

    const retryable = status >= 500;
    return new ProviderError(
      `${label} returned an error (${status || 'unknown'}).`,
      retryable ? 'unavailable' : 'invalid_response',
      retryable,
    );
  }
  return new ProviderError(safeErrorMessage(err), 'unavailable');
}

/** A 402 is actionable, so the message says exactly what to do and where. */
function outOfCreditMessage(definition: ProviderDefinition): string {
  return `Your ${definition.label} account is out of credit. Top up at ${definition.billingUrl} and try again — VoiceQuery does not bill you, your provider does.`;
}

/** True when the provider rejected the strict json_schema request format. */
function isSchemaUnsupported(err: unknown): boolean {
  if (!(err instanceof APIError)) return false;
  if (err.status !== 400 && err.status !== 422) return false;
  return /response_format|json_schema|structured output|not supported/i.test(err.message);
}

export class OpenAiCompatibleProvider implements AiProvider {
  readonly id: string;
  readonly simulated = false;
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly label: string;
  private readonly definition: ProviderDefinition;

  constructor(definition: ProviderDefinition, apiKey: string, model: string) {
    this.id = definition.id;
    this.label = definition.label;
    this.definition = definition;
    this.model = model;
    this.client = new OpenAI({
      apiKey,
      baseURL: definition.baseUrl,
      defaultHeaders: definition.headers,
      timeout: config().AI_TIMEOUT_MS,
      maxRetries: 1,
    });
  }

  async generateSqlPlan(req: SqlPlanRequest): Promise<ProviderResponse<SqlPlan>> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: SQL_SYSTEM_PROMPT },
      { role: 'user', content: buildSqlUserMessage(req.question, req.schemaText, req.history) },
    ];

    try {
      const response = await this.client.chat.completions.parse(
        {
          model: this.model,
          max_completion_tokens: config().AI_MAX_OUTPUT_TOKENS,
          messages,
          response_format: zodResponseFormat(SqlPlanSchema, 'sql_plan'),
        },
        { signal: req.signal },
      );

      const parsed = response.choices[0]?.message.parsed;
      if (!parsed) {
        throw new ProviderError(
          `${this.label} returned a response that did not match the expected format.`,
          'invalid_response',
        );
      }
      return { value: parsed, usage: toUsage(response.usage), simulated: false };
    } catch (err) {
      if (err instanceof ProviderError) throw err;

      // Not every model behind OpenRouter supports strict schemas. Retry in
      // plain JSON mode and validate ourselves rather than giving up.
      if (isSchemaUnsupported(err)) {
        return this.generateSqlPlanViaJsonMode(messages, req.signal);
      }
      throw translateError(err, this.definition, this.model);
    }
  }

  /** Fallback for models without strict structured-output support. */
  private async generateSqlPlanViaJsonMode(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    signal: AbortSignal | undefined,
  ): Promise<ProviderResponse<SqlPlan>> {
    const shape = JSON.stringify(
      zodResponseFormat(SqlPlanSchema, 'sql_plan').json_schema.schema,
    );

    try {
      const response = await this.client.chat.completions.create(
        {
          model: this.model,
          max_completion_tokens: config().AI_MAX_OUTPUT_TOKENS,
          response_format: { type: 'json_object' },
          messages: [
            ...messages,
            {
              role: 'system',
              content: `Reply with a single JSON object and nothing else. It must conform exactly to this JSON Schema:\n${shape}`,
            },
          ],
        },
        { signal },
      );

      const text = response.choices[0]?.message.content ?? '';
      let candidate: unknown;
      try {
        candidate = JSON.parse(text);
      } catch {
        throw new ProviderError(
          `${this.label} did not return valid JSON. Try a model that supports structured outputs.`,
          'invalid_response',
        );
      }

      // Same schema as the strict path, so a malformed plan is still rejected.
      const validated = SqlPlanSchema.safeParse(candidate);
      if (!validated.success) {
        throw new ProviderError(
          `${this.label} returned JSON that did not match the expected shape. Try a model that supports structured outputs.`,
          'invalid_response',
        );
      }

      return { value: validated.data, usage: toUsage(response.usage), simulated: false };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw translateError(err, this.definition, this.model);
    }
  }

  async explain(req: ExplanationRequest): Promise<ProviderResponse<string>> {
    try {
      const response = await this.client.chat.completions.create(
        {
          model: this.model,
          max_completion_tokens: 1_000,
          messages: [
            { role: 'system', content: EXPLAIN_SYSTEM_PROMPT },
            { role: 'user', content: buildExplainUserMessage(req) },
          ],
        },
        { signal: req.signal },
      );

      const text = (response.choices[0]?.message.content ?? '').trim();
      if (!text) {
        throw new ProviderError(`${this.label} returned an empty explanation.`, 'invalid_response');
      }
      return { value: text, usage: toUsage(response.usage), simulated: false };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw translateError(err, this.definition, this.model);
    }
  }
}

/**
 * Checks a user-supplied key using the provider's own API.
 *
 * This issues one real (tiny) completion, which bills a few tokens to the key
 * owner's account — disclosed in the UI before they submit. It also catches a
 * wrong model id, which is the other thing likely to be mistyped.
 */
export async function validateOpenAiCompatibleKey(
  definition: ProviderDefinition,
  apiKey: string,
  model: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const client = new OpenAI({
    apiKey,
    baseURL: definition.baseUrl,
    defaultHeaders: definition.headers,
    timeout: 20_000,
    maxRetries: 0,
  });

  try {
    await client.chat.completions.create({
      model,
      max_completion_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: translateError(err, definition, model).message };
  }
}

/** Exposed for tests: the user-facing wording of provider failures. */
export const __testTranslateError = translateError;
