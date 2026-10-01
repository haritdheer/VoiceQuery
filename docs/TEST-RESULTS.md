# Test results

Recorded from an actual run on 2026-09-30. Reproduce with `npm run typecheck && npm test`.

```
##### 1. TYPECHECK (shared + api + web) #####
TypeScript errors: 0

##### 2. BACKEND TESTS #####
 Test Files  9 passed (9)
      Tests  199 passed (199)

##### 3. FRONTEND TESTS #####
 Test Files  2 passed (2)
      Tests  60 passed (60)

##### 4. PRODUCTION BUILD #####
dist/index.html                   0.59 kB │ gzip:   0.38 kB
dist/assets/index-eOl1WcNE.css   26.06 kB │ gzip:   6.07 kB
dist/assets/index-9h7I0v1C.js   281.84 kB │ gzip:  85.29 kB
dist/assets/Chart-D7B251Gy.js   433.93 kB │ gzip: 121.58 kB
✓ built in 382ms
```

**259 tests, all passing.** Backend tests run against PGlite (genuine Postgres
compiled to WASM), so constraints, transactions and SQL semantics are real.

---

## Backend — 189 tests

| File | Tests | Covers |
|---|---|---|
| `sqlGuard.test.ts` | 67 | AST allowlist |
| `credits.test.ts` | 20 | ledger, idempotency, concurrency, BYOK, demo cost |
| `analysis.test.ts` | 18 | pipeline, sandbox, row bounding |
| `csv.test.ts` | 15 | parsing, inference, messy input |
| `access.test.ts` | 13 | auth, CSRF, cross-user isolation |
| `platformFailure.test.ts` | 4 | operator key rejected: 503, refund, message hygiene |
| `guest.test.ts` | 13 | anonymous sessions, cost boundary, restrictions, ceiling |
| `migrate.test.ts` | 7 | fresh schema, re-runnability, upgrading an older database |
| `providers.test.ts` | 32 | catalogue, adapter dispatch, platform selection, BYOK per provider, error wording |

### Coverage against the required checks

| Required check | Where | Result |
|---|---|---|
| Exactly the configured free grant on account creation | `credits.test.ts` | pass |
| Successful analysis deducts one credit | `credits.test.ts` | pass |
| Failed analysis restores a credit | `credits.test.ts` | pass |
| Retry protection (idempotency) | `credits.test.ts` | pass |
| Concurrency protection | `credits.test.ts` | pass — see note |
| BYOK does not consume app credits | `credits.test.ts` | pass |
| Demo mode consumes no credits by default | `credits.test.ts` | pass |
| Demo mode charges when the operator opts in | `credits.test.ts` | pass |
| Guest never reaches a paid provider | `guest.test.ts` | pass |
| Guest cannot upload / BYOK / buy credits | `guest.test.ts` | pass |
| Guest ceiling enforced server-side | `guest.test.ts` | pass |
| Cross-user access rejection | `access.test.ts` | pass |
| Unsafe SQL rejection, incl. functions inside SELECT | `sqlGuard.test.ts` | pass |
| Valid analytical queries accepted | `sqlGuard.test.ts` | pass |

### Notable assertions

**Dangerous functions inside a valid SELECT** (20 cases). Each of these is a
syntactically correct `SELECT` containing no forbidden keyword, so keyword
filtering would pass every one. All are rejected by structure:

```
read_csv_auto in FROM · read_parquet in FROM · read_json in FROM · glob in FROM
duckdb_settings() · read_text in projection · read_blob in projection
getvariable · current_setting · nextval · hidden in CASE · hidden in WHERE
hidden in GROUP BY · hidden in ORDER BY · hidden in HAVING · hidden in a window
hidden in a CTE body · hidden in a derived table · hidden in a UNION arm
schema-qualified function
```

**Table access control** (12 cases) — `users`, `credit_ledger`, `sessions`,
`pg_tables`, and cross-catalog references are blocked through subqueries, scalar
subqueries, CTEs, joins, `UNION`, `EXCEPT` and `INTERSECT`.

**Engine-level lockdown** (7 cases in `analysis.test.ts`) — these bypass the
parser entirely and assert DuckDB itself refuses: reading a local file, globbing,
`SET enable_external_access=true`, `INSTALL`, `ATTACH`, `CREATE TABLE`, and
`COPY ... TO`. This is the second layer, independently verified.

**Row bounding without corrupting aggregates** — a windowed `SUM(revenue) OVER ()`
requested alongside more rows than the cap returns exactly `maxRows` rows, is
flagged `truncated`, reports the true `totalRows`, and its aggregate still equals
the whole-table total computed separately.

**Concurrency** — 10 parallel reservations against a balance of 2 yield exactly 2
successes and a final balance of 0, with the ledger reconciling.

> Caveat, stated plainly: PGlite serialises statements on a single connection, so
> this test proves the **invariant** rather than exercising row-lock contention
> between separate Postgres backends. The invariant is also enforced
> independently by `CHECK (balance >= 0)`. Run the suite with `DATABASE_URL`
> pointed at a real server to cover true contention.

**The operator's key failing** — `platformFailure.test.ts` mocks the registry
into platform mode and makes the provider raise an auth error. Asserts 503 with
`platform_unavailable`, that the reserved credit comes back, that the reply does
not name the operator's provider, and that a *timeout* still reports as an
ordinary retryable 502 rather than sending the user to the key form.

