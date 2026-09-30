import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestContext,
  TestClient,
  uniqueEmail,
  SAMPLE_DATASET_ID,
  type TestContext,
} from './helpers.ts';
import { runAnalyticalQuery, QueryExecutionError } from '../src/analytics/duckdb.ts';
import { loadDataset } from '../src/datasets/store.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

async function sampleStoragePath(userId: string): Promise<string> {
  const ds = await loadDataset(ctx.db, SAMPLE_DATASET_ID, userId);
  if (!ds) throw new Error('sample dataset missing');
  return ds.storagePath;
}

async function makeUserId(): Promise<string> {
  const c = new TestClient(ctx.app);
  const res = await c.register(uniqueEmail());
  return String((res.body.user as { id: string }).id);
}

describe('sample dataset', () => {
  it('spans multiple months and regions so follow-ups are meaningful', async () => {
    const userId = await makeUserId();
    const path = await sampleStoragePath(userId);

    const months = await runAnalyticalQuery({
      storagePath: path,
      sql: "SELECT DISTINCT date_trunc('month', order_date) AS m FROM t ORDER BY m",
      maxRows: 100,
    });
    expect(months.rows.length).toBeGreaterThanOrEqual(6);

    const regions = await runAnalyticalQuery({
      storagePath: path,
      sql: 'SELECT DISTINCT region FROM t',
      maxRows: 100,
    });
    expect(regions.rows.length).toBe(4);
  });
});

describe('sandboxed execution', () => {
  /**
   * These assert the *engine-level* layer rather than the parser: even a
   * query that somehow bypassed sqlGuard must still be refused by DuckDB,
   * because the instance is opened read-only with external access disabled
   * and the configuration locked.
   */
  it.each([
    ['reads a local file', "SELECT * FROM read_csv_auto('package.json')"],
    ['globs the filesystem', "SELECT * FROM glob('*')"],
    ['re-enables external access', 'SET enable_external_access=true'],
    ['installs an extension', 'INSTALL httpfs'],
    ['attaches another database', "ATTACH 'other.duckdb' AS other"],
    ['writes a table', 'CREATE TABLE evil (a INT)'],
    ['copies data out', "COPY (SELECT 1) TO 'leak.csv'"],
  ])('the engine itself refuses to %s', async (_name, sql) => {
    const userId = await makeUserId();
    const path = await sampleStoragePath(userId);
    await expect(
      runAnalyticalQuery({ storagePath: path, sql, maxRows: 10 }),
    ).rejects.toBeInstanceOf(QueryExecutionError);
  });

  it('refuses a stacked statement at the engine level too', async () => {
    const userId = await makeUserId();
    const path = await sampleStoragePath(userId);
    await expect(
      runAnalyticalQuery({ storagePath: path, sql: 'SELECT 1; SELECT 2', maxRows: 10 }),
    ).rejects.toThrow(/single statement/i);
  });
});

describe('result bounding', () => {
  it('caps delivered rows without truncating the aggregate', async () => {
    const userId = await makeUserId();
    const path = await sampleStoragePath(userId);

    // Total revenue computed over the whole table.
    const total = await runAnalyticalQuery({
      storagePath: path,
      sql: 'SELECT SUM(revenue) AS total FROM t',
      maxRows: 10,
    });
    const expected = Number((total.rows[0] as { total: number }).total);

    // The same total, requested alongside far more rows than the cap allows.
    const capped = await runAnalyticalQuery({
      storagePath: path,
      sql: 'SELECT order_date, revenue, SUM(revenue) OVER () AS total FROM t',
      maxRows: 5,
    });

    expect(capped.rows.length).toBe(5);
    expect(capped.truncated).toBe(true);
    // totalRows reports the true size, not the delivered size.
    expect(capped.totalRows).toBeGreaterThan(5);
    // And the window aggregate still saw every row.
    expect(Number((capped.rows[0] as { total: number }).total)).toBeCloseTo(expected, 2);
  });

  it('does not mark a small result as truncated', async () => {
    const userId = await makeUserId();
    const path = await sampleStoragePath(userId);
    const res = await runAnalyticalQuery({
      storagePath: path,
      sql: 'SELECT region, SUM(revenue) r FROM t GROUP BY region',
      maxRows: 500,
    });
    expect(res.truncated).toBe(false);
    expect(res.totalRows).toBe(res.rows.length);
    expect(res.rows.length).toBe(4);
  });
});

