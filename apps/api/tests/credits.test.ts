import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, TestClient, uniqueEmail, SAMPLE_DATASET_ID, type TestContext } from './helpers.ts';
import {
  createAccountWithFreeGrant,
  getBalance,
  InsufficientCreditsError,
  reconcile,
  refundCredit,
  reserveCredit,
  commitCredit,
} from '../src/credits/ledger.ts';
import { storeKey, clearAllKeys } from '../src/byok/keyStore.ts';
import { resolveProvider } from '../src/ai/registry.ts';
import { resetConfigForTests } from '../src/config/env.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

async function makeUser(): Promise<string> {
  const client = new TestClient(ctx.app);
  const res = await client.register(uniqueEmail());
  expect(res.status).toBe(200);
  return String((res.body.user as { id: string }).id);
}

describe('free grant', () => {
  it('gives exactly two credits on account creation', async () => {
    const client = new TestClient(ctx.app);
    const res = await client.register(uniqueEmail());
    expect(res.body.credits).toBe(2);
    expect(res.body.freeGrantIssued).toBe(true);
  });

  it('issues the grant only once even if the grant call repeats', async () => {
    const userId = await makeUser();
    await ctx.db.transaction((tx) => createAccountWithFreeGrant(tx, userId));
    await ctx.db.transaction((tx) => createAccountWithFreeGrant(tx, userId));
    expect(await getBalance(ctx.db, userId)).toBe(2);
  });

  it('does not re-grant on a later login', async () => {
    const email = uniqueEmail();
    const client = new TestClient(ctx.app);
    await client.register(email);
    const again = new TestClient(ctx.app);
    const res = await again.login(email);
    expect(res.body.credits).toBe(2);
  });
});

describe('reserve / commit / refund', () => {
  it('deducts one credit per reservation', async () => {
    const userId = await makeUser();
    const r = await reserveCredit(ctx.db, userId, 'key-a');
    expect(r.balanceAfter).toBe(1);
    expect(r.replayed).toBe(false);
    await commitCredit(ctx.db, userId, r.ledgerId);
    expect(await getBalance(ctx.db, userId)).toBe(1);
  });

  it('restores the credit when the analysis fails', async () => {
    const userId = await makeUser();
    const r = await reserveCredit(ctx.db, userId, 'key-b');
    expect(await getBalance(ctx.db, userId)).toBe(1);
    const after = await refundCredit(ctx.db, userId, r.ledgerId, 'provider error');
    expect(after).toBe(2);
  });

  it('refunds at most once per reservation', async () => {
    const userId = await makeUser();
    const r = await reserveCredit(ctx.db, userId, 'key-c');
    await refundCredit(ctx.db, userId, r.ledgerId, 'first');
    await refundCredit(ctx.db, userId, r.ledgerId, 'second');
    await refundCredit(ctx.db, userId, r.ledgerId, 'third');
    expect(await getBalance(ctx.db, userId)).toBe(2);
  });

  it('does not refund a committed reservation', async () => {
    const userId = await makeUser();
    const r = await reserveCredit(ctx.db, userId, 'key-d');
    await commitCredit(ctx.db, userId, r.ledgerId);
    await refundCredit(ctx.db, userId, r.ledgerId, 'too late');
    expect(await getBalance(ctx.db, userId)).toBe(1);
  });

  it('refuses to go below zero', async () => {
    const userId = await makeUser();
    await reserveCredit(ctx.db, userId, 'k1');
    await reserveCredit(ctx.db, userId, 'k2');
    await expect(reserveCredit(ctx.db, userId, 'k3')).rejects.toBeInstanceOf(
      InsufficientCreditsError,
    );
    expect(await getBalance(ctx.db, userId)).toBe(0);
  });

  it('keeps the ledger reconciled with the balance', async () => {
    const userId = await makeUser();
    const a = await reserveCredit(ctx.db, userId, 'r1');
    await commitCredit(ctx.db, userId, a.ledgerId);
    const b = await reserveCredit(ctx.db, userId, 'r2');
    await refundCredit(ctx.db, userId, b.ledgerId, 'failed');
    const state = await reconcile(ctx.db, userId);
    expect(state.consistent).toBe(true);
    expect(state.balance).toBe(1);
  });
});

