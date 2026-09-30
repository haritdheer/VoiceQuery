// node-sql-parser ships CommonJS; the named export is only reachable through
// the default interop object under Node's ESM loader.
import sqlParserPkg from 'node-sql-parser';

const { Parser } = sqlParserPkg;

/**
 * Validation gate for model-generated SQL.
 *
 * Design stance: this is an **allowlist**, not a blacklist. The AST is walked
 * in full and anything not explicitly recognised is rejected. Keyword or regex
 * scanning alone is not sufficient — a perfectly ordinary-looking
 * `SELECT * FROM read_csv_auto('/etc/passwd')` is a SELECT with no forbidden
 * keyword in it, and `SELECT getvariable('x')` hides a function call in the
 * projection. Both are caught here by structure, not by spelling.
 *
 * This is the first of two independent layers. The second is engine-level
 * lockdown in duckdb.ts (`enable_external_access=false` then
 * `lock_configuration=true`), which holds even if this parser is ever fooled.
 */

export type GuardFailureCode =
  | 'empty'
  | 'too_long'
  | 'parse_error'
  | 'multiple_statements'
  | 'not_a_select'
  | 'forbidden_keyword'
  | 'forbidden_function'
  | 'forbidden_table'
  | 'table_function'
  | 'forbidden_syntax';

export type GuardResult =
  | { ok: true; sql: string; tables: string[]; functions: string[] }
  | { ok: false; code: GuardFailureCode; reason: string };

export interface GuardOptions {
  /** Physical table names this query may read. Backend-generated, never from the client. */
  allowedTables: string[];
  maxLength?: number;
}

/**
 * Read-only analytical functions the generator may use.
 *
 * Deliberately excluded, and why:
 *   read_csv / read_parquet / read_json / read_text / read_blob  — file access
 *   glob / parquet_scan / delta_scan / iceberg_scan              — file access
 *   duckdb_* / pragma_* / pg_*                                   — catalog and settings introspection
 *   getvariable / current_setting / setseed                      — session state
 *   nextval / random_uuid-style side effects                     — non-deterministic writes to sequences
 *   httpfs / s3 helpers                                          — network egress
 */
const ALLOWED_FUNCTIONS = new Set(
  [
    // aggregates
    'count', 'sum', 'avg', 'min', 'max', 'median', 'mode', 'stddev', 'stddev_pop',
    'stddev_samp', 'variance', 'var_pop', 'var_samp', 'corr', 'covar_pop', 'covar_samp',
    'quantile', 'quantile_cont', 'quantile_disc', 'approx_count_distinct', 'product',
    'bool_and', 'bool_or', 'arg_min', 'arg_max', 'first', 'last', 'any_value',
    'string_agg', 'group_concat', 'listagg', 'array_agg', 'list',
    // window
    'row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile',
    'lag', 'lead', 'first_value', 'last_value', 'nth_value',
    // math
    'abs', 'ceil', 'ceiling', 'floor', 'round', 'trunc', 'sign', 'sqrt', 'cbrt',
    'exp', 'ln', 'log', 'log2', 'log10', 'pow', 'power', 'mod', 'greatest', 'least',
    'acos', 'asin', 'atan', 'atan2', 'cos', 'sin', 'tan', 'degrees', 'radians', 'pi',
    'bit_count', 'gcd', 'lcm', 'factorial', 'even',
    // conditional / null handling
    'coalesce', 'ifnull', 'nullif', 'nvl', 'if', 'case', 'iif',
    // casting and type inspection
    'cast', 'try_cast', 'typeof',
    // string
    'lower', 'upper', 'length', 'char_length', 'character_length', 'trim', 'ltrim',
    'rtrim', 'lpad', 'rpad', 'substr', 'substring', 'replace', 'concat', 'concat_ws',
    'split_part', 'string_split', 'str_split', 'starts_with', 'ends_with', 'contains',
    'position', 'strpos', 'instr', 'left', 'right', 'reverse', 'repeat', 'md5',
    'regexp_matches', 'regexp_replace', 'regexp_extract', 'regexp_full_match',
    'format', 'printf', 'initcap', 'ascii', 'chr', 'to_base64', 'from_base64',
    // date / time
    'date_trunc', 'datetrunc', 'date_part', 'datepart', 'date_diff', 'datediff',
    'date_add', 'dateadd', 'date_sub', 'extract', 'strftime', 'strptime',
    'year', 'month', 'day', 'hour', 'minute', 'second', 'quarter', 'week',
    'dayofweek', 'dayofmonth', 'dayofyear', 'weekofyear', 'monthname', 'dayname',
    'last_day', 'make_date', 'make_time', 'make_timestamp', 'age',
    'to_date', 'to_timestamp', 'epoch', 'epoch_ms', 'century', 'era',
    // list helpers used by chart-shaping queries
    'unnest', 'len', 'array_length', 'list_value', 'element_at',
  ].map((f) => f.toLowerCase()),
);

