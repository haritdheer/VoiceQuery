# Known limitations

Written honestly. Everything here is a real constraint of the current build, not
a placeholder.

## Guest mode

**Guests only ever get demo answers**, never real AI, even when a provider key
is configured. That is the intended cost boundary for anonymous access, not an
oversight — but it does mean the demo undersells the product to anyone who
never signs up.

**The guest ceiling is per session, not per person.** Clearing cookies starts a
fresh guest with a fresh allowance. Rate limits and the fact that guests cost
nothing but CPU make this acceptable; tying it to a device or IP would need
fingerprinting, which is not worth it here.

**Guest work is disposable.** Conversations are deleted with the guest account
after `GUEST_TTL_HOURS`. Registering afterwards does not carry the earlier
guest conversation into the new account — the new account starts clean.

## Demo mode

Demo mode consumes no credits, because it makes no provider call. The
consequence is that the free-allowance and upgrade-modal flows are unreachable
on a deployment with no AI credentials — set `DEMO_CONSUMES_CREDITS=true` to
walk through them offline.

## Blocked on credentials, not code

| Item | What is missing | How to unblock |
|---|---|---|
| Real AI answers | a provider key | Set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `OPENROUTER_API_KEY`; demo mode turns itself off |
| BYOK end-to-end | A real provider key to validate against | Any valid Anthropic, OpenAI or OpenRouter key |

**No provider's success path has been exercised against a live API**, because no
key was available in this environment. Each adapter follows its SDK's current
documented surface (`messages.parse()` + `zodOutputFormat` for Anthropic,
`chat.completions.parse()` + `zodResponseFormat` for the OpenAI-compatible
pair), and the *failure* paths are verified — all three return their own
provider's rejection message against a bad key. Treat the first successful call
on each as the real integration test.

**Each analysis is two provider calls** — one to generate the SQL plan, one to
write the explanation from the actual results. That is deliberate (the
explanation is grounded in real rows rather than guessed alongside the query),
but it means a question costs roughly twice a single completion. Budget
accordingly, or point `AI_MODEL` at a cheaper model.

**OpenRouter structured-output support varies by model.** The adapter detects a
rejected `json_schema` request and retries in plain JSON mode, validating
against the same schema. That fallback path is written but has not been
triggered against a real model that lacks strict support.

## Migrations

There is no migration *versioning* — `schema.sql` is a single re-runnable
script of `CREATE TABLE IF NOT EXISTS` plus explicit `ALTER TABLE ... ADD
COLUMN IF NOT EXISTS` statements, applied at every boot. That is adequate for
this size of project and is covered by `tests/migrate.test.ts`, which migrates
over the previous schema.

It does not scale to a team: there is no down-migration, no ordering guarantee
beyond file order, and a destructive change (renaming or dropping a column)
would need writing by hand with care. A real migration tool would be the right
answer past this point.

## Architectural limits

**BYOK keys are memory-only.** They are scoped to the session with a TTL and do
not survive an API restart or reach a second instance. This is the intended
default. Persisting them needs envelope encryption with independently managed
key material, which is out of scope for v1.

**The TTL sweep is in-process.** Expired datasets and sessions are cleaned every
15 minutes by a timer inside the API. With more than one instance this runs
redundantly (harmless, but wasteful); move it to a scheduled job or a leader-
elected worker before scaling out.

**Single-region, single-process assumptions.** Rate limiting is in-memory per
instance, so N instances allow N× the configured limit. Move to a shared store
(Redis) when scaling horizontally.

**DuckDB needs local disk.** Serverless and scale-to-zero platforms are a poor
fit. Use a long-running container with a persistent volume.

## Data handling

**Type inference needs 90% agreement.** A column is typed as date/number only if
at least 90% of sampled values parse. In a small file, two or three junk rows can
leave a date column as text, which limits what can be asked of it. The inferred
type is always shown in the schema panel so it is visible rather than surprising.
Values that do not fit their column become `NULL` via `TRY_CAST` instead of
failing the upload.

**Only CSV.** No Excel, JSON, Parquet or database connections.

**One table per dataset.** No joins across uploaded files.

**Uploads are read fully into memory** before parsing. The 10 MB default keeps
that safe; raising it substantially would need streaming ingestion.

## Analysis quality

**Conversation context is the last 4 turns**, with answers trimmed to 400
characters. Long reasoning chains lose earlier detail. This is a deliberate cost
and latency bound, not an oversight.

**Charts are capped at 60 plotted points** (8 for pie) for legibility. The table
below always shows the full result, and the chart says when it is showing a
subset.

**The model can still write a correct-but-unhelpful query.** Validation proves a
query is *safe*, not that it *answers the question*. That is why the SQL is
always shown — the intended workflow is that you can check it.

**No causal claims.** The explanation prompt forbids asserting that one thing
caused another. It cannot make the underlying data better, and correlations in
your data remain correlations.

## Voice

**Browser speech recognition only.** No hosted transcription. Firefox has no
support at all, in which case the microphone control is replaced with an
explanatory note. In Chrome and Edge, audio goes to Google for recognition — the
UI discloses this.

**Dictation, not conversation.** Press to talk, review the transcript, send.
There is no barge-in, no streaming partial answers, no full-duplex audio, and
nothing in the UI claims there is.

**Spoken replies use browser synthesis.** Quality varies by platform and it is
off by default.

## Testing

**Concurrency tests assert the invariant, not lock contention.** PGlite
serialises statements on one connection, so the parallel-reservation test proves
that N concurrent requests against a balance of 2 yield exactly 2 successes and
never a negative balance — which is the property that matters, and is
additionally enforced by `CHECK (balance >= 0)`. It does not exercise contention
between separate Postgres backends. Run the suite against a real server with
`DATABASE_URL` set to cover that.

**No browser end-to-end tests.** Frontend tests use Testing Library with jsdom
and a mocked API. A Playwright suite driving the real stack would be the next
addition; the flows are currently verified by the component tests plus manual
HTTP runs against a live server.

**No load testing.** Throughput, memory under concurrent DuckDB queries, and
instance sizing are unmeasured.

## Security posture

Reviewed and handled: SQL injection into the analytics engine, cross-user data
access, CSRF, session fixation, credit race conditions and
replay, secret leakage into logs and responses, path traversal via dataset ids,
prompt injection from uploaded data.

Not done: a third-party penetration test, formal threat model document, account
lockout / brute-force throttling on login beyond the global rate limit, email
verification, or password reset. Treat this as a portfolio demonstration, and do
not put confidential data in it.
