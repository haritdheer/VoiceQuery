process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
// Each test file runs in its own fork and seeds its own sample dataset, so
// each needs a private data directory — otherwise two workers race to create
// and open the same DuckDB file.
process.env.DATA_DIR = `.test-data/worker-${process.pid}`;
// Pinned so the ledger tests exercise the semantics — reserve, commit,
// refund, the floor at zero — rather than tracking whatever the product's
// grant happens to be. Changing FREE_CREDITS should not churn these.
process.env.FREE_CREDITS = '2';

import { rmSync } from 'node:fs';
import { buildApp } from '../src/app.ts';
import { createDb, type Db } from '../src/db/client.ts';
import { closeAllInstances } from '../src/analytics/duckdb.ts';
import { clearAllKeys } from '../src/byok/keyStore.ts';

/**
 * Test harness.
 *
 * The database is PGlite — genuine Postgres compiled to WASM — so these tests
 * run the same SQL, constraints and transaction semantics as production,
 * without needing a Postgres server. The one behavioural difference is noted
 * in the concurrency test.
 */

type TestApp = Awaited<ReturnType<typeof buildApp>>;

export interface TestContext {
  app: TestApp;
  db: Db;
  close: () => Promise<void>;
}

export async function createTestContext(): Promise<TestContext> {
  const db = await createDb();
  const app = await buildApp({ db });
  return {
    app,
    db,
    close: async () => {
      await app.close();
      closeAllInstances();
      clearAllKeys();
      await db.close();
      // Remove this worker's dataset files so repeated runs stay clean.
      rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
    },
  };
}

/** A signed-in browser: carries the session cookie and CSRF token. */
export class TestClient {
  cookie = '';
  csrf = '';

  constructor(private readonly app: TestApp) {}

  private capture(headers: Record<string, unknown>) {
    const raw = headers['set-cookie'];
    if (!raw) return;
    const first = Array.isArray(raw) ? raw[0] : String(raw);
    this.cookie = String(first).split(';')[0] ?? '';
  }

  async request(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ) {
    const res = await this.app.inject({
      method,
      url,
      payload: body as never,
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...extraHeaders,
      },
    });
    this.capture(res.headers as Record<string, unknown>);
    let json: Record<string, unknown> = {};
    try {
      json = res.json() as Record<string, unknown>;
    } catch {
      json = {};
    }
    return { status: res.statusCode, body: json, headers: res.headers };
  }

  async register(email: string, password = 'hunter2hunter2') {
    const res = await this.request('POST', '/api/auth/register', { email, password });
    this.csrf = String(res.body.csrfToken ?? '');
    return res;
  }

  async login(email: string, password = 'hunter2hunter2') {
    const res = await this.request('POST', '/api/auth/login', { email, password });
    this.csrf = String(res.body.csrfToken ?? '');
    return res;
  }

  async uploadCsv(content: string, filename = 'test.csv') {
    const boundary = '----vqtestboundary';
    const payload =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: text/csv\r\n\r\n${content}\r\n--${boundary}--\r\n`;
    const res = await this.app.inject({
      method: 'POST',
      url: '/api/datasets',
      payload,
      headers: {
        cookie: this.cookie,
        'x-csrf-token': this.csrf,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
    });
    let json: Record<string, unknown> = {};
    try {
      json = res.json() as Record<string, unknown>;
    } catch {
      json = {};
    }
    return { status: res.statusCode, body: json };
  }
}

export const SAMPLE_DATASET_ID = 'sample-sales';

let counter = 0;
export const uniqueEmail = () => `user${Date.now()}-${counter++}@test.local`;
