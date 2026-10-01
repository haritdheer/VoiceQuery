import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';

/**
 * What happens when the *operator's* key is the thing that is broken.
 *
 * This is its own file because it mocks the provider registry, and vi.mock is
 * hoisted per module graph — mixing it into the shared suite would change
 * which provider every other test resolves.
 *
 * The distinction being tested: a user's own key failing is their problem to
 * fix and the message says so. The shared key failing is the operator's
 * problem, the user can do nothing about it, and they must not be charged for
 * a question that never got answered.
 */

const generateSqlPlan = vi.fn();

vi.mock('../src/ai/registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ai/registry.ts')>();
  return {
    ...actual,
    resolveProvider: () => ({
      provider: {
        id: 'anthropic',
        simulated: false,
        generateSqlPlan,
        explain: vi.fn(),
      },
      mode: 'platform' as const,
      // The platform path is the only one that spends a credit, which is what
      // makes the refund assertion below meaningful.
      consumesCredit: true,
    }),
  };
});

const { createTestContext, TestClient, uniqueEmail, SAMPLE_DATASET_ID } = await import(
  './helpers.ts'
);
const { ProviderError } = await import('../src/ai/provider.ts');

let ctx: Awaited<ReturnType<typeof createTestContext>>;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

describe('the operator’s own key is unusable', () => {
  /** Covers a revoked key, an expired one, and an exhausted quota alike. */
  const authFailure = () =>
    generateSqlPlan.mockRejectedValue(
      new ProviderError('The API key was rejected by Anthropic.', 'auth'),
    );

  it('answers 503 with a code the client can act on', async () => {
    authFailure();
    const client = new TestClient(ctx.app);
    await client.register(uniqueEmail());

    const res = await client.request('POST', '/api/analyze', {
      datasetId: SAMPLE_DATASET_ID,
      question: 'Which products generated the most revenue?',
      idempotencyKey: `k-${Date.now()}`,
    });

    // 503, not 502: the upstream answered, it refused us — and it is the
    // operator's problem to fix, so it should read that way in monitoring.
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('platform_unavailable');
  });

  it('does not charge the user for a question it never answered', async () => {
    authFailure();
    const client = new TestClient(ctx.app);
    const registered = await client.register(uniqueEmail());
    const before = Number(registered.body.credits);
    expect(before).toBeGreaterThan(0);

    const res = await client.request('POST', '/api/analyze', {
      datasetId: SAMPLE_DATASET_ID,
      question: 'Which products generated the most revenue?',
      idempotencyKey: `k-${Date.now()}-refund`,
    });

    // The balance the server reports back with the failure is the
    // authoritative one — the reservation was taken and then given back.
    const details = res.body.details as { creditsRemaining: number };
    expect(details.creditsRemaining).toBe(before);
  });

  it('does not leak the provider’s raw message, which may name the key', async () => {
    authFailure();
    const client = new TestClient(ctx.app);
    await client.register(uniqueEmail());

    const res = await client.request('POST', '/api/analyze', {
      datasetId: SAMPLE_DATASET_ID,
      question: 'Which products generated the most revenue?',
      idempotencyKey: `k-${Date.now()}-msg`,
    });

    const message = String(res.body.message);
    expect(message).toMatch(/shared API key/i);
    expect(message).toMatch(/not been charged/i);
    // The operator's provider is not the user's business.
    expect(message).not.toMatch(/Anthropic/i);
  });

  it('still reports a non-auth provider failure as a plain provider error', async () => {
    generateSqlPlan.mockRejectedValue(
      new ProviderError('Anthropic timed out.', 'timeout', true),
    );
    const client = new TestClient(ctx.app);
    await client.register(uniqueEmail());

    const res = await client.request('POST', '/api/analyze', {
      datasetId: SAMPLE_DATASET_ID,
      question: 'Which products generated the most revenue?',
      idempotencyKey: `k-${Date.now()}-timeout`,
    });

    // A timeout is worth retrying, so it must not send the user off to the
    // key form as though their account were the problem.
    expect(res.status).toBe(502);
    expect(res.body.code).toBeUndefined();
  });
});