describe('retry and concurrency protection', () => {
  it('replays an existing reservation for the same idempotency key', async () => {
    const userId = await makeUser();
    const first = await reserveCredit(ctx.db, userId, 'same-key');
    const second = await reserveCredit(ctx.db, userId, 'same-key');
    expect(second.replayed).toBe(true);
    expect(second.ledgerId).toBe(first.ledgerId);
    // One credit spent across both calls, not two.
    expect(await getBalance(ctx.db, userId)).toBe(1);
  });

  /**
   * Note on the driver: PGlite serialises statements on a single connection,
   * so this exercises the balance invariant rather than true lock contention
   * between separate backends. The guarantee under test — that N parallel
   * reservations against a balance of 2 yield exactly 2 successes and never a
   * negative balance — is the property that matters, and it is additionally
   * enforced by the CHECK (balance >= 0) constraint on credit_accounts.
   */
  it('never lets parallel requests exceed the balance', async () => {
    const userId = await makeUser();
    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => reserveCredit(ctx.db, userId, `par-${i}`)),
    );
    const granted = attempts.filter((a) => a.status === 'fulfilled').length;
    expect(granted).toBe(2);
    expect(await getBalance(ctx.db, userId)).toBe(0);
    expect((await reconcile(ctx.db, userId)).consistent).toBe(true);
  });
});

describe('analysis endpoint credit behaviour', () => {
  it('consumes one credit per completed analysis and then blocks with 402', async () => {
    const client = new TestClient(ctx.app);
    const reg = await client.register(uniqueEmail());
    expect(reg.body.credits).toBe(2);

    const first = await client.request('POST', '/api/analyze', {
      datasetId: SAMPLE_DATASET_ID,
      question: 'Which products generated the most revenue?',
    });
    expect(first.status).toBe(200);
    expect(first.body.creditConsumed).toBe(true);
    expect(first.body.creditsRemaining).toBe(1);

    const second = await client.request('POST', '/api/analyze', {
      datasetId: SAMPLE_DATASET_ID,
      question: 'Revenue by region please',
    });
    expect(second.status).toBe(200);
    expect(second.body.creditsRemaining).toBe(0);

    const third = await client.request('POST', '/api/analyze', {
      datasetId: SAMPLE_DATASET_ID,
      question: 'Revenue by channel please',
    });
    expect(third.status).toBe(402);
    expect(third.body.code).toBe('insufficient_credits');
  });

  it('does not double-charge a retried request', async () => {
    const client = new TestClient(ctx.app);
    await client.register(uniqueEmail());
    const key = 'stable-idempotency-key-1';
    const payload = {
      datasetId: SAMPLE_DATASET_ID,
      question: 'Revenue by region',
      idempotencyKey: key,
    };

    const first = await client.request('POST', '/api/analyze', payload);
    const retry = await client.request('POST', '/api/analyze', payload);

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);
    expect(retry.body.creditsRemaining).toBe(1);
  });

  it('leaves earlier results readable after the allowance runs out', async () => {
    const client = new TestClient(ctx.app);
    await client.register(uniqueEmail());
    const run = await client.request('POST', '/api/analyze', {
      datasetId: SAMPLE_DATASET_ID,
      question: 'Revenue by region',
    });
    const conversationId = String(run.body.conversationId);

    await client.request('POST', '/api/analyze', {
      datasetId: SAMPLE_DATASET_ID,
      question: 'Revenue by product',
    });
    const blocked = await client.request('POST', '/api/analyze', {
      datasetId: SAMPLE_DATASET_ID,
      question: 'Revenue by channel',
    });
    expect(blocked.status).toBe(402);

    // Reading history is free and still works at zero balance.
    const history = await client.request('GET', `/api/conversations/${conversationId}`);
    expect(history.status).toBe(200);
    const conv = history.body.conversation as { messages: unknown[] };
    expect(conv.messages.length).toBeGreaterThan(0);

    const credits = await client.request('GET', '/api/credits');
    expect(credits.body.balance).toBe(0);
  });

  it('refunds when the request is for a dataset that does not exist', async () => {
    const client = new TestClient(ctx.app);
    await client.register(uniqueEmail());
    const res = await client.request('POST', '/api/analyze', {
      datasetId: 'does-not-exist',
      question: 'anything',
    });
    expect(res.status).toBe(404);
    const credits = await client.request('GET', '/api/credits');
    expect(credits.body.balance).toBe(2);
  });
});