/**
 * Secondary, coarse text gate. Not relied upon for safety — the AST walk is
 * the real control — but it catches pathological inputs before parsing and
 * documents intent. Word-boundary matched to avoid tripping on column names
 * such as "copy_number".
 */
const FORBIDDEN_KEYWORDS = [
  'attach', 'detach', 'install', 'load', 'copy', 'export', 'import', 'pragma',
  'vacuum', 'checkpoint', 'insert', 'update', 'delete', 'drop', 'alter', 'create',
  'truncate', 'grant', 'revoke', 'call', 'execute', 'prepare', 'deallocate',
  'reset', 'force',
];

const parser = new Parser();
const PARSER_OPTS = { database: 'Postgresql' } as const;

/** Nodes we accept in a projection / predicate position. */
const ALLOWED_EXPR_TYPES = new Set([
  // `expr` is the wrapper the parser puts around each projected column.
  'expr', 'column_ref', 'number', 'string', 'single_quote_string',
  'double_quote_string', 'bool', 'null', 'star', 'expr_list', 'binary_expr',
  'unary_expr', 'case', 'when', 'else', 'function', 'aggr_func', 'window_func',
  'cast', 'interval', 'extract', 'aggr_filter', 'origin', 'default',
  'param_list', 'row_value', 'array', 'struct', 'select', 'var', 'boolean',
  'ASC', 'DESC', 'over', 'window', 'as', 'DISTINCT',
]);

/**
 * Every property a validated SELECT node may carry. Anything outside this set
 * makes the query fail closed — new parser output shapes must be reviewed and
 * added here deliberately rather than silently skipping validation.
 */
const KNOWN_SELECT_KEYS = new Set([
  'with', 'type', 'options', 'distinct', 'columns', 'into', 'from', 'where',
  'groupby', 'having', 'orderby', 'limit', 'window', '_next', 'set_op',
  'parentheses', 'parentheses_symbol', 'for_update', 'qualify', 'locking_read',
]);

function fail(code: GuardFailureCode, reason: string): GuardResult {
  return { ok: false, code, reason };
}

/** Function names come back in several shapes depending on the node kind. */
function functionName(node: Record<string, unknown>): string | null {
  const raw = node.name;
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    const inner = (raw as { name?: unknown }).name;
    if (typeof inner === 'string') return inner;
    if (Array.isArray(inner)) {
      // Qualified names arrive as [{value:'schema'},{value:'fn'}]; the last
      // segment is the function, and any qualification is itself suspicious.
      const parts = inner
        .map((p) => (p && typeof p === 'object' ? (p as { value?: unknown }).value : p))
        .filter((v): v is string => typeof v === 'string');
      if (parts.length > 1) return parts.join('.');
      return parts[0] ?? null;
    }
  }
  return null;
}

class Walker {
  readonly tables = new Set<string>();
  readonly functions = new Set<string>();
  private readonly localNames = new Set<string>();
  failure: GuardResult | null = null;

  constructor(private readonly allowed: Set<string>) {}

  private reject(code: GuardFailureCode, reason: string) {
    this.failure ??= fail(code, reason);
  }

  /** Register a CTE or subquery alias as a name that may be referenced. */
  addLocal(name: string) {
    this.localNames.add(name.toLowerCase());
  }

