-- Migration 001: the whole PA#3 schema, copied from docs/ARCHITECTURE.md section 3.
-- The pragmas run on every connection (src/db/connection.ts), and the runner
-- (src/db/migrate.ts) creates schema_migrations itself, so neither is here.
-- Accounts and classes ------------------------------------------------------

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'ta', 'student')),
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Only the SHA-256 of a bearer token is stored, never the token.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE classes (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- TAs and students belong to classes; a lab belongs to one class.
CREATE TABLE class_members (
  class_id TEXT NOT NULL REFERENCES classes (id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  PRIMARY KEY (class_id, user_id)
);
CREATE INDEX idx_class_members_user ON class_members (user_id);

-- Labs, their tests and their constraints ----------------------------------

-- deadline is optional: NULL means no deadline, so a lab can be created with only a
-- statement, tests and constraints. CPU time per test is 1 to 5 s and memory is 64 to
-- 512 MB, the ranges of FAQ-05 (wall time is 3 times the CPU time, set by the worker).
CREATE TABLE labs (
  id              TEXT PRIMARY KEY,
  class_id        TEXT NOT NULL REFERENCES classes (id),
  title           TEXT NOT NULL,
  statement_md    TEXT NOT NULL,
  deadline        TEXT,
  time_limit_ms   INTEGER NOT NULL DEFAULT 1000 CHECK (time_limit_ms BETWEEN 1000 AND 5000),
  memory_limit_mb INTEGER NOT NULL DEFAULT 256 CHECK (memory_limit_mb BETWEEN 64 AND 512),
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'published')),
  created_by      TEXT NOT NULL REFERENCES users (id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_labs_class ON labs (class_id);

CREATE TABLE lab_tests (
  id              INTEGER PRIMARY KEY,
  lab_id          TEXT NOT NULL REFERENCES labs (id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  input           TEXT NOT NULL,
  expected_output TEXT NOT NULL,
  UNIQUE (lab_id, position)
);

-- kind is set by code when the TA saves the constraint: a text that starts with
-- "Do not use" or "Do not call" is a ban list, and the banned names are the
-- backticked names in the text. The deduction is the TA's number, never the model's.
CREATE TABLE lab_constraints (
  id           INTEGER PRIMARY KEY,
  lab_id       TEXT NOT NULL REFERENCES labs (id) ON DELETE CASCADE,
  code         TEXT NOT NULL,
  text         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('ban_list', 'semantic')),
  banned_names TEXT NOT NULL DEFAULT '[]',
  deduction    INTEGER NOT NULL CHECK (deduction >= 0),
  UNIQUE (lab_id, code),
  CHECK (kind = 'ban_list' OR banned_names = '[]')
);

-- Submissions, and the queue that judges them -------------------------------

-- judge_detail is JSON text: the compiler message for a compile_error, otherwise one entry
-- per test with its result and time, never the test input or output (FAQ-02).
-- Output over the limit is reported as runtime_error (our mapping of FAQ-05).
-- The submissions table is the queue. status is the state machine of the worker:
-- queued -> running -> judged, with running -> queued and running -> failed
-- when a lease runs out.
CREATE TABLE submissions (
  id           TEXT PRIMARY KEY,
  lab_id       TEXT NOT NULL REFERENCES labs (id),
  student_id   TEXT NOT NULL REFERENCES users (id),
  source_code  TEXT NOT NULL CHECK (length(source_code) <= 65536),
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'judged', 'failed')),
  judge_result TEXT CHECK (judge_result IN
                 ('accepted', 'wrong_answer', 'compile_error', 'runtime_error',
                  'time_limit', 'memory_limit')),
  judge_detail TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  locked_by    TEXT,
  lease_until  TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at   TEXT,
  finished_at  TEXT,
  CHECK ((status = 'running') = (locked_by IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((status = 'judged') = (judge_result IS NOT NULL))
);
CREATE INDEX idx_submissions_queue ON submissions (created_at) WHERE status IN ('queued', 'running');
CREATE INDEX idx_submissions_lab_student ON submissions (lab_id, student_id);
-- Publish counts the queued and running submissions of a lab.
CREATE INDEX idx_submissions_lab_status ON submissions (lab_id, status);
-- The limits on how fast a student can submit read this student's recent rows.
CREATE INDEX idx_submissions_student_created ON submissions (student_id, created_at);

-- Model calls, verdicts and the TA's review queue ---------------------------

-- One row per call to the model: what was sent and what it cost. No free text
-- from the model is kept; only whether its answer passed the schema check.
CREATE TABLE model_calls (
  id                INTEGER PRIMARY KEY,
  submission_id     TEXT NOT NULL REFERENCES submissions (id) ON DELETE CASCADE,
  constraint_id     INTEGER NOT NULL REFERENCES lab_constraints (id),
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  request_id        TEXT,
  prompt            TEXT NOT NULL,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  latency_ms        INTEGER NOT NULL,
  cost_usd          REAL NOT NULL DEFAULT 0,
  outcome           TEXT NOT NULL CHECK (outcome IN ('ok', 'timeout', 'schema_invalid', 'error')),
  error_detail      TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_model_calls_submission ON model_calls (submission_id);

-- One verdict per (submission, constraint). A verdict never carries a deduction.
-- evidence is a JSON array of {"line": n, "text": "..."} taken from the original source.
CREATE TABLE verdicts (
  id            INTEGER PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions (id) ON DELETE CASCADE,
  constraint_id INTEGER NOT NULL REFERENCES lab_constraints (id),
  verdict       TEXT NOT NULL CHECK (verdict IN ('pass', 'violation', 'unsure')),
  decided_by    TEXT NOT NULL CHECK (decided_by IN ('hard_rule', 'model', 'fallback')),
  reason_code   TEXT CHECK (reason_code IN ('model_off', 'timeout', 'schema_invalid', 'model_error',
                                          'evidence_mismatch', 'cost_cap', 'rule_error')),
  evidence      TEXT NOT NULL DEFAULT '[]',
  model_call_id INTEGER REFERENCES model_calls (id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (submission_id, constraint_id),
  CHECK (verdict <> 'violation' OR evidence <> '[]'),
  CHECK ((decided_by = 'fallback') = (reason_code IS NOT NULL))
);

-- The verdicts that need the TA's decision. Every violation, every unsure and a sample of
-- the passes get an item. The queue view lists every verdict of the lab and marks these
-- items. Verdicts reach nobody else. The TA ends an item with a final verdict, pass or
-- violation, never unsure (FAQ-09); a violation needs at least one evidence line.
-- There is no deduction here: it comes from lab_constraints (FAQ-11).
CREATE TABLE review_items (
  id          INTEGER PRIMARY KEY,
  verdict_id  INTEGER NOT NULL UNIQUE REFERENCES verdicts (id) ON DELETE CASCADE,
  lab_id      TEXT NOT NULL REFERENCES labs (id),
  reason      TEXT NOT NULL CHECK (reason IN ('violation', 'unsure', 'sample')),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed')),
  final_verdict  TEXT CHECK (final_verdict IN ('pass', 'violation')),
  final_evidence TEXT,
  note        TEXT,
  reviewed_by TEXT REFERENCES users (id),
  reviewed_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((status = 'reviewed') = (final_verdict IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
  CHECK (final_verdict IS NOT 'violation' OR (final_evidence IS NOT NULL AND final_evidence <> '[]'))
);
CREATE INDEX idx_review_items_lab_status ON review_items (lab_id, status);

-- Publishing ----------------------------------------------------------------

-- At most one publication per lab: the primary key is the lab.
CREATE TABLE publications (
  lab_id          TEXT PRIMARY KEY REFERENCES labs (id),
  published_at    TEXT NOT NULL,
  published_by    TEXT NOT NULL REFERENCES users (id),
  marks_published INTEGER NOT NULL CHECK (marks_published >= 0),
  note            TEXT
);

-- Idempotency keys of POST /labs/{labId}/publish, scoped to (caller, lab).
-- Only 2xx answers are stored; rows are kept at least 24 hours.
CREATE TABLE idempotency_keys (
  user_id    TEXT NOT NULL REFERENCES users (id),
  lab_id     TEXT NOT NULL REFERENCES labs (id),
  idem_key   TEXT NOT NULL,
  body_hash  TEXT NOT NULL,
  status     INTEGER NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, lab_id, idem_key)
);
