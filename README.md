# VoiceQuery — Talk to Your Data

Ask a question about a dataset in plain language or by voice. VoiceQuery generates
SQL, validates it, runs it in an isolated read-only engine, and returns a chart,
the result rows, a written answer, and the query it used — with measured timings
for each stage.

```
"Which products generated the most revenue?"
  → ranked bar chart + result table + plain-language answer + the SQL
"Now show only September"
  → same dataset, same conversation, re-analysed with a September filter
```

---

## Contents

- [Quick start](#quick-start)
- [What works right now](#what-works-right-now)
- [Architecture](#architecture)
- [Safe SQL execution](#safe-sql-execution)
- [Guest mode](#guest-mode)
- [Credits and the free allowance](#credits-and-the-free-allowance)
- [Bring your own API key](#bring-your-own-api-key)
- [Voice input](#voice-input)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Tests](#tests)
- [Known limitations](#known-limitations)
- [Demo script](#demo-script)

---

## Quick start

Requirements: **Node 20.11+**. Nothing else — no Python, no Docker, no Postgres
install needed to run it locally.

```bash
git clone <your-repo-url> voicequery
cd voicequery
npm install
cp .env.example .env      # works as-is for a local run
npm run dev
```

- API → http://localhost:8787
- Web → http://localhost:5173

Open the web app and click **Try the demo** — no sign-up required. Ask a
question about the seeded sample dataset straight away.

### Running against real Postgres

The app speaks only Postgres. With no `DATABASE_URL` it falls back to
[PGlite](https://pglite.dev) — genuine Postgres compiled to WebAssembly — so the
repo runs with zero setup. To use a real server:

```bash
docker compose up -d db
echo 'DATABASE_URL=postgres://voicequery:voicequery@localhost:5432/voicequery' >> .env
npm run db:migrate
npm run dev
```

Migrations run automatically at boot and are safe to re-run, so `db:migrate` is
only needed if you want to apply them separately.

Schema changes are expressed as explicit `ALTER TABLE ... ADD COLUMN IF NOT
EXISTS` statements alongside the `CREATE TABLE IF NOT EXISTS` ones. That
matters: `CREATE TABLE IF NOT EXISTS` is a no-op once a table exists, so a
column added only there would silently never reach a database created by an
earlier version. `tests/migrate.test.ts` builds the previous schema and
migrates over it to keep that honest.

### Enabling real AI answers

Without `ANTHROPIC_API_KEY` the app runs in **demo mode**: a small local
rule-based generator produces real SQL against your schema so the whole pipeline
works, and every response is tagged `simulated` and badged **"Demo mode —
simulated"** in the UI. It is never presented as model output.

```bash
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .env
```

Demo mode does not consume credits, so the upgrade modal is unreachable without
a key. To rehearse that flow offline, set `DEMO_CONSUMES_CREDITS=true`.

---

## What works right now

| Capability | Status |
|---|---|
| Try the demo with no sign-up (guest mode) | Working, tested |
| Sample dataset, seeded on first boot | Working |
| CSV upload with validation, type inference, preview, expiry | Working |
| Text → SQL → chart → written answer | Working |
| Voice input with editable transcript (Chrome/Edge/Safari) | Working |
| Optional spoken replies (browser speech synthesis) | Working |
| Follow-up questions with bounded conversation context | Working |
| SQL validation + sandboxed execution | Working, tested |
| Five free questions per account, transactional ledger, refunds, idempotency | Working, tested |
| Bring-your-own-key (Anthropic) | Working — needs a real key to exercise |
| Real AI answers (Anthropic / OpenAI / OpenRouter) | Implemented, **needs a provider key** |

The item marked in bold is blocked only on credentials, not on code. Setup
steps are below.

---

## Architecture

```
 Browser (React 19 + Vite + Tailwind 4 + Recharts)
   │  session cookie (httpOnly, SameSite=Lax) + X-CSRF-Token
   ▼
 Fastify API (TypeScript, Node 20+)
   ├── Postgres ── users, sessions, conversations, messages,
   │               credit ledger, dataset metadata
   ├── DuckDB ──── one isolated read-only file per dataset
   └── AI adapter ─ Anthropic (claude-opus-5) │ user's BYOK key │ offline demo
```

A deliberately boring shape: one API process, one application database, one
analytics engine. No microservices, no queue.

### Repository layout

```
apps/api            Fastify backend
  src/analytics     sqlGuard.ts (AST allowlist) + duckdb.ts (sandbox)
  src/ai            provider adapter, prompts, pipeline, demo provider
  src/credits       transactional credit ledger
  src/datasets      CSV parsing, dataset store, sample data
  src/routes        HTTP endpoints
  tests             189 backend tests
apps/web            React frontend
packages/shared     wire contract types shared by both
```

### The analysis pipeline

Every request runs these steps in order, and each is timed:

1. Authenticate; resolve the dataset **under the caller's identity**
2. Decide who pays (BYOK key → platform key → demo)
3. **Reserve a credit** before any money is spent on a model call
4. Build bounded context: schema + last 4 turns, answers trimmed
5. Generate a structured plan (SQL + chart intent) via `messages.parse()`
6. **Validate the SQL** against the allowlist
7. Execute in the sandbox with a timeout and row cap
8. Explain from a bounded slice of the results
9. Commit the credit — or refund it if anything after step 3 failed

A clarification request refunds, because no analysis completed.

### What is sent to the AI provider

Column names, column types, up to 6 example values per column, the last few
conversation turns, and the rows your query returned (capped at
`MAX_EXPLAIN_ROWS`, default 40). **The full dataset is never sent.**

Uploaded data is treated as untrusted input: the schema and results are wrapped
in delimited blocks and the system prompt states that their contents are data to
describe, never instructions to follow.

---

## Safe SQL execution

Model-generated SQL is never executed as written. Two independent layers stand
between the model and the data, and neither is trusted alone.

### Layer 1 — AST allowlist (`apps/api/src/analytics/sqlGuard.ts`)

The query is parsed and the whole tree is walked. Anything not explicitly
recognised is rejected:

- exactly one statement, and it must be a `SELECT`
- only the selected dataset's table may be referenced — checked in subqueries,
  CTEs, joins, and **set-operation arms**
- every function call is checked against a read-only allowlist
- unknown AST node types and unknown `SELECT` properties **fail closed**

That last rule matters. A `UNION SELECT ... FROM users` arm is stored under a
`_next` property that an early version of the walker never visited, so it passed
validation. Rejecting unrecognised structure — rather than skipping it — is what
closes that whole class of hole, not just the one instance.

Keyword filtering alone is not sufficient, which is why this is structural:

```sql
SELECT * FROM read_csv_auto('/etc/passwd')     -- a valid SELECT, no bad keyword
SELECT getvariable('secret') FROM t            -- a function hidden in a projection
SELECT CASE WHEN 1=1 THEN read_text('/x') END FROM t   -- buried three levels down
```

All three are rejected by structure. There is also a coarse keyword pre-filter,
but it is a cheap early exit, not the control.

### Layer 2 — engine lockdown (`apps/api/src/analytics/duckdb.ts`)

Each dataset is its own DuckDB file, opened with:

```
access_mode                  = READ_ONLY
enable_external_access       = false     ← no filesystem, no network
autoinstall_known_extensions = false
autoload_known_extensions    = false
memory_limit                 = 512MB
lock_configuration           = true      ← nothing can re-enable the above
```

Verified: with these settings DuckDB itself rejects `read_csv_auto(...)`,
`glob()`, `INSTALL`, `ATTACH`, `COPY ... TO`, writes, and
`SET enable_external_access=true`. Those are asserted in
`apps/api/tests/analysis.test.ts`, so even a query that somehow defeated the
parser would still fail.

Cross-user access is prevented by **physical separation** — a query can only ever
reach the one file belonging to the selected dataset — plus ownership predicates
in every SQL lookup. Storage paths are built from server-generated UUIDs only and
are never returned to the client.

### Row limits that don't corrupt aggregates

The validated query is wrapped rather than rewritten:

```sql
SELECT * FROM ( <your query> ) AS _vq_result LIMIT 501
```

The `GROUP BY`/`SUM`/window function inside still runs across the entire dataset;
only the delivered rows are capped. The true size is counted separately, so the
UI can say "showing 500 of 12,480" honestly.

---

## Guest mode

**Try the demo** starts an anonymous session — no credentials at all. A guest
is a real `users` row with no credentials and an expiry, so every ownership
check, conversation and message path works unchanged.

Signing up is barely more friction: any non-empty username and password are
accepted, with no email format required and no minimum length. Nothing is ever
mailed anywhere. See [Security posture](docs/LIMITATIONS.md#security-posture)
for what that trade costs.

What a guest can do:

| | Guest | Account |
|---|---|---|
| Ask about the sample dataset | yes | yes |
| Follow-up questions, conversation history | yes | yes |
| Charts, result tables, generated SQL | yes | yes |
| **Real AI answers** | no — always the demo provider | yes |
| Download a dataset as CSV | sample only | own uploads and the sample |
| Upload a CSV | no | yes |
| Connect your own API key | no | yes |

### The cost boundary

**A guest never reaches a paid provider**, even when `ANTHROPIC_API_KEY` is
configured. `resolveProvider()` short-circuits to the demo provider for any
guest, before the platform key is considered. Without that, "try it without
signing in" would be an open invitation to spend the operator's AI budget.

Verified directly: with a platform key set, a guest's responses still come
back `aiMode: "demo", simulated: true`.

### Nudge vs. ceiling

Two separate mechanisms, deliberately:

- **The nudge** is persuasion. It appears after `GUEST_NUDGE_AFTER` answers
  (default 2), repeats every `GUEST_NUDGE_EVERY` (default 3), and has OK /
  Cancel. Cancel keeps them exploring — it must not pretend the demo stopped.
- **The ceiling** is abuse control. At `GUEST_QUESTION_LIMIT` (default 15) the
  server refuses with 403 `guest_limit`. At that point the dialog drops the
  "keep exploring" option, because offering it would be a lie.

Guest accounts and everything they created are swept after `GUEST_TTL_HOURS`.

Set `GUEST_MODE_ENABLED=false` to require sign-in before the demo.

## Credits and the free allowance

Each account gets exactly **five** free questions, once, at creation
(`FREE_CREDITS`), funded by the operator's own provider key. Enforced entirely
server-side.

There is nothing to buy. When the five are gone the only way forward is to
connect your own provider key — which is also what happens if the operator's
key is rejected or runs out of quota mid-question. Offering a purchase that
does not exist would be worse than offering nothing.

| Event | Effect |
|---|---|
| Completed analysis | −1 credit |
| Follow-up analysis | −1 credit |
| Failed analysis (any cause) | credit refunded |
| Clarification request | **refunded** — no analysis completed |
| Viewing past results | free |
| Retry with the same idempotency key | replays the stored response, no charge |
| BYOK mode | no free questions consumed |
| Operator's key rejected or out of quota | credit refunded, key form opened |
| Demo mode | no credits consumed by default — it makes no provider call |

How the guarantees hold:

- `credit_accounts.balance` has `CHECK (balance >= 0)` — over-spend is impossible
  even if a caller forgets to check
- every mutation takes `SELECT ... FOR UPDATE` inside a transaction, so parallel
  requests cannot both see the last credit
- reservations carry a unique idempotency key, so a retry reuses the original
- refunds are guarded twice: a state transition that only fires once, and a
  unique index making a second refund row a constraint violation
- every change writes a ledger row; `reconcile()` asserts the ledger always sums
  to the stored balance

The client's credit counter is display-only. The acting user always comes from
the session cookie, never from a request body.

**Demo mode is free.** It makes no provider call and spends nothing, so it
consumes no AI credit — the same exemption BYOK gets. Its real cost is hosting
and CPU, which the rate limits cover. Set `DEMO_CONSUMES_CREDITS=true` to charge
anyway, which is how you demonstrate the free-allowance and upgrade-modal flows
on a deployment that has no AI credentials. Either way every response carries a
visible "simulated" badge.

---

## Bring your own API key

Users can connect their own key from **Anthropic, OpenAI or OpenRouter**. While
connected, their provider account pays and **no application credits are
deducted**. This works whether or
not the server has its own `ANTHROPIC_API_KEY` — a BYOK key takes precedence
over everything, so it is the way to get real AI answers out of a deployment
running in demo mode.

**Where to enter it**, once signed in (guests cannot):

- **"Use real AI"** in the header, shown whenever answers are coming from the
  demo provider
- **Settings → AI provider key → Connect an API key**
- the upgrade prompt, when credits run out

All three open the same form. The first two were added after the form turned
out to be reachable *only* through the credit-exhaustion path — which free demo
mode can never trigger, leaving no way to enter a key at all.

Handling:

- sent once over HTTPS in a POST body — never in a URL or query string
- validated through the provider's documented mechanism (one minimal Messages
  request); the UI discloses beforehand that this bills a few tokens
- held in **server memory only**, scoped to the session, with a TTL
- never written to the database, browser storage, logs, or error messages
- only a truncated SHA-256 fingerprint is ever logged
- a disconnect action deletes it immediately

Keys do not survive an API restart. That is the correct default; persisting them
would require envelope encryption with separately managed secrets, which is
deliberately not implemented in v1.

**No silent fallback.** If a user's key fails, the provider's error is shown and
they choose what to do. Quietly spending platform credits on a request they meant
to fund themselves would be wrong, and quietly spending our key on their traffic
is an abuse vector.

The UI states plainly that a Claude Pro/Max subscription is a separate product
and does **not** include API credits, and that an LLM key does not cover speech
services.

### Supported providers

| Provider | Adapter | Model |
|---|---|---|
| Anthropic | `anthropic.ts` (official SDK, `messages.parse`) | server default, `claude-opus-5` |
| OpenAI | `openaiCompatible.ts` (`chat.completions.parse`) | user picks, e.g. `gpt-6.1-sol` |
| OpenRouter | same adapter, different base URL | user picks, e.g. `anthropic/claude-sonnet-4.5` |

OpenRouter implements the OpenAI wire protocol, so one adapter serves both —
the differences (base URL, attribution headers, model naming) live in the
provider catalogue in `apps/api/src/ai/providers.ts`, not in branching code.

Two deliberate choices in that catalogue:

- **No key-prefix validation.** A wrong guess about a provider's key format
  would reject valid keys, and the real check is the validation request anyway.
  Prefixes appear only as placeholder text.
- **The model is the user's choice** for OpenAI and OpenRouter, validated in
  the same round trip as the key. Hardcoding a default would rot the moment a
  provider renames something, and on OpenRouter choosing the model is the whole
  point.

### When a provider says no

Provider failures are translated into something actionable rather than a bare
status code, because the fix differs completely by cause:

| Condition | What the user is told |
|---|---|
| 402, or OpenAI's `insufficient_quota` 429 | "Your {provider} account is out of credit. Top up at {billing url}" — and that VoiceQuery is not the one billing them |
| 401 | the key was rejected |
| 403 | the key may lack model access, **or** the request hit a content policy |
| 404 | names the exact model id that was not recognised |
| 502 / 503 | the model or route is down; suggests trying another |
| other 429 | a genuine rate limit, marked retryable |

Only the genuinely transient ones are marked retryable. An empty balance is
not a wait-and-retry situation, so it is not presented as one.

Not every model behind OpenRouter supports strict structured outputs. The
adapter tries `json_schema` mode first and falls back to plain JSON mode,
validating against the same zod schema either way — a response that fails
validation is an error, never a silently accepted guess.

Adding a fourth provider means implementing the `AiProvider` interface in
`apps/api/src/ai/provider.ts` and adding a catalogue entry — the pipeline does
not change.

---

## Voice input

Press-to-talk dictation using the browser's Web Speech API.

- **Typing always works.** Voice is additive. Where the API is unavailable
  (Firefox), the control is replaced by an explanatory note, not a broken button.
- The transcript lands in the **editable** textarea — nothing is analysed until
  you press Ask.
- The UI discloses that in Chrome and Edge, audio is sent to Google for
  recognition. No hosted transcription service is involved and no API key is used
  for it.
- Spoken replies are opt-in per answer and use browser speech synthesis.

This is dictation, not full-duplex conversation, and the UI does not claim
otherwise. Hosted speech services could be added behind the same adapter shape.

---

## Configuration

Every option lives in `.env.example` with comments. The whole configuration is
validated once at boot by `apps/api/src/config/env.ts` — a bad value fails fast
with a readable message rather than surfacing later as a confusing bug.

Production requires `DATABASE_URL` and a non-default `SESSION_SECRET`; the server
refuses to start otherwise.

---

## Deployment

Full walkthrough in **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — Railway,
Fly.io, and a plain VPS, with the gotchas that actually bite.

The short version: **one container, one domain.** The API serves the built
frontend from the same origin, so the `SameSite=Lax` session cookie works
unchanged and there is no CORS to configure. It needs a Postgres database and
a mounted volume for the DuckDB dataset files, which rules out serverless
platforms — those have no persistent filesystem.

```bash
docker build -f apps/api/Dockerfile -t voicequery .
```

```
DATABASE_URL     required
SESSION_SECRET   required, generated — the server refuses the dev default
COOKIE_SECURE    true
DATA_DIR         a mounted volume, or uploads die on every deploy
```

Verify with `GET /api/health`: it should report `"driver":"postgres"`. If it
says `pglite`, `DATABASE_URL` never reached the container and data will be
lost on the next deploy.

---

## Tests

```bash
npm test              # both suites
npm run test:api      # backend only
npm run test:web      # frontend only
npm run typecheck     # all three packages
```

Backend tests run against **PGlite** — genuine Postgres — so constraints,
transactions and SQL behaviour are real, not mocked. See
[docs/TEST-RESULTS.md](docs/TEST-RESULTS.md) for the recorded run.

---

## Known limitations

See [docs/LIMITATIONS.md](docs/LIMITATIONS.md) for the full list. The
ones worth knowing up front:

- BYOK keys are memory-only and do not survive an API restart (by design).
- The dataset TTL sweep runs in-process every 15 minutes; a multi-instance
  deployment should move it to a scheduled job.
- Type inference needs 90% of a column's values to agree, so a few junk rows in a
  small file can leave a date column typed as text.
- Refund/chargeback reversal is manual.
- Conversation context is the last 4 turns; longer reasoning chains lose detail.

---

## Demo script

A 60–90 second recording script is in
[docs/DEMO-SCRIPT.md](docs/DEMO-SCRIPT.md).

---

## Licence

MIT.
