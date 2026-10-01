-- VoiceQuery application schema (PostgreSQL).
-- Applied by src/db/migrate.ts. Every statement is idempotent so the migration
-- runner can be re-run safely.

-- A guest is a real user row with no credentials, so conversations, messages
-- and ownership checks work unchanged for anonymous visitors. Guests are
-- swept on expiry, taking their conversations with them via ON DELETE CASCADE.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT,
  password_hash TEXT,
  is_guest      BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bring an existing users table up to date. CREATE TABLE IF NOT EXISTS is a
-- no-op once the table exists, so column changes must be expressed as ALTERs
-- or a database created by an earlier version never gains them.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_guest BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
-- Guests have neither, so the original NOT NULLs have to go.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
-- Replaced by the partial unique index below.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;

-- A registered account must have credentials; a guest must have neither.
-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, so drop-then-add keeps this
-- re-runnable without needing a dollar-quoted DO block.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_credentials_match_kind;
ALTER TABLE users ADD CONSTRAINT users_credentials_match_kind CHECK (
  (is_guest = FALSE AND email IS NOT NULL AND password_hash IS NOT NULL)
  OR
  (is_guest = TRUE AND email IS NULL AND password_hash IS NULL)
);

-- Uniqueness applies only to real accounts; guests all have a NULL email.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx ON users(email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_guest_expiry_idx ON users(expires_at) WHERE is_guest = TRUE;

-- Session ids are stored hashed: a leaked database dump must not yield usable
-- session tokens.
CREATE TABLE IF NOT EXISTS sessions (
  id_hash     TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

-- One row per user. `balance` is the authoritative, lockable counter; the
-- ledger below is the audit trail that must always reconcile to it.
CREATE TABLE IF NOT EXISTS credit_accounts (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance            INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  free_grant_issued  BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta           INTEGER NOT NULL,
  reason          TEXT NOT NULL,
  balance_after   INTEGER NOT NULL,
  note            TEXT,
  -- Lifecycle of a reservation row. Non-reservation rows are 'final'.
  -- The CHECK is added below as a named constraint so it stays re-runnable.
  state           TEXT NOT NULL DEFAULT 'final',
  -- On a refund row, the id of the reservation being reversed. The unique
  -- index below makes a second refund of the same reservation impossible at
  -- the database level, not merely unlikely.
  refund_of       TEXT,
  -- Set on reservation rows. The unique index below is what makes a retried
  -- analysis request idempotent instead of double-charging.
  idempotency_key TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Same reasoning as the users table: these arrived after the first release,
-- so an existing database needs them added explicitly.
ALTER TABLE credit_ledger ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'final';
ALTER TABLE credit_ledger ADD COLUMN IF NOT EXISTS refund_of TEXT;
ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_state_check;
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_state_check
  CHECK (state IN ('final', 'reserved', 'committed', 'refunded'));

CREATE INDEX IF NOT EXISTS credit_ledger_user_idx ON credit_ledger(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_idem_idx
  ON credit_ledger(user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_refund_once_idx
  ON credit_ledger(refund_of)
  WHERE refund_of IS NOT NULL;

CREATE TABLE IF NOT EXISTS datasets (
  id            TEXT PRIMARY KEY,
  user_id       TEXT REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('sample', 'upload')),
  -- Backend-generated storage path. Never derived from client input.
  storage_path  TEXT NOT NULL,
  row_count     INTEGER NOT NULL,
  column_count  INTEGER NOT NULL,
  size_bytes    BIGINT NOT NULL,
  -- Column schema + bounded sample values. No dataset rows are stored here.
  columns_json  TEXT NOT NULL,
  preview_json  TEXT NOT NULL,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS datasets_user_idx ON datasets(user_id);
CREATE INDEX IF NOT EXISTS datasets_expiry_idx ON datasets(expires_at);

CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_user_idx ON conversations(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question        TEXT NOT NULL,
  outcome         TEXT NOT NULL,
  answer          TEXT NOT NULL,
  sql             TEXT,
  chart_json      TEXT,
  result_json     TEXT,
  timings_json    TEXT NOT NULL DEFAULT '[]',
  total_ms        INTEGER NOT NULL DEFAULT 0,
  credit_consumed BOOLEAN NOT NULL DEFAULT FALSE,
  ai_mode         TEXT NOT NULL,
  usage_json      TEXT,
  simulated       BOOLEAN NOT NULL DEFAULT FALSE,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, created_at);

-- Idempotency for the analysis endpoint: the first request stores its response
-- here, and any retry with the same key replays it instead of re-charging.
CREATE TABLE IF NOT EXISTS idempotency_records (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('in_progress', 'complete')),
  response_json TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

