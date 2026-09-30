import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestContext,
  TestClient,
  uniqueEmail,
  SAMPLE_DATASET_ID,
  type TestContext,
} from './helpers.ts';
import { resolveProvider } from '../src/ai/registry.ts';
import { config, resetConfigForTests } from '../src/config/env.ts';
import { storeKey, clearAllKeys } from '../src/byok/keyStore.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

async function startGuest() {
  const client = new TestClient(ctx.app);
  const res = await client.request('POST', '/api/auth/guest');
  client.csrf = String(res.body.csrfToken ?? '');
  return { client, res };
}

describe('guest sessions', () => {
  it('starts without any credentials', async () => {
    const { res } = await startGuest();
    expect(res.status).toBe(200);
    const user = res.body.user as { id: string; email: string | null; isGuest: boolean };
    expect(user.isGuest).toBe(true);
    expect(user.email).toBeNull();
    expect(res.body.csrfToken).toBeTruthy();
  });

  it('reports guest progress and the hard ceiling', async () => {
    const { res } = await startGuest();
    const guest = res.body.guest as { questionsUsed: number; questionsLimit: number };
    expect(guest.questionsUsed).toBe(0);
    expect(guest.questionsLimit).toBe(config().GUEST_QUESTION_LIMIT);
  });

  it('can analyse the sample dataset and counts the answer', async () => {
    const { client } = await startGuest();

    const res = await client.request('POST', '/api/analyze', {
      datasetId: SAMPLE_DATASET_ID,
      question: 'Which products generated the most revenue?',
    });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('answered');
    // Always the demo provider, always labelled.
    expect(res.body.simulated).toBe(true);
    expect(res.body.aiMode).toBe('demo');
    expect(res.body.creditConsumed).toBe(false);

    const state = await client.request('GET', '/api/auth/session');
    expect((state.body.guest as { questionsUsed: number }).questionsUsed).toBe(1);
  });

  it('supports follow-up questions in the same conversation', async () => {
    const { client } = await startGuest();
    const first = await client.request('POST', '/api/analyze', {
      datasetId: SAMPLE_DATASET_ID,
      question: 'Revenue by region',
    });
    const conversationId = String(first.body.conversationId);

    const follow = await client.request('POST', '/api/analyze', {
      datasetId: SAMPLE_DATASET_ID,
      question: 'Now show only September',
      conversationId,
    });
    expect(follow.status).toBe(200);
    expect(follow.body.conversationId).toBe(conversationId);
  });

  it('never gives a guest a credit balance', async () => {
    const { client } = await startGuest();
    const state = await client.request('GET', '/api/auth/session');
    expect(state.body.credits).toBe(0);
    expect(state.body.creditsApply).toBe(false);
    expect(state.body.freeGrantIssued).toBe(false);
  });
});

/**
 * The cost boundary. An anonymous visitor must never reach a paid provider,
 * otherwise the demo becomes a way to spend the operator's AI budget.
 */
describe('guests cannot reach a paid provider', () => {
  it('resolves to the demo provider even when a platform key is configured', () => {
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-pretend-platform-key';
    resetConfigForTests();

    try {
      const asUser = resolveProvider('some-user-id');
      expect(asUser.mode).toBe('platform');

      const asGuest = resolveProvider('some-guest-id', { isGuest: true });
      expect(asGuest.mode).toBe('demo');
      expect(asGuest.consumesCredit).toBe(false);
      expect(asGuest.provider.simulated).toBe(true);
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = original;
      resetConfigForTests();
    }
  });

  it('ignores a BYOK key that somehow got attached to a guest scope', () => {
    storeKey('guest-scope', 'anthropic', 'sk-ant-should-not-be-used');
    try {
      const resolved = resolveProvider('guest-scope', { isGuest: true });
      expect(resolved.mode).toBe('demo');
    } finally {
      clearAllKeys();
    }
  });
});

describe('guest restrictions', () => {
  const CSV = 'date,product,amount\n2024-01-05,Widget,120\n';

  it('refuses CSV upload with a clear reason', async () => {
    const { client } = await startGuest();
    const res = await client.uploadCsv(CSV, 'mine.csv');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('account_required');
    expect(String(res.body.message)).toMatch(/upload your own data/);
  });

  it('refuses to connect a BYOK key', async () => {
    const { client } = await startGuest();
    const res = await client.request('POST', '/api/byok', {
      providerId: 'anthropic',
      apiKey: 'sk-ant-something',
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('account_required');
  });

  it('refuses to start a checkout', async () => {
    const { client } = await startGuest();
    const res = await client.request('POST', '/api/billing/checkout', { packageId: 'pack20' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('account_required');
  });

  it('cannot read another user’s dataset', async () => {
    const owner = new TestClient(ctx.app);
    await owner.register(uniqueEmail());
    const upload = await owner.uploadCsv(CSV, 'private.csv');
    const datasetId = String((upload.body.dataset as { id: string }).id);

    const { client } = await startGuest();
    expect((await client.request('GET', `/api/datasets/${datasetId}`)).status).toBe(404);
    expect(
      (await client.request('POST', '/api/analyze', { datasetId, question: 'totals' })).status,
    ).toBe(404);
  });

  it('only sees the sample dataset in its list', async () => {
    const { client } = await startGuest();
    const list = await client.request('GET', '/api/datasets');
    const datasets = list.body.datasets as { id: string; kind: string }[];
    expect(datasets.length).toBeGreaterThan(0);
    expect(datasets.every((d) => d.kind === 'sample')).toBe(true);
  });
});

describe('guest hard ceiling', () => {
  it('refuses analysis past the limit and says why', async () => {
    const limit = config().GUEST_QUESTION_LIMIT;
    const { client } = await startGuest();

    // Burn the whole allowance.
    for (let i = 0; i < limit; i++) {
      const res = await client.request('POST', '/api/analyze', {
        datasetId: SAMPLE_DATASET_ID,
        question: `Revenue by region, question ${i}`,
      });
      expect(res.status, `question ${i} should succeed`).toBe(200);
    }

    const blocked = await client.request('POST', '/api/analyze', {
      datasetId: SAMPLE_DATASET_ID,
      question: 'One more please',
    });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('guest_limit');
    expect(String(blocked.body.message)).toMatch(new RegExp(`${limit} questions`));

    // The session reports the exhausted state so the UI can react.
    const state = await client.request('GET', '/api/auth/session');
    const guest = state.body.guest as { questionsUsed: number; exhausted: boolean };
    expect(guest.questionsUsed).toBe(limit);
    expect(guest.exhausted).toBe(true);

    // Reading earlier results still works at the ceiling.
    const conversations = await client.request('GET', '/api/conversations');
    expect(conversations.status).toBe(200);
    expect((conversations.body.conversations as unknown[]).length).toBeGreaterThan(0);
  });
});

describe('guest to account', () => {
  it('registering from a guest session yields a real account with credits', async () => {
    const { client } = await startGuest();
    await client.request('POST', '/api/analyze', {
      datasetId: SAMPLE_DATASET_ID,
      question: 'Revenue by region',
    });

    const registered = await client.register(uniqueEmail());
    expect(registered.status).toBe(200);

    const user = registered.body.user as { isGuest: boolean; email: string | null };
    expect(user.isGuest).toBe(false);
    expect(user.email).toBeTruthy();
    expect(registered.body.credits).toBe(2);
    expect(registered.body.guest).toBeNull();

    // And the account can now do what a guest could not.
    const upload = await client.uploadCsv('a,b\n1,2\n', 'now-allowed.csv');
    expect(upload.status).toBe(201);
  });
});