  private tableAllowed(name: string) {
    const n = name.toLowerCase();
    return this.allowed.has(n) || this.localNames.has(n);
  }

  walkStatement(stmt: unknown): void {
    if (this.failure) return;
    if (!stmt || typeof stmt !== 'object') {
      return this.reject('forbidden_syntax', 'Unrecognised statement structure.');
    }
    const s = stmt as Record<string, unknown>;
    if (s.type !== 'select') {
      return this.reject('not_a_select', `Only SELECT is permitted; found "${String(s.type)}".`);
    }

    // WITH clauses first: their names become referenceable.
    const withClause = s.with;
    if (Array.isArray(withClause)) {
      for (const cte of withClause) {
        if (!cte || typeof cte !== 'object') continue;
        const c = cte as Record<string, unknown>;
        const nameNode = c.name as { value?: unknown } | string | undefined;
        const cteName =
          typeof nameNode === 'string'
            ? nameNode
            : typeof nameNode?.value === 'string'
              ? nameNode.value
              : null;
        if (cteName) this.addLocal(cteName);
        // A materialised/recursive CTE body is itself a select — validate it.
        this.walkStatement((c.stmt as { ast?: unknown })?.ast ?? c.stmt);
      }
    }

    if (s.into && typeof s.into === 'object' && (s.into as { position?: unknown }).position) {
      return this.reject('forbidden_syntax', 'SELECT ... INTO is not permitted.');
    }

    // Fail closed on unfamiliar structure. Without this, a SELECT property the
    // walker does not know about would pass through unvalidated — which is
    // exactly how a `UNION SELECT ... FROM users` arm (stored under `_next`)
    // could otherwise smuggle in a table that is not on the allowlist.
    for (const key of Object.keys(s)) {
      if (!KNOWN_SELECT_KEYS.has(key)) {
        return this.reject('forbidden_syntax', `Unsupported SELECT clause "${key}".`);
      }
    }

    this.walkFrom(s.from);

    for (const key of ['columns', 'where', 'groupby', 'having', 'orderby', 'limit', 'window', 'distinct', 'options']) {
      this.walkExpr(s[key]);
    }

    // Set-operation arms (UNION / INTERSECT / EXCEPT) hang off `_next` and are
    // full statements in their own right.
    if (s._next) this.walkStatement(s._next);
  }

  private walkFrom(from: unknown): void {
    if (this.failure || from == null) return;
    const entries = Array.isArray(from) ? from : [from];

    for (const entry of entries) {
      if (this.failure) return;
      if (!entry || typeof entry !== 'object') {
        return this.reject('forbidden_syntax', 'Unrecognised FROM entry.');
      }
      const e = entry as Record<string, unknown>;

      // Join predicates are ordinary expressions.
      if (e.on) this.walkExpr(e.on);

      if (typeof e.table === 'string') {
        // Cross-database / cross-catalog references are never allowed: the
        // application database lives in a different engine entirely, but this
        // also blocks ATTACH-ed catalogs.
        if (e.db) {
          return this.reject(
            'forbidden_table',
            `Qualified table reference "${String(e.db)}.${e.table}" is not permitted.`,
          );
        }
        if (!this.tableAllowed(e.table)) {
          return this.reject(
            'forbidden_table',
            `Table "${e.table}" is not part of the selected dataset.`,
          );
        }
        this.tables.add(e.table.toLowerCase());
        if (typeof e.as === 'string' && e.as) this.addLocal(e.as);
        continue;
      }

      // Derived table: FROM (SELECT ...) alias
      const expr = e.expr as Record<string, unknown> | undefined;
      if (expr && typeof expr === 'object') {
        if (expr.type === 'function' || expr.type === 'aggr_func') {
          const fn = functionName(expr) ?? 'unknown';
          return this.reject(
            'table_function',
            `Table functions are not permitted in FROM (found "${fn}"). ` +
              'Only the selected dataset table may be read.',
          );
        }
        if (typeof e.as === 'string' && e.as) this.addLocal(e.as);
        const sub = (expr.ast as unknown) ?? expr;
        this.walkStatement(sub);
        continue;
      }

      // An AST shape we do not understand is a rejection, not a pass-through.
      return this.reject(
        'forbidden_syntax',
        'Unsupported FROM clause. Query the dataset table directly.',
      );
    }
  }

