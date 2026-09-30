import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestContext,
  TestClient,
  uniqueEmail,
  SAMPLE_DATASET_ID,
  type TestContext,
} from './helpers.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

const CSV = 'date,product,amount\n2024-01-05,Widget,120\n2024-02-06,Gadget,240\n';

describe('authentication', () => {
  it('rejects unauthenticated access to user resources', async () => {
    const anon = new TestClient(ctx.app);
    for (const url of ['/api/credits', '/api/datasets', '/api/conversations', '/api/byok']) {
      const res = await anon.request('GET', url);
      expect(res.status, url).toBe(401);
    }
  });

  it('rejects a mutating request without a CSRF token', async () => {
    const client = new TestClient(ctx.app);
    await client.register(uniqueEmail());
    client.csrf = '';
    const res = await client.request('POST', '/api/analyze', {
      datasetId: SAMPLE_DATASET_ID,
      question: 'anything',
    });
    expect(res.status).toBe(403);
  });

  it('rejects a mutating request with the wrong CSRF token', async () => {
    const client = new TestClient(ctx.app);
    await client.register(uniqueEmail());
    client.csrf = 'not-the-right-token';
    const res = await client.request('POST', '/api/analyze', {
      datasetId: SAMPLE_DATASET_ID,
      question: 'anything',
    });
    expect(res.status).toBe(403);
  });

  it('does not reveal whether an email is registered', async () => {
    const email = uniqueEmail();
    const client = new TestClient(ctx.app);
    await client.register(email);

    const wrongPassword = await new TestClient(ctx.app).login(email, 'wrongpassword123');
    const unknownUser = await new TestClient(ctx.app).login(uniqueEmail(), 'wrongpassword123');

    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.body.message).toBe(unknownUser.body.message);
  });

  it('refuses to register the same email twice', async () => {
    const email = uniqueEmail();
    await new TestClient(ctx.app).register(email);
    const second = await new TestClient(ctx.app).register(email);
    expect(second.status).toBe(409);
  });

  it('rejects a weak password', async () => {
    const res = await new TestClient(ctx.app).register(uniqueEmail(), 'short');
    expect(res.status).toBe(400);
  });
});

describe('cross-user isolation', () => {
  it('hides another user’s dataset, conversation and deletion', async () => {
    const alice = new TestClient(ctx.app);
    await alice.register(uniqueEmail());
    const upload = await alice.uploadCsv(CSV, 'alice-private.csv');
    expect(upload.status).toBe(201);
    const datasetId = String((upload.body.dataset as { id: string }).id);

    const analysis = await alice.request('POST', '/api/analyze', {
      datasetId,
      question: 'total amount by product',
    });
    expect(analysis.status).toBe(200);
    const conversationId = String(analysis.body.conversationId);

    const mallory = new TestClient(ctx.app);
    await mallory.register(uniqueEmail());

    // Every one of these must look exactly like "does not exist".
    expect((await mallory.request('GET', `/api/datasets/${datasetId}`)).status).toBe(404);
    expect((await mallory.request('DELETE', `/api/datasets/${datasetId}`)).status).toBe(404);
    expect((await mallory.request('GET', `/api/conversations/${conversationId}`)).status).toBe(404);
    expect(
      (await mallory.request('POST', '/api/analyze', { datasetId, question: 'steal this' })).status,
    ).toBe(404);

    // And Mallory's own listing must not include it.
    const list = await mallory.request('GET', '/api/datasets');
    const ids = (list.body.datasets as { id: string }[]).map((d) => d.id);
    expect(ids).not.toContain(datasetId);
  });

  it('lets every user read the shared sample dataset', async () => {
    const a = new TestClient(ctx.app);
    await a.register(uniqueEmail());
    const b = new TestClient(ctx.app);
    await b.register(uniqueEmail());

    expect((await a.request('GET', `/api/datasets/${SAMPLE_DATASET_ID}`)).status).toBe(200);
    expect((await b.request('GET', `/api/datasets/${SAMPLE_DATASET_ID}`)).status).toBe(200);
  });

  it('refuses to delete the built-in sample dataset', async () => {
    const client = new TestClient(ctx.app);
    await client.register(uniqueEmail());
    const res = await client.request('DELETE', `/api/datasets/${SAMPLE_DATASET_ID}`);
    expect(res.status).toBe(404);
  });

  it('will not move a conversation onto a different dataset', async () => {
    const client = new TestClient(ctx.app);
    await client.register(uniqueEmail());

    const first = await client.request('POST', '/api/analyze', {
      datasetId: SAMPLE_DATASET_ID,
      question: 'revenue by region',
    });
    expect(first.status).toBe(200);

    const upload = await client.uploadCsv(CSV, 'other.csv');
    const otherId = String((upload.body.dataset as { id: string }).id);

    const hijack = await client.request('POST', '/api/analyze', {
      datasetId: otherId,
      question: 'totals',
      conversationId: String(first.body.conversationId),
    });
    expect(hijack.status).toBe(404);
  });
});

describe('dataset lifecycle', () => {
  it('lets a user delete their own dataset', async () => {
    const client = new TestClient(ctx.app);
    await client.register(uniqueEmail());
    const upload = await client.uploadCsv(CSV, 'temp.csv');
    const id = String((upload.body.dataset as { id: string }).id);

    expect((await client.request('DELETE', `/api/datasets/${id}`)).status).toBe(200);
    expect((await client.request('GET', `/api/datasets/${id}`)).status).toBe(404);
  });

  it('sets an expiry on uploads but not on the sample', async () => {
    const client = new TestClient(ctx.app);
    await client.register(uniqueEmail());
    const upload = await client.uploadCsv(CSV, 'expiring.csv');
    expect((upload.body.dataset as { expiresAt: string | null }).expiresAt).toBeTruthy();

    const sample = await client.request('GET', `/api/datasets/${SAMPLE_DATASET_ID}`);
    expect((sample.body.dataset as { expiresAt: string | null }).expiresAt).toBeNull();
  });

  it('never exposes the server-side storage path', async () => {
    const client = new TestClient(ctx.app);
    await client.register(uniqueEmail());
    const upload = await client.uploadCsv(CSV, 'paths.csv');
    expect(JSON.stringify(upload.body)).not.toContain('storagePath');
    expect(JSON.stringify(upload.body)).not.toContain('.duckdb');

    const detail = await client.request('GET', `/api/datasets/${SAMPLE_DATASET_ID}`);
    expect(JSON.stringify(detail.body)).not.toContain('storagePath');
  });
});
