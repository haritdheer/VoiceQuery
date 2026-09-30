import type { AiMode } from '@voicequery/shared';
import { config } from '../config/env.ts';
import { getKey } from '../byok/keyStore.ts';
import { AnthropicProvider } from './anthropic.ts';
import { OpenAiCompatibleProvider } from './openaiCompatible.ts';
import { DemoProvider } from './demo.ts';
import type { AiProvider } from './provider.ts';
import { PROVIDERS, isProviderId, DEFAULT_ANTHROPIC_MODEL, type ProviderId } from './providers.ts';

/**
 * Decides which AI account pays for a given request, and which provider runs it.
 *
 * Precedence, and the reasoning:
 *
 *   0. A guest always gets the demo provider. Anonymous traffic must never
 *      reach a paid endpoint — that is the cost boundary for open access.
 *   1. A connected BYOK key wins. The user explicitly chose to pay for their
 *      own usage, so we must not quietly spend platform credits instead.
 *   2. Otherwise the platform key, if configured — this consumes a credit.
 *   3. Otherwise the offline demo provider, clearly labelled.
 *
 * There is intentionally no fallback between (1) and (2). If a user's key
 * fails, the pipeline surfaces the provider's error and lets them decide;
 * silently charging them platform credits for a request they meant to fund
 * themselves would be wrong, and silently spending our own key on their
 * traffic is an abuse vector.
 */

export interface ResolvedProvider {
  provider: AiProvider;
  mode: AiMode;
  /** Only a platform-funded analysis consumes a credit. */
  consumesCredit: boolean;
}

/** Builds the concrete adapter for a provider id. */
export function buildProvider(
  providerId: ProviderId,
  apiKey: string,
  model: string | null,
): AiProvider {
  const definition = PROVIDERS[providerId];

  if (definition.kind === 'anthropic') {
    return new AnthropicProvider(apiKey, model ?? DEFAULT_ANTHROPIC_MODEL);
  }

  // OpenAI and OpenRouter both require an explicit model; the catalogue marks
  // them `requiresModel`, and the BYOK route rejects a missing one before we
  // ever get here.
  if (!model) {
    throw new Error(`A model id is required for ${definition.label}.`);
  }
  return new OpenAiCompatibleProvider(definition, apiKey, model);
}

export function resolveProvider(
  sessionScope: string | null,
  options: { isGuest?: boolean } = {},
): ResolvedProvider {
  const cfg = config();

  // A guest is anonymous, so they never reach a paid provider — not the
  // platform key, and not a BYOK key they could not have connected anyway.
  // Without this, "try it without signing in" would be an open invitation to
  // spend the operator's AI budget.
  if (options.isGuest) {
    return { provider: new DemoProvider(), mode: 'demo', consumesCredit: false };
  }

  if (sessionScope) {
    const byok = getKey(sessionScope);
    if (byok) {
      if (!isProviderId(byok.providerId)) {
        throw new Error(`Unsupported BYOK provider "${byok.providerId}".`);
      }
      return {
        provider: buildProvider(byok.providerId, byok.apiKey, byok.model),
        mode: 'byok',
        consumesCredit: false,
      };
    }
  }

  const platform = cfg.platformProvider;
  if (platform) {
    return {
      provider: buildProvider(platform.id, platform.apiKey, platform.model),
      mode: 'platform',
      consumesCredit: true,
    };
  }

  // No credentials anywhere: answer with the rule-based demo provider.
  //
  // This makes no provider call and spends nothing, so by default it consumes
  // no credit — the same reasoning that exempts BYOK. Hosting and CPU are
  // still real costs, and the rate limits cover those.
  //
  // DEMO_CONSUMES_CREDITS re-enables charging so the free-allowance and
  // upgrade flows can be walked through on a deployment with no AI
  // credentials. Either way `simulated: true` is returned and the UI badges
  // it, so a rule-based answer is never passed off as a model's.
  return {
    provider: new DemoProvider(),
    mode: 'demo',
    consumesCredit: cfg.DEMO_CONSUMES_CREDITS,
  };
}
