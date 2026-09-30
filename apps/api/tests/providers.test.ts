import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, TestClient, uniqueEmail, type TestContext } from './helpers.ts';
import { buildProvider, resolveProvider } from '../src/ai/registry.ts';
import { PROVIDERS, PROVIDER_IDS, SUPPORTED_PROVIDERS, isProviderId } from '../src/ai/providers.ts';
import { AnthropicProvider } from '../src/ai/anthropic.ts';
import { OpenAiCompatibleProvider } from '../src/ai/openaiCompatible.ts';
import { storeKey, clearAllKeys } from '../src/byok/keyStore.ts';
import { resetConfigForTests } from '../src/config/env.ts';
import { APIError, AuthenticationError, RateLimitError } from 'openai';
import { __testTranslateError } from '../src/ai/openaiCompatible.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});
afterEach(() => clearAllKeys());

describe('provider catalogue', () => {
  it('exposes anthropic, openai and openrouter', () => {
    expect(PROVIDER_IDS).toEqual(['anthropic', 'openai', 'openrouter']);
    expect(SUPPORTED_PROVIDERS.map((p) => p.id)).toEqual(PROVIDER_IDS);
  });

  it('never leaks server-side fields to the client view', () => {
    const serialised = JSON.stringify(SUPPORTED_PROVIDERS);
    // baseUrl/headers/kind are implementation detail, not client contract.
    expect(serialised).not.toContain('baseUrl');
    expect(serialised).not.toContain('"kind"');
    expect(serialised).not.toContain('headers');
  });

  it('marks which providers need the user to choose a model', () => {
    expect(PROVIDERS.anthropic.requiresModel).toBe(false);
    expect(PROVIDERS.openai.requiresModel).toBe(true);
    expect(PROVIDERS.openrouter.requiresModel).toBe(true);
  });

  it('routes OpenRouter through its own base URL', () => {
    expect(PROVIDERS.openrouter.baseUrl).toBe('https://openrouter.ai/api/v1');
    // OpenAI uses the SDK default.
    expect(PROVIDERS.openai.baseUrl).toBeUndefined();
  });

  it('gives every provider a subscription caveat and a models link', () => {
    for (const id of PROVIDER_IDS) {
      const p = PROVIDERS[id];
      expect(p.subscriptionNote.length, id).toBeGreaterThan(20);
      expect(p.modelsUrl, id).toMatch(/^https:\/\//);
      expect(p.keyUrl, id).toMatch(/^https:\/\//);
    }
  });

  it('rejects unknown provider ids', () => {
    expect(isProviderId('anthropic')).toBe(true);
    expect(isProviderId('openai')).toBe(true);
    expect(isProviderId('openrouter')).toBe(true);
    expect(isProviderId('definitely-not-a-provider')).toBe(false);
  });
});

describe('building the right adapter', () => {
  it('uses the Anthropic SDK for anthropic', () => {
    const provider = buildProvider('anthropic', 'sk-ant-test', null);
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.simulated).toBe(false);
  });

  it('uses the OpenAI-compatible adapter for openai and openrouter', () => {
    expect(buildProvider('openai', 'sk-test', 'gpt-6.1-sol')).toBeInstanceOf(
      OpenAiCompatibleProvider,
    );
    expect(
      buildProvider('openrouter', 'sk-or-test', 'anthropic/claude-sonnet-4.5'),
    ).toBeInstanceOf(OpenAiCompatibleProvider);
  });

  it('refuses to build an OpenAI-compatible provider without a model', () => {
    expect(() => buildProvider('openai', 'sk-test', null)).toThrow(/model id is required/i);
  });
});

describe('BYOK resolution across providers', () => {
  it.each([
    ['openai', 'gpt-6.1-sol'],
    ['openrouter', 'anthropic/claude-sonnet-4.5'],
  ] as const)('resolves a %s key to byok mode with no credit charge', (id, model) => {
    storeKey('scope-1', id, 'sk-user-supplied', model);
    const resolved = resolveProvider('scope-1');
    expect(resolved.mode).toBe('byok');
    expect(resolved.consumesCredit).toBe(false);
    expect(resolved.provider.id).toBe(id);
  });

  it('keeps a guest on the demo provider whatever key is stored', () => {
    storeKey('scope-2', 'openrouter', 'sk-or-should-not-be-used', 'anthropic/claude-sonnet-4.5');
    const resolved = resolveProvider('scope-2', { isGuest: true });
    expect(resolved.mode).toBe('demo');
    expect(resolved.provider.simulated).toBe(true);
  });
});

/**
 * The platform provider is chosen from whichever key is set, with AI_PROVIDER
 * to disambiguate. These assertions cover the failure modes that would
 * otherwise only show up as a confusing boot error.
 */
describe('platform provider selection', () => {
  const ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'AI_PROVIDER', 'AI_MODEL'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetConfigForTests();
  });

  function setEnv(vars: Record<string, string | undefined>) {
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
    resetConfigForTests();
  }

  async function load() {
    const { config } = await import('../src/config/env.ts');
    return config();
  }

  it('picks the single configured provider automatically', async () => {
    setEnv({ OPENAI_API_KEY: 'sk-test', AI_MODEL: 'gpt-6.1-sol' });
    const cfg = await load();
    expect(cfg.demoMode).toBe(false);
    expect(cfg.platformProvider?.id).toBe('openai');
    expect(cfg.platformProvider?.model).toBe('gpt-6.1-sol');
  });

  it('defaults the Anthropic model but requires one for the others', async () => {
    setEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect((await load()).platformProvider?.model).toBe('claude-opus-5');

    setEnv({ OPENROUTER_API_KEY: 'sk-or-test' });
    await expect(load()).rejects.toThrow(/AI_MODEL must be set/);
  });

  it('refuses to guess when several keys are set', async () => {
    setEnv({ ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-oa', AI_MODEL: 'x' });
    await expect(load()).rejects.toThrow(/Set AI_PROVIDER to choose/);
  });

  it('honours AI_PROVIDER when several keys are set', async () => {
    setEnv({
      ANTHROPIC_API_KEY: 'sk-ant',
      OPENAI_API_KEY: 'sk-oa',
      AI_PROVIDER: 'openai',
      AI_MODEL: 'gpt-6-luna',
    });
    const cfg = await load();
    expect(cfg.platformProvider?.id).toBe('openai');
    expect(cfg.platformProvider?.apiKey).toBe('sk-oa');
  });

  it('errors when AI_PROVIDER names a provider with no key', async () => {
    setEnv({ ANTHROPIC_API_KEY: 'sk-ant', AI_PROVIDER: 'openrouter' });
    await expect(load()).rejects.toThrow(/OPENROUTER_API_KEY is not set/);
  });

  it('falls back to demo mode with no keys at all', async () => {
    setEnv({});
    const cfg = await load();
    expect(cfg.demoMode).toBe(true);
    expect(cfg.platformProvider).toBeNull();
  });
});

describe('BYOK endpoint across providers', () => {
  async function signedIn() {
    const client = new TestClient(ctx.app);
    await client.register(uniqueEmail());
    return client;
  }

  it('lists all three providers', async () => {
    const client = await signedIn();
    const res = await client.request('GET', '/api/byok');
    const providers = res.body.providers as { id: string }[];
    expect(providers.map((p) => p.id)).toEqual(['anthropic', 'openai', 'openrouter']);
  });

  it('rejects an unknown provider id', async () => {
    const client = await signedIn();
    const res = await client.request('POST', '/api/byok', {
      providerId: 'not-a-provider',
      apiKey: 'sk-something-long-enough',
    });
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toMatch(/Unsupported provider/);
  });

  it('requires a model for OpenAI and names an example', async () => {
    const client = await signedIn();
    const res = await client.request('POST', '/api/byok', {
      providerId: 'openai',
      apiKey: 'sk-something-long-enough',
    });
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toMatch(/Choose a OpenAI model/);
    expect(String(res.body.message)).toContain('gpt-6.1-sol');
  });

  it('requires a model for OpenRouter', async () => {
    const client = await signedIn();
    const res = await client.request('POST', '/api/byok', {
      providerId: 'openrouter',
      apiKey: 'sk-or-something-long',
    });
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toMatch(/Choose a OpenRouter model/);
  });

  it('does not require a model for Anthropic', async () => {
    const client = await signedIn();
    const res = await client.request('POST', '/api/byok', {
      providerId: 'anthropic',
      apiKey: 'sk-ant-invalid-but-well-formed',
    });
    // It gets past validation-of-input and fails at the provider instead,
    // which is the behaviour under test.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('byok_failed');
  });

  it('reports the connected provider and model without echoing the key', async () => {
    const client = await signedIn();
    const reg = await client.request('GET', '/api/auth/session');
    const userId = String((reg.body.user as { id: string }).id);

    const secret = 'sk-or-v1-super-secret-value';
    storeKey(userId, 'openrouter', secret, 'anthropic/claude-sonnet-4.5');

    const res = await client.request('GET', '/api/byok');
    expect(res.body.connected).toBe(true);
    expect(res.body.providerId).toBe('openrouter');
    expect(res.body.model).toBe('anthropic/claude-sonnet-4.5');
    expect(JSON.stringify(res.body)).not.toContain(secret);
  });
});

/**
 * Provider error mapping.
 *
 * These matter because they are the words a user reads when something goes
 * wrong. A 402 in particular is fully actionable — "top up here" — and
 * reporting it as a generic failure wastes the user's time.
 */
describe('provider error messages', () => {
  function apiError(status: number, message = 'boom', code: string | null = null) {
    return new APIError(status, { error: { message, code } }, message, new Headers());
  }

  it('turns a 402 into a top-up instruction naming the billing page', () => {
    const err = __testTranslateError(apiError(402, 'Insufficient credits'), PROVIDERS.openrouter);
    expect(err.message).toMatch(/out of credit/i);
    expect(err.message).toContain('https://openrouter.ai/credits');
    // Not retryable: retrying without topping up just fails again.
    expect(err.retryable).toBe(false);
  });

  it('points OpenAI users at the OpenAI billing page instead', () => {
    const err = __testTranslateError(apiError(402), PROVIDERS.openai);
    expect(err.message).toContain('platform.openai.com');
    expect(err.message).not.toContain('openrouter');
  });

  it('makes clear the charge is the provider’s, not ours', () => {
    const err = __testTranslateError(apiError(402), PROVIDERS.openrouter);
    expect(err.message).toMatch(/VoiceQuery does not bill you/i);
  });

  it('treats OpenAI insufficient_quota (a 429) as out of credit, not a rate limit', () => {
    const err = __testTranslateError(
      new RateLimitError(
        429,
        { error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } },
        'You exceeded your current quota',
        new Headers(),
      ),
      PROVIDERS.openai,
    );
    expect(err.message).toMatch(/out of credit/i);
    expect(err.retryable).toBe(false);
  });

  it('still treats a genuine rate limit as retryable', () => {
    const err = __testTranslateError(
      new RateLimitError(429, { error: { message: 'Slow down' } }, 'Slow down', new Headers()),
      PROVIDERS.openrouter,
    );
    expect(err.message).toMatch(/rate limiting/i);
    expect(err.retryable).toBe(true);
  });

  it('names the offending model on a 404', () => {
    const err = __testTranslateError(apiError(404), PROVIDERS.openrouter, 'vendor/typo-model');
    expect(err.message).toContain('vendor/typo-model');
    expect(err.message).toMatch(/Check the model id/i);
  });

  it('marks a model outage as retryable and suggests switching', () => {
    const err = __testTranslateError(apiError(502), PROVIDERS.openrouter);
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/different model/i);
  });

  it('reports a rejected key distinctly from an empty balance', () => {
    const err = __testTranslateError(
      new AuthenticationError(401, { error: { message: 'bad key' } }, 'bad key', new Headers()),
      PROVIDERS.openrouter,
    );
    expect(err.message).toMatch(/rejected by OpenRouter/);
    expect(err.message).not.toMatch(/out of credit/i);
  });
});