/**
 * The demo provider runs locally and makes no provider call, so it must not
 * spend an AI credit by default — the same exemption BYOK gets. The operator
 * can opt in to charging so the upgrade flow is demonstrable without
 * credentials, which is what the rest of this suite runs with.
 */
describe('demo mode cost', () => {
  const original = process.env.DEMO_CONSUMES_CREDITS;

  afterEach(() => {
    process.env.DEMO_CONSUMES_CREDITS = original;
    resetConfigForTests();
  });

  it('does not consume a credit by default', () => {
    delete process.env.DEMO_CONSUMES_CREDITS;
    delete process.env.ANTHROPIC_API_KEY;
    resetConfigForTests();

    const resolved = resolveProvider(null);
    expect(resolved.mode).toBe('demo');
    expect(resolved.consumesCredit).toBe(false);
    // Responses stay flagged, so a free answer is still never passed off as
    // a model's output.
    expect(resolved.provider.simulated).toBe(true);
  });

  it('consumes a credit when the operator opts in', () => {
    process.env.DEMO_CONSUMES_CREDITS = 'true';
    delete process.env.ANTHROPIC_API_KEY;
    resetConfigForTests();

    const resolved = resolveProvider(null);
    expect(resolved.mode).toBe('demo');
    expect(resolved.consumesCredit).toBe(true);
  });
});

describe('bring your own key', () => {
  it('does not consume application credits in BYOK mode', async () => {
    const client = new TestClient(ctx.app);
    const reg = await client.register(uniqueEmail());
    const userId = String((reg.body.user as { id: string }).id);

    // Install a key directly so the test does not call a real provider.
    storeKey(userId, 'anthropic', 'sk-ant-test-key-for-unit-tests');

    try {
      const res = await client.request('POST', '/api/analyze', {
        datasetId: SAMPLE_DATASET_ID,
        question: 'Revenue by region',
      });

      // The stub key cannot reach Anthropic, so the analysis fails — but the
      // point under test is that it was never funded by platform credits.
      expect(res.body.creditConsumed ?? false).toBe(false);
      const credits = await client.request('GET', '/api/credits');
      expect(credits.body.balance).toBe(2);
    } finally {
      clearAllKeys();
    }
  });

  it('reports BYOK as the active mode in the session state', async () => {
    const client = new TestClient(ctx.app);
    const reg = await client.register(uniqueEmail());
    const userId = String((reg.body.user as { id: string }).id);
    storeKey(userId, 'anthropic', 'sk-ant-another-test-key');
    try {
      const state = await client.request('GET', '/api/auth/session');
      expect(state.body.aiMode).toBe('byok');
      expect(state.body.byokProvider).toBe('anthropic');
    } finally {
      clearAllKeys();
    }
  });

  it('never returns the stored key back to the client', async () => {
    const client = new TestClient(ctx.app);
    const reg = await client.register(uniqueEmail());
    const userId = String((reg.body.user as { id: string }).id);
    const secret = 'sk-ant-super-secret-value-9999';
    storeKey(userId, 'anthropic', secret);
    try {
      const res = await client.request('GET', '/api/byok');
      const serialised = JSON.stringify(res.body);
      expect(serialised).not.toContain(secret);
      expect(res.body.connected).toBe(true);
      expect(res.body.fingerprint).toBeTruthy();
    } finally {
      clearAllKeys();
    }
  });
});