  private walkExpr(node: unknown): void {
    if (this.failure || node == null) return;

    if (Array.isArray(node)) {
      for (const n of node) this.walkExpr(n);
      return;
    }
    if (typeof node !== 'object') return;

    const n = node as Record<string, unknown>;
    const type = typeof n.type === 'string' ? n.type : null;

    // A nested SELECT anywhere (IN (...), EXISTS, scalar subquery) gets the
    // full statement treatment rather than being treated as a plain node.
    if (type === 'select') {
      this.walkStatement(n);
      return;
    }
    if (n.ast && typeof n.ast === 'object') {
      this.walkStatement(n.ast);
      return;
    }

    if (type === 'function' || type === 'aggr_func' || type === 'window_func') {
      const name = functionName(n);
      if (!name) {
        return this.reject('forbidden_function', 'Could not resolve a function name.');
      }
      const lower = name.toLowerCase();
      if (lower.includes('.')) {
        return this.reject(
          'forbidden_function',
          `Schema-qualified function "${name}" is not permitted.`,
        );
      }
      if (!ALLOWED_FUNCTIONS.has(lower)) {
        return this.reject(
          'forbidden_function',
          `Function "${name}" is not on the read-only analytics allowlist.`,
        );
      }
      this.functions.add(lower);
    } else if (type && !ALLOWED_EXPR_TYPES.has(type)) {
      return this.reject('forbidden_syntax', `Unsupported expression "${type}".`);
    }

    for (const value of Object.values(n)) {
      if (value && typeof value === 'object') this.walkExpr(value);
    }
  }
}

export function validateSql(rawSql: string, options: GuardOptions): GuardResult {
  const maxLength = options.maxLength ?? 8_000;
  const sql = rawSql.trim().replace(/;\s*$/, '');

  if (!sql) return fail('empty', 'No SQL was produced.');
  if (sql.length > maxLength) {
    return fail('too_long', `Query exceeds the ${maxLength} character limit.`);
  }

  // Coarse pre-filter. The AST walk below is the authoritative control; this
  // just rejects obvious garbage early and cheaply.
  for (const kw of FORBIDDEN_KEYWORDS) {
    const re = new RegExp(`(^|[^a-z0-9_])${kw}([^a-z0-9_]|$)`, 'i');
    if (re.test(sql)) {
      return fail('forbidden_keyword', `The keyword "${kw}" is not permitted in an analysis query.`);
    }
  }

  let ast: unknown;
  try {
    ast = parser.astify(sql, PARSER_OPTS);
  } catch (err) {
    return fail('parse_error', `Could not parse the generated SQL: ${(err as Error).message}`);
  }

  if (Array.isArray(ast)) {
    if (ast.length !== 1) {
      return fail('multiple_statements', 'Only a single statement may be executed.');
    }
    ast = ast[0];
  }

  const allowed = new Set(options.allowedTables.map((t) => t.toLowerCase()));
  const walker = new Walker(allowed);
  walker.walkStatement(ast);
  if (walker.failure) return walker.failure;

  return {
    ok: true,
    sql,
    tables: [...walker.tables],
    functions: [...walker.functions],
  };
}

/**
 * Wraps a validated query so the browser receives at most `limit` rows.
 *
 * The wrap is applied *outside* the original query, so any GROUP BY / SUM /
 * window function still runs across the entire dataset — only the delivered
 * rows are capped. `limit + 1` is fetched so the caller can tell "exactly at
 * the cap" from "there is more".
 */
export function wrapWithRowLimit(sql: string, limit: number): string {
  return `SELECT * FROM (${sql}) AS _vq_result LIMIT ${Math.max(1, Math.floor(limit)) + 1}`;
}

/** Counts the true result size without shipping the rows. */
export function wrapWithCount(sql: string): string {
  return `SELECT COUNT(*)::BIGINT AS _vq_total FROM (${sql}) AS _vq_count`;
}

export const __testing = { ALLOWED_FUNCTIONS, FORBIDDEN_KEYWORDS };
