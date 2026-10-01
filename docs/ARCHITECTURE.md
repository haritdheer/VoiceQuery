# Architecture

A short explanation of how VoiceQuery is put together and why.

## Shape

```
 Browser ── React 19 · Vite · Tailwind 4 · Recharts
    │
    │  httpOnly SameSite=Lax session cookie
    │  X-CSRF-Token header on every mutating request
    ▼
 Fastify API (TypeScript, Node 20+)  ── single process
    │
    ├── Postgres          users, sessions, conversations, messages,
    │                     credit_accounts, credit_ledger,
    │                     idempotency_records, datasets
    │
    ├── DuckDB            one read-only file per dataset, on local disk
    │
    └── AI adapter        Anthropic (claude-opus-5)
                          │ the user's own key (BYOK)
                          │ offline demo provider
```

One API process, one application database, one analytics engine. No queue, no
microservices, no cache tier. Everything that could be a service is a module
until there is a measured reason otherwise.

## Why two databases

They do genuinely different jobs, and conflating them would be the security bug.

**Postgres** holds everything transactional: accounts, sessions, the credit
ledger, payments. It needs `SELECT ... FOR UPDATE`, `CHECK` constraints and real
transactions.

**DuckDB** holds user data and answers analytical queries. It is columnar, fast
at `GROUP BY` over hundreds of thousands of rows, and — critically — it is a
*separate engine*. Model-generated SQL runs only there. Even a query that
defeated every validation layer could not reach the users table, because the
users table is not in that database at all.

Each dataset is its own DuckDB file. Cross-user isolation is therefore physical,
not a `WHERE user_id = ...` clause the model could omit.

## Request path for an analysis

```
POST /api/analyze
  │
  ├─ session cookie → user id            (never from the request body)
  ├─ CSRF token check
  ├─ rate limit (per account, else per IP)
  ├─ idempotency key claimed             → a completed retry replays, free
  │
  ├─ 1. load dataset under the caller's identity      ┐
  ├─ 2. resolve provider: BYOK → platform → demo      │ authorisation
  ├─ 3. reserve a credit (transaction + row lock)     ┘ and entitlement
  │
  ├─ 4. build bounded context: schema + last 4 turns
  ├─ 5. messages.parse() → { sql, chartKind, xKey, yKeys, ... }
  ├─ 6. validateSql()  ── AST allowlist                ┐
  ├─ 7. runAnalyticalQuery() ── sandboxed DuckDB       ┘ safety
  ├─ 8. explain() from a bounded slice of the results
  │
  └─ 9. commit the credit  —or—  refund on any failure
```

Reserving *before* the model call is deliberate: it makes over-spend impossible
under concurrency. Refunding on any failure after that point means a user is
only ever charged for a delivered answer. A clarification refunds too, because
no analysis completed.

Each numbered stage is timed with `performance.now()` and the measurements are
returned to the client. The progress animation in the UI is a separate,
display-only affordance; the numbers shown after the answer arrives are the
server's real measurements.

## The two SQL safety layers

Detailed in the README. The design principle worth repeating here:

**Layer 1 fails closed.** The AST walker rejects any node type or `SELECT`
property it does not recognise, rather than skipping it. This was not the
original design — the first version walked only the properties it knew about,
and a `UNION SELECT ... FROM users` arm stored under `_next` passed validation
completely. Fixing that one property would have left the class of bug intact.
Rejecting unrecognised structure is what actually closes it.

**Layer 2 does not depend on layer 1.** DuckDB is opened read-only with
`enable_external_access=false`, extension autoloading off, and then
`lock_configuration=true` so nothing executed afterwards can relax any of it.
Tests assert the engine refuses file reads, `INSTALL`, `ATTACH`, `COPY ... TO`
and writes even when the parser is bypassed entirely.

## Untrusted input boundaries

Three things are treated as untrusted, and each has an explicit boundary:

1. **Uploaded data.** Column names and cell values are user-controlled, so they
   are wrapped in delimited blocks and the system prompt states that their
   contents are data to describe, never instructions to follow. Dataset
   contents are never written to logs.
2. **Model output.** The SQL is parsed and validated; the chart spec is checked
   against the actual result columns and downgraded to no chart if it references
   something that does not exist.
3. **Provider failures.** An auth-class error is classified by whose key it
   was: the user's own key produces an actionable message naming their
   provider, while the operator's produces `platform_unavailable`, which the
   client turns into the key form. The two are never conflated.

