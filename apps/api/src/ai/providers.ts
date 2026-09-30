import type { ProviderInfo } from '@voicequery/shared';

/**
 * The catalogue of supported AI providers.
 *
 * Anthropic uses its own SDK (`anthropic.ts`). OpenAI and OpenRouter share one
 * adapter (`openaiCompatible.ts`) because OpenRouter implements the OpenAI
 * wire protocol — it is the same request shape at a different base URL.
 *
 * Two deliberate choices here:
 *
 *  - **No key-prefix validation.** A wrong guess about a provider's key format
 *    would reject perfectly valid keys, and the real check is the validation
 *    request anyway. Prefixes appear only as placeholder text.
 *  - **The model is the user's choice** for OpenAI and OpenRouter. Hardcoding
 *    a default would rot the moment the provider renames something, and for
 *    OpenRouter picking the model is the entire point of using it.
 */

export type ProviderId = 'anthropic' | 'openai' | 'openrouter';

/** Anthropic model ids are stable enough to default; the others are not. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';

export interface ProviderDefinition extends ProviderInfo {
  id: ProviderId;
  /** Where the user tops up, quoted in the out-of-credit error. */
  billingUrl: string;
  /** OpenAI-compatible providers share one adapter; anthropic has its own. */
  kind: 'anthropic' | 'openai-compatible';
  /** Base URL override for the OpenAI client. Undefined means the SDK default. */
  baseUrl?: string;
  /** Extra headers sent on every request. */
  headers?: Record<string, string>;
}

export const PROVIDERS: Record<ProviderId, ProviderDefinition> = {
  anthropic: {
    id: 'anthropic',
    kind: 'anthropic',
    label: 'Anthropic (Claude)',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    billingUrl: 'https://console.anthropic.com/settings/billing',
    keyPlaceholder: 'sk-ant-...',
    // The server's AI_MODEL applies; the user does not pick one.
    requiresModel: false,
    modelsUrl: 'https://platform.claude.com/docs/en/about-claude/models/overview',
    modelPlaceholder: null,
    validationNote:
      'Validation sends one minimal request to the Messages API, which bills a small number of tokens to your account.',
    subscriptionNote:
      'A Claude Pro or Max subscription is a separate product and does not include API credits. You need billing set up in the Anthropic Console.',
  },

  openai: {
    id: 'openai',
    kind: 'openai-compatible',
    label: 'OpenAI',
    keyUrl: 'https://platform.openai.com/api-keys',
    billingUrl: 'https://platform.openai.com/settings/organization/billing',
    keyPlaceholder: 'sk-...',
    requiresModel: true,
    modelsUrl: 'https://developers.openai.com/api/docs/models',
    modelPlaceholder: 'gpt-6.1-sol',
    validationNote:
      'Validation sends one minimal request to the Chat Completions API, which bills a small number of tokens to your account.',
    subscriptionNote:
      'A ChatGPT Plus or Pro subscription is a separate product and does not include API credits. You need billing set up on the OpenAI platform.',
  },

  openrouter: {
    id: 'openrouter',
    kind: 'openai-compatible',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
    billingUrl: 'https://openrouter.ai/credits',
    keyPlaceholder: 'sk-or-v1-...',
    requiresModel: true,
    modelsUrl: 'https://openrouter.ai/models?supported_parameters=structured_outputs',
    // OpenRouter model ids are vendor-prefixed.
    modelPlaceholder: 'anthropic/claude-sonnet-4.5',
    // Optional attribution headers, documented by OpenRouter for leaderboards.
    headers: {
      'HTTP-Referer': 'https://github.com/voicequery',
      'X-OpenRouter-Title': 'VoiceQuery',
    },
    validationNote:
      'Validation sends one minimal request through OpenRouter, which bills a small amount to your account.',
    subscriptionNote:
      'OpenRouter is pay-as-you-go: add credit to your OpenRouter account. Not every model supports structured outputs — pick one that does, or VoiceQuery will fall back to plain JSON mode.',
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isProviderId(value: string): value is ProviderId {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, value);
}

/** The public, client-safe view of the catalogue. */
export const SUPPORTED_PROVIDERS: ProviderInfo[] = PROVIDER_IDS.map((id) => {
  const {
    kind: _kind,
    baseUrl: _baseUrl,
    headers: _headers,
    billingUrl: _billingUrl,
    ...pub
  } = PROVIDERS[id];
  return pub;
});