describe('analysis endpoint', () => {
  it('returns an answer, chart, result and SQL with measured stage timings', async () => {
    const client = new TestClient(ctx.app);
    await client.register(uniqueEmail());

    const res = await client.request('POST', '/api/analyze', {
      datasetId: SAMPLE_DATASET_ID,
      question: 'Which products generated the most revenue?',
    });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('answered');
    expect(res.body.sql).toMatch(/^SELECT/i);
    expect(String(res.body.answer).length).toBeGreaterThan(10);

    const result = res.body.result as { rows: unknown[]; columns: string[] };
    expect(result.rows.length).toBeGreaterThan(0);

    const chart = res.body.chart as { kind: string; xKey: string; yKeys: string[] } | null;
    expect(chart).not.toBeNull();
    // The chart must reference columns that actually exist in the result.
    expect(result.columns).toContain(chart!.xKey);
    for (const key of chart!.yKeys) expect(result.columns).toContain(key);

    const timings = res.body.timings as { stage: string; ms: number }[];
    const stages = timings.map((t) => t.stage);
    expect(stages).toContain('understanding');
    expect(stages).toContain('generating_sql');
    expect(stages).toContain('running_query');
    expect(stages).toContain('preparing_answer');
    // Timings are measured, not fabricated.
    for (const t of timings) expect(t.ms).toBeGreaterThanOrEqual(0);
    expect(res.body.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('labels demo-mode responses as simulated', async () => {
    const client = new TestClient(ctx.app);
    await client.register(uniqueEmail());
    const res = await client.request('POST', '/api/analyze', {
      datasetId: SAMPLE_DATASET_ID,
      question: 'Revenue by region',
    });
    // With no ANTHROPIC_API_KEY configured in tests, the offline provider
    // answers — and it must say so.
    expect(res.body.simulated).toBe(true);
    expect(res.body.aiMode).toBe('demo');
  });

  it('keeps a follow-up on the same dataset and conversation', async () => {
    const client = new TestClient(ctx.app);
    await client.register(uniqueEmail());

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
    // The follow-up resolved the month reference into a real filter.
    expect(String(follow.body.sql)).toMatch(/month|september|09/i);

    const detail = await client.request('GET', `/api/conversations/${conversationId}`);
    const conv = detail.body.conversation as { messages: unknown[]; datasetId: string };
    expect(conv.messages.length).toBe(2);
    expect(conv.datasetId).toBe(SAMPLE_DATASET_ID);
  });

  it('rejects an empty question', async () => {
    const client = new TestClient(ctx.app);
    await client.register(uniqueEmail());
    const res = await client.request('POST', '/api/analyze', {
      datasetId: SAMPLE_DATASET_ID,
      question: '',
    });
    expect(res.status).toBe(400);
  });
});

describe('uploaded dataset analysis', () => {
  it('answers questions about an uploaded CSV', async () => {
    const client = new TestClient(ctx.app);
    await client.register(uniqueEmail());

    const csv = [
      'sale_date,item,units,price',
      '2024-01-05,Alpha,3,10.00',
      '2024-01-06,Beta,7,20.00',
      '2024-02-05,Alpha,5,10.00',
      '2024-02-06,Beta,2,20.00',
    ].join('\n');

    const upload = await client.uploadCsv(csv, 'sales.csv');
    expect(upload.status).toBe(201);
    const dataset = upload.body.dataset as { id: string; rowCount: number };
    expect(dataset.rowCount).toBe(4);

    const res = await client.request('POST', '/api/analyze', {
      datasetId: dataset.id,
      question: 'total units by item',
    });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('answered');
    const result = res.body.result as { rows: Record<string, unknown>[] };
    expect(result.rows.length).toBe(2);
  });

  it('reports a malformed upload with an actionable message', async () => {
    const client = new TestClient(ctx.app);
    await client.register(uniqueEmail());
    const res = await client.uploadCsv('', 'empty.csv');
    expect(res.status).toBe(422);
    expect(String(res.body.message)).toMatch(/empty/i);
  });

  it('rejects a non-CSV file', async () => {
    const client = new TestClient(ctx.app);
    await client.register(uniqueEmail());
    const res = await client.uploadCsv('{"a":1}', 'data.json');
    expect(res.status).toBe(400);
  });
});
