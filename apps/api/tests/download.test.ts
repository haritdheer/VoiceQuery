import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestContext, TestClient, uniqueEmail, type TestContext } from './helpers.ts';

/**
 * Exporting a dataset back out as CSV.
 *
 * The uploaded file is parsed and discarded, so this is reconstructed from
 * DuckDB. That means the export is not byte-identical to what was uploaded —
 * it is the data as the engine holds it, which is the point: it shows the
 * shape the generated SQL is written against.
 */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

const parse = (csv: string) =>
  csv
    .trim()
    .split('\n')
    .map((line) => line.trim());

describe('dataset download', () => {
  it('returns the rows as CSV with an attachment filename', async () => {
    const client = new TestClient(ctx.app);
    await client.register(uniqueEmail());
    const upload = await client.uploadCsv(
      'date,product,amount\n2024-01-05,Widget,120\n2024-02-06,Gadget,240\n',
      'my report.csv',
    );
    const id = String((upload.body.dataset as { id: string }).id);

    const res = await client.request('GET', `/api/datasets/${id}/download`);
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toMatch(/text\/csv/);
    // The filename came from user input, so it must be rebuilt rather than
    // echoed — a quote or newline here would be header injection.
    expect(String(res.headers['content-disposition'])).toBe(
      'attachment; filename="my-report.csv"',
    );

    const lines = parse(res.text);
    expect(lines[0]).toBe('date,product,amount');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('2024-01-05,Widget,120');
  });

  it('round-trips: the export re-uploads to the same schema', async () => {
    const client = new TestClient(ctx.app);
    await client.register(uniqueEmail());
    const original = await client.uploadCsv(
      'Order Date,Product,Amount\n2024-01-05,Widget,$1,200.50\n2024-02-06,Gadget,$980.00\n',
      'original.csv',
    );
    const firstId = String((original.body.dataset as { id: string }).id);

    const exported = await client.request('GET', `/api/datasets/${firstId}/download`);
    const reupload = await client.uploadCsv(exported.text, 'round-trip.csv');
    expect(reupload.status).toBe(201);

    const before = original.body.dataset as { columns: { name: string; type: string }[] };
    const after = reupload.body.dataset as { columns: { name: string; type: string }[] };
    expect(after.columns.map((c) => [c.name, c.type])).toEqual(
      before.columns.map((c) => [c.name, c.type]),
    );
  });

  it('quotes fields that would otherwise break the row', async () => {
    const client = new TestClient(ctx.app);
    await client.register(uniqueEmail());
    const upload = await client.uploadCsv(
      'label,note\n' +
        'comma,"a, b"\n' +
        'quote,"she said ""hi"""\n' +
        'plain,ok\n',
      'tricky.csv',
    );
    const id = String((upload.body.dataset as { id: string }).id);

    const res = await client.request('GET', `/api/datasets/${id}/download`);
    const body = res.text;
    expect(body).toContain('comma,"a, b"');
    expect(body).toContain('quote,"she said ""hi"""');
    // A value needing no escaping must not be quoted gratuitously.
    expect(body).toContain('plain,ok');
  });

  it('lets anyone signed in download the shared sample', async () => {
    const client = new TestClient(ctx.app);
    await client.register(uniqueEmail());

    const res = await client.request('GET', '/api/datasets/sample-sales/download');
    expect(res.status).toBe(200);
    expect(parse(res.text)[0]).toBe('order_date,product,category,region,channel,quantity,unit_price,revenue');
  });

  it('refuses another user’s dataset without revealing it exists', async () => {
    const alice = new TestClient(ctx.app);
    await alice.register(uniqueEmail());
    const upload = await alice.uploadCsv('a,b\n1,2\n', 'alice.csv');
    const id = String((upload.body.dataset as { id: string }).id);

    const bob = new TestClient(ctx.app);
    await bob.register(uniqueEmail());
    const res = await bob.request('GET', `/api/datasets/${id}/download`);

    // 404, not 403: a 403 would confirm the dataset is real.
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('1,2');
  });

  it('refuses an anonymous request', async () => {
    const res = await new TestClient(ctx.app).request(
      'GET',
      '/api/datasets/sample-sales/download',
    );
    expect(res.status).toBe(401);
  });
});