---

## Frontend — 72 tests

| Area | Tests | Covers |
|---|---|---|
| Sample dataset analysis | 6 | example questions, answer/SQL/table/timings render, simulated badge, clarification |
| Exhausted credits | 6 | composer replaced, BYOK + free-demo exemptions, opt-in still gates, 402 opens modal, three actions offered |
| BYOK | 3 | disclosures present, provider error shown with no silent fallback, key field is a password |
| CSV upload | 4 | non-CSV rejected client-side, server error + hint shown, schema/warnings render, limits stated |
| Microphone fallback | 3 | unsupported-browser note, control appears when supported, Enter/Shift+Enter |
| Accessibility | 3 | live region on progress, table caption, `aria-current` on selection |
| Allowance copy | 5 | "N free questions" appears only when credits are actually metered |
| Guest dashboard | 4 | anonymous asking, upload replaced, not-AI disclosure, hidden controls |
| Guest nudge cadence | 6 | fires at 2 then every 3, quiet between, blocking at the ceiling |
| Guest nudge modal | 4 | OK/Cancel, Cancel only closes, no false "keep exploring" when blocking |
| Landing guest copy | 2 | "no sign-up needed" vs the allowance fallback |
| Key-form reachability | 4 | header button, direct-open view, honest title when nothing is exhausted |
| Provider selection | 8 | all three offered, model field appears only where needed, stale model cleared, per-provider caveats |

Notable: the follow-up test asserts the second request carries the **same
`conversationId`** returned by the first and the same `datasetId`, and the
idempotency test asserts a fresh key is generated per request.

---

## Manual verification against a live server

Run with `NODE_ENV=development` on port 8788, driving the real HTTP API with
`curl`. Recorded output:

```
register:  credits: 2  aiMode: demo
analyze 1: outcome=answered
  sql: SELECT product, SUM(revenue) AS total_revenue FROM t
       GROUP BY 1 ORDER BY total_revenue DESC LIMIT 15
  chart: {"kind":"bar","xKey":"product","yKeys":["total_revenue"],...}
  rows: 10   timings: understanding=30ms generating_sql=0ms
                      running_query=35ms preparing_answer=0ms  total=68ms
follow-up: sql: ... WHERE month(order_date) = 9 ...

CSV upload (with currency, a duplicate header, a ragged row and blanks):
  columns: order_date:string, product_name:string (1 null),
           units:integer (2 null), revenue:number (1 null)
  warnings: ["1 row(s) did not have 4 values; missing cells were treated
              as empty and extra cells ignored."]
  preview:  {"revenue":"1200.5"}          ← "$1,200.50" normalised
  leaks storage path: false
empty CSV: 422 {"message":"The file is empty.",
                "details":{"hint":"Upload a CSV with a header row..."}}

Vite dev server proxy: /api/health → {"status":"ok","driver":"pglite"}
```

The `order_date:string` above is the 90%-agreement inference rule behaving
as designed: one deliberately malformed line out of five put the date column
under the threshold. See `docs/LIMITATIONS.md`.

### Guest journey, with a platform key configured

The important line here is `demoMode=false` — a platform key *was* set, and the
guest still never reached it:

```
config:  demoMode=false guest.enabled=true nudgeAfter=2 limit=4
guest:   isGuest=true email=null credits=0 used=0/4

q1: answered  simulated=true aiMode=demo      ← platform key present, not used
q2: answered  simulated=true aiMode=demo
q3: answered  simulated=true aiMode=demo
q4: answered  simulated=true aiMode=demo
q5: guest_limit                               ← hard ceiling, HTTP 403

restrictions:
  upload CSV   -> HTTP 403
  connect BYOK -> HTTP 403
  buy credits  -> HTTP 403
  read history -> HTTP 200                    ← earlier results stay readable
```

### Demo-mode credit policy, both paths

Verified against a live server on two fresh databases:

```
default (DEMO_CONSUMES_CREDITS unset)
  session: credits=2 aiMode=demo creditsApply=false
  q1: answered | creditConsumed=false | creditsLeft=2
  q2: answered | creditConsumed=false | creditsLeft=2
  q3: answered | creditConsumed=false | creditsLeft=2
  q4: answered | creditConsumed=false | creditsLeft=2
  ledger: balance=2  entries: free_grant+2      ← no analysis rows at all

DEMO_CONSUMES_CREDITS=true
  session: creditsApply=true
  q1: answered             | creditsLeft=1
  q2: answered             | creditsLeft=0
  q3: insufficient_credits | creditsLeft=0      ← upgrade modal triggers
```

Four demo analyses leave the ledger with nothing but the welcome grant: no
provider call was made, so no AI credit was spent and none was recorded.

---

## Not covered

- **The live Anthropic API.** No key was available in this environment, so the
  provider adapter's real request path is unexercised. It follows the current
  documented SDK surface, but treat the first real call as the integration test.
- **Browser end-to-end.** Frontend tests use jsdom with a mocked API. Playwright
  against the real stack is the next addition.
- **Load and soak testing.** Throughput and memory under concurrent DuckDB
  queries are unmeasured.