## Credit ledger design

`credit_accounts.balance` is the authoritative counter; `credit_ledger` is the
audit trail. They must always reconcile, and `reconcile()` exists so tests can
assert it.

Reservations move through `reserved → committed | refunded`. The reservation row
keeps its own reason and delta — a refund writes a *new* row rather than
rewriting history. Double refunds are prevented twice: the state transition only
fires once, and a unique partial index on `refund_of` makes a second refund row a
constraint violation rather than a race.

## Provider adapter

`AiProvider` has two methods: `generateSqlPlan` and `explain`. The pipeline knows
nothing else about providers. Adding one means implementing the interface and
registering it in `registry.ts`.

The SQL step uses structured outputs (`messages.parse()` with `zodOutputFormat`)
so the plan arrives schema-valid. Scraping JSON out of prose would be a second
parser to get wrong.

Precedence is BYOK → platform → demo, with **no fallback between them**. If a
user's key fails they are told; silently charging them platform credits for a
request they meant to fund themselves would be wrong, and silently spending the
platform key on their traffic is an abuse vector.

### Guests never reach a paid provider

`resolveProvider()` short-circuits to the demo provider for any guest, before
the platform key or a BYOK key is considered. This is the cost boundary for
anonymous access: "try it without signing in" must not mean "spend the
operator's AI budget without signing in".

A guest is modelled as a real `users` row with `is_guest = true`, NULL
credentials and an expiry. That choice matters — it means conversations,
messages, ownership predicates and the sweep all work unchanged, rather than
needing a parallel set of nullable foreign keys everywhere. A CHECK constraint
keeps the two kinds honest: a real account must have credentials, a guest must
have none.

The guest ceiling is checked at step 0 of the pipeline, before the dataset is
even loaded, so an exhausted guest costs nothing at all.

### Which mode spends a credit

Only the platform path does. BYOK is exempt because the user's own provider is
billed; demo is exempt because it makes no provider call at all. Both still cost
hosting and CPU, which is what the rate limits are for — a credit represents AI
spend specifically, so charging one where no model ran would misstate what
happened.

`DEMO_CONSUMES_CREDITS` overrides the demo exemption, so the allowance and
upgrade flows stay demonstrable on a deployment with no AI credentials. The
client never re-derives any of this: `SessionState.creditsApply` is computed
server-side and the UI just reads it.

## Frontend

Plain React with local state — no router library, no state management library,
no component framework. The app has two routes and a handful of dialogs; adding
those dependencies would be more code, not less.

Recharts is lazy-loaded (`React.lazy`) because it is 434 KB of the bundle and is
only needed once an answer with a chart exists. That keeps the initial load at
282 KB / 85 KB gzipped.

### Chart colours

The categorical palette is the validated default from the visualization
guidelines, used in fixed slot order and never cycled. Both light and dark steps
were run through the palette validator:

```
LIGHT (surface #fcfcfb, 6 slots)
  [PASS] Lightness band      all 6 inside L 0.43–0.77
  [PASS] Chroma floor        all 6 >= 0.1
  [PASS] CVD separation      worst adjacent ΔE 9.1 (protan)
  [PASS] Normal-vision floor worst adjacent ΔE 19.6
  [WARN] Contrast vs surface 3 slots below 3:1 — relief required

DARK (surface #1a1a19, 6 slots)
  [PASS] all five checks, incl. contrast >= 3:1
```

The light-mode contrast warning obliges "relief" — identity must not depend on
colour alone. That is satisfied structurally: every chart renders directly above
the full result table, and multi-series charts always carry a legend. No value
in this UI is conveyed by colour only.

Both themes are *selected*, not derived — the dark tokens are their own steps
against the dark surface, defined under both `prefers-color-scheme` and an
explicit `[data-theme]` scope.

## Testing strategy

Backend tests run against **PGlite**, which is real Postgres compiled to
WebAssembly. That choice matters: `CHECK` constraints, `FOR UPDATE`, unique
partial indexes and transaction rollback all behave exactly as they will in
production, so the credit-ledger tests are testing the real guarantees rather
than a mock of them. The one difference — single-connection serialisation — is
called out in the concurrency test.

Frontend tests mock the API module and exercise the UI's own behaviour: which
states appear, what the user is told, and which guards hold.
