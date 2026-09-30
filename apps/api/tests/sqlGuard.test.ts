import { describe, expect, it } from 'vitest';
import { validateSql, wrapWithRowLimit, wrapWithCount } from '../src/analytics/sqlGuard.ts';

const OPTS = { allowedTables: ['t'] };
const reject = (sql: string) => validateSql(sql, OPTS);
const accept = (sql: string) => validateSql(sql, OPTS);

describe('SQL guard — statement type', () => {
  it.each([
    ['INSERT', "INSERT INTO t VALUES (1)"],
    ['UPDATE', "UPDATE t SET revenue = 0"],
    ['DELETE', "DELETE FROM t"],
    ['CREATE', "CREATE TABLE evil AS SELECT * FROM t"],
    ['DROP', "DROP TABLE t"],
    ['ALTER', "ALTER TABLE t ADD COLUMN x INT"],
    ['TRUNCATE', "TRUNCATE TABLE t"],
  ])('rejects %s', (_name, sql) => {
    expect(reject(sql).ok).toBe(false);
  });

  it('rejects multiple statements', () => {
    const r = reject('SELECT 1 FROM t; DROP TABLE t');
    expect(r.ok).toBe(false);
  });

  it('rejects an empty query', () => {
    expect(reject('   ').ok).toBe(false);
  });

  it('rejects a query over the length limit', () => {
    const r = validateSql(`SELECT ${'a'.repeat(9000)} FROM t`, OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('too_long');
  });
});

describe('SQL guard — engine escape attempts', () => {
  it.each([
    ['ATTACH another database', "ATTACH 'postgres://user:pw@host/appdb' AS appdb"],
    ['INSTALL an extension', 'INSTALL httpfs'],
    ['LOAD an extension', 'LOAD httpfs'],
    ['COPY data out', "COPY (SELECT * FROM t) TO '/tmp/leak.csv'"],
    ['EXPORT the database', "EXPORT DATABASE '/tmp/dump'"],
    ['PRAGMA', 'PRAGMA database_list'],
  ])('rejects %s', (_name, sql) => {
    expect(reject(sql).ok).toBe(false);
  });
});

/**
 * The central case from the brief: a statement can be a perfectly valid
 * SELECT and still be dangerous. Keyword filtering alone would pass every
 * query in this block.
 */
describe('SQL guard — dangerous functions inside a valid SELECT', () => {
  it.each([
    ['read_csv_auto in FROM', "SELECT * FROM read_csv_auto('/etc/passwd')"],
    ['read_parquet in FROM', "SELECT * FROM read_parquet('s3://bucket/secret.parquet')"],
    ['read_json in FROM', "SELECT * FROM read_json('/etc/shadow')"],
    ['glob in FROM', "SELECT * FROM glob('/**/*')"],
    ['duckdb_settings catalog fn', 'SELECT * FROM duckdb_settings()'],
    ['read_text in projection', "SELECT read_text('/etc/passwd') FROM t"],
    ['read_blob in projection', "SELECT read_blob('/etc/passwd') FROM t"],
    ['getvariable in projection', "SELECT getvariable('secret') FROM t"],
    ['current_setting in projection', "SELECT current_setting('x') FROM t"],
    ['nextval side effect', "SELECT nextval('s') FROM t"],
    ['hidden in CASE', "SELECT CASE WHEN 1=1 THEN read_text('/etc/passwd') ELSE 'x' END FROM t"],
    ['hidden in WHERE', "SELECT * FROM t WHERE read_text('/etc/passwd') = 'root'"],
    ['hidden in GROUP BY', "SELECT COUNT(*) FROM t GROUP BY read_text('/x')"],
    ['hidden in ORDER BY', "SELECT * FROM t ORDER BY read_text('/x')"],
    ['hidden in HAVING', "SELECT region FROM t GROUP BY region HAVING read_text('/x') = '1'"],
    ['hidden in a window', "SELECT RANK() OVER (ORDER BY read_text('/x')) FROM t"],
    ['hidden in a CTE body', "WITH c AS (SELECT read_text('/x') v FROM t) SELECT * FROM c"],
    ['hidden in a derived table', "SELECT * FROM (SELECT read_text('/x') v FROM t) s"],
    ['hidden in a UNION arm', "SELECT region FROM t UNION SELECT read_text('/x') FROM t"],
    ['schema-qualified function', "SELECT main.read_text('/x') FROM t"],
  ])('rejects %s', (_name, sql) => {
    const r = reject(sql);
    expect(r.ok, `expected rejection for: ${sql}`).toBe(false);
  });
});

describe('SQL guard — table access control', () => {
  it.each([
    ['the users table', 'SELECT * FROM users'],
    ['the credit ledger', 'SELECT * FROM credit_ledger'],
    ['the sessions table', 'SELECT * FROM sessions'],
    ['a postgres catalog', 'SELECT * FROM pg_tables'],
    ['a qualified catalog reference', 'SELECT * FROM appdb.users'],
    ['another table via subquery', 'SELECT * FROM t WHERE id IN (SELECT id FROM users)'],
    ['another table via scalar subquery', 'SELECT (SELECT max(id) FROM sessions) FROM t'],
    ['another table via CTE', 'WITH x AS (SELECT * FROM users) SELECT * FROM x'],
    ['another table via UNION', 'SELECT region FROM t UNION SELECT email FROM users'],
    ['another table via EXCEPT', 'SELECT region FROM t EXCEPT SELECT email FROM users'],
    ['another table via INTERSECT', 'SELECT region FROM t INTERSECT SELECT email FROM users'],
    ['another table via a join', 'SELECT * FROM t JOIN users u ON u.id = t.region'],
  ])('rejects access to %s', (_name, sql) => {
    const r = reject(sql);
    expect(r.ok, `expected rejection for: ${sql}`).toBe(false);
  });
});

describe('SQL guard — legitimate analytical queries', () => {
  it.each([
    ['simple aggregate', 'SELECT product, SUM(revenue) AS total FROM t GROUP BY product'],
    [
      'ranking with limit',
      'SELECT product, SUM(revenue) AS total FROM t GROUP BY product ORDER BY total DESC LIMIT 10',
    ],
    [
      'time series',
      "SELECT date_trunc('month', order_date) AS m, SUM(revenue) AS r FROM t GROUP BY 1 ORDER BY 1",
    ],
    ['filtered', "SELECT SUM(revenue) AS r FROM t WHERE region = 'West'"],
    ['distinct', 'SELECT DISTINCT region FROM t'],
    ['window function', 'SELECT product, RANK() OVER (ORDER BY revenue DESC) AS rk FROM t'],
    [
      'CTE',
      "WITH m AS (SELECT date_trunc('month', order_date) p, SUM(revenue) r FROM t GROUP BY 1) SELECT * FROM m ORDER BY p",
    ],
    [
      'derived table',
      'SELECT * FROM (SELECT product, SUM(revenue) r FROM t GROUP BY product) s WHERE r > 1000',
    ],
    ['self join with alias', 'SELECT a.product, SUM(a.revenue) FROM t a GROUP BY a.product'],
    [
      'percentage of total',
      'SELECT region, SUM(revenue) r, ROUND(100.0 * SUM(revenue) / (SELECT SUM(revenue) FROM t), 2) pct FROM t GROUP BY region',
    ],
    [
      'CASE bucketing',
      "SELECT CASE WHEN revenue > 100 THEN 'high' ELSE 'low' END AS band, COUNT(*) c FROM t GROUP BY 1",
    ],
    ['HAVING', 'SELECT product, SUM(revenue) r FROM t GROUP BY product HAVING SUM(revenue) > 500'],
    ['UNION over the same table', "SELECT product FROM t WHERE region='A' UNION SELECT product FROM t WHERE region='B'"],
    ['cast and coalesce', 'SELECT COALESCE(CAST(quantity AS DOUBLE), 0) AS q FROM t'],
    ['string functions', 'SELECT UPPER(product) AS p, LENGTH(product) AS n FROM t'],
  ])('accepts %s', (_name, sql) => {
    const r = accept(sql);
    expect(r.ok, `expected acceptance, got: ${r.ok ? '' : r.reason}`).toBe(true);
  });

  it('reports the tables and functions it saw', () => {
    const r = accept('SELECT product, SUM(revenue) AS total FROM t GROUP BY product');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tables).toContain('t');
      expect(r.functions).toContain('sum');
    }
  });

  it('strips a trailing semicolon rather than failing on it', () => {
    expect(accept('SELECT COUNT(*) FROM t;').ok).toBe(true);
  });
});

describe('SQL guard — result bounding', () => {
  it('wraps the query so aggregates are not truncated', () => {
    const inner = 'SELECT region, SUM(revenue) r FROM t GROUP BY region';
    const wrapped = wrapWithRowLimit(inner, 100);
    // The original query is nested whole: the SUM still runs over every row,
    // and only the delivered rows are capped.
    expect(wrapped).toContain(`(${inner})`);
    expect(wrapped).toMatch(/LIMIT 101$/);
  });

  it('counts the true result size separately', () => {
    expect(wrapWithCount('SELECT 1 FROM t')).toContain('COUNT(*)');
  });
});
