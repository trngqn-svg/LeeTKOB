# LeeTKOB architecture

This document describes how LeeTKOB is built: the processes, the SQLite schema, the worker queue, the judging pipeline and the HTTP API. It is the design for PA#3. Most of it is **not built yet**: today the repository has the API skeleton (`GET /health` and `POST /labs/{labId}/publish`) and an in-memory store. Every part below is marked (built) or (planned) so that the plan is not mistaken for the code.

Where this document and a file in `docs/contract/` disagree, the contract wins. The rule in `AGENTS.md` is that behaviour is defined contract-first, in its own commit, before the code and the tests. Every endpoint below that is not built needs its own contract file before it is implemented.

Related files: the pictures of the system (C4 levels 1 and 2) are in `docs/c4/`, the publish contract is `docs/contract/publish-lab.md`, and what the coding assistant may do is in `docs/PERMISSIONS.md`.

## 1. Principles

These come from the class brief (sections 3 and 5) and from `AGENTS.md`. The design below exists to make each of them hard to break.

- Hard rules decide the ban-list constraints. When a hard rule decides a constraint, the model is not called for it.
- The model judges only the semantic constraints. It returns `pass`, `violation` or `unsure` with evidence lines, and nothing else. It never sets a deduction: the TA sets it when the lab is created.
- Verdicts are visible in one place only, the TA's review queue. A student sees the judge result of a submission, never a verdict. Nothing in this build turns a verdict into a published mark.
- Publish refuses while any review is pending.
- Student code runs only in the sandbox. The sandbox has no network, no secrets, no host mounts and no Docker socket.
- The model receives the statement, one constraint, and the code without comments or identity. Nothing else.
- An answer from the model that fails the schema, or does not arrive in time, becomes `unsure`.
- Every error is `application/problem+json`, sent through `sendProblem`.

## 2. System architecture

### 2.1 Components

| Component       | Status       | Responsibility                                                                                                                                        | Talks to                          |
| --------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| API server      | partly built | Accounts and roles, labs, submissions, the review queue and Publish. Writes jobs into the database. Never runs student code and has no Docker access. | Database                          |
| Database        | planned      | One SQLite file in WAL mode. Holds accounts, labs, the job queue, verdicts, review items, publications and idempotency keys.                          | API server, judge worker          |
| Judge worker    | planned      | A separate process. Claims a queued submission, runs the judging pipeline and stores the verdicts in one transaction.                                 | Database, sandbox, model provider |
| Sandbox         | planned      | One short-lived Docker container per run. Compiles and runs student code with the nine minimums of the brief.                                         | Judge worker, through docker run  |
| Checker command | planned      | One command: a dataset folder in, a predictions file out. Same hard rules and model client as the worker, no database.                                | Model provider, dataset folder    |
| Model provider  | external     | Google Gemini API. Judges the semantic constraints and returns pass, violation or unsure with evidence lines.                                         | Judge worker, checker command     |

### 2.2 Source layout (proposed)

```text
src/
  server.ts            API entry point (built)
  app.ts               Fastify app factory (built)
  problems.ts          problem+json types and sendProblem (built)
  store.ts             in-memory store (built, replaced by db/)
  routes/              one file per endpoint group (health and publish built)
  db/                  connection, schema.sql, migrations, queries
  worker.ts            judge worker entry point
  judge/
    pipeline.ts        judges one claimed submission
    sandbox.ts         wraps docker run
    hard-rules.ts      syntax-aware ban-list rules
    model.ts           ModelClient interface, real client, fake client for tests
    guardrails.ts      schema check, timeout, mapping evidence to original lines
  checker/
    cli.ts             dataset folder in, predictions file out
```

`judge/hard-rules.ts`, `judge/model.ts` and `judge/guardrails.ts` are shared by the worker and the checker, so the checker that the lecturer runs behaves like the product.

### 2.3 Runtime and trust boundaries

- One host with Docker runs everything. The API and the worker are two processes (for example two containers of one image) that open the same SQLite file on a shared volume.
- Only the worker can reach Docker, because it starts the sandbox containers. The API has no Docker access. The sandbox containers are not given the Docker socket.
- The model API key exists only in the environment of the worker and the checker. It is never passed to the sandbox, never put in a prompt and never committed.
- Student code is untrusted. It is compiled and run only inside the sandbox, and its output is read as data.
- Prompts treat the student's code as data: it is delimited, and the model's answer must pass a strict schema, so an instruction hidden in a comment or a string cannot add a field or set a deduction.
- The API reads and writes the database only through short transactions. Reads followed by writes use `BEGIN IMMEDIATE`, so two processes cannot interleave a check and an update.

### 2.4 Configuration

| Variable           | Used by                  | Status          | Meaning                                                                           |
| ------------------ | ------------------------ | --------------- | --------------------------------------------------------------------------------- |
| `PORT`             | API server               | built           | Listen port. Default 3000.                                                        |
| `HOST`             | API server               | built           | Listen address. Default 127.0.0.1.                                                |
| `DB_PATH`          | API server, judge worker | planned         | Path of the SQLite file. It must be on a volume that both processes can open.     |
| `LLM_API_KEY`      | judge worker, checker    | in .env.example | Model API key. Never passed to the sandbox.                                       |
| `LLM_MODEL`        | judge worker, checker    | in .env.example | Model name. Not chosen yet.                                                       |
| `MODEL_OFF`        | judge worker, checker    | planned         | `1` means no model call and no network: every semantic constraint becomes unsure. |
| `MODEL_TIMEOUT_MS` | judge worker, checker    | planned         | Time one model call may take. Default 20000.                                      |
| `WORKER_ID`        | judge worker             | planned         | Written to `locked_by`, so a worker can tell its own jobs.                        |
| `LEASE_SECONDS`    | judge worker             | planned         | How long a claim lasts without a heartbeat. Default 60.                           |
| `MAX_ATTEMPTS`     | judge worker             | planned         | Claims before a submission is marked failed. Default 3.                           |
| `SANDBOX_IMAGE`    | judge worker             | planned         | Docker image with g++ used for every run.                                         |

The defaults are proposals. `.env.example` lists the variables without values. Real values live only in `.env` (git-ignored) and in CI secrets.

## 3. SQLite schema

The schema below is the whole database. Notes on how it is meant to be read:

- Ids that clients see (labs, submissions, users) are opaque text, for example UUIDs. Internal rows use integer ids.
- Timestamps are ISO 8601 UTC text, so they sort and compare as text.
- Lists (`banned_names`, `evidence`) are JSON text. The API parses them; SQL does not need to.
- The database enforces the rules that must never be broken, so a bug in the code cannot store them: a violation always has evidence, a verdict that fell back always has a reason, one verdict per submission and constraint, one publication per lab, a running submission always has a lock.
- `submissions` is the queue. There is no separate jobs table, so creating a submission and queueing it is one insert.
- A verdict has no deduction column. The deduction is `lab_constraints.deduction`, set by the TA, and `review_items.deduction` is what the TA applies after reviewing.
- No free text from the model is stored. `model_calls` keeps what was sent, the provider's request id, the cost and whether the answer passed the schema check.

```sql
-- LeeTKOB database schema (SQLite). Timestamps are ISO 8601 UTC text, so they sort as text.
-- Every connection runs these three pragmas first.
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

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

CREATE TABLE labs (
  id              TEXT PRIMARY KEY,
  class_id        TEXT NOT NULL REFERENCES classes (id),
  title           TEXT NOT NULL,
  statement_md    TEXT NOT NULL,
  time_limit_ms   INTEGER NOT NULL DEFAULT 2000 CHECK (time_limit_ms BETWEEN 100 AND 10000),
  memory_limit_mb INTEGER NOT NULL DEFAULT 256 CHECK (memory_limit_mb BETWEEN 16 AND 1024),
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
                  'time_limit', 'memory_limit', 'output_limit')),
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
  reason_code   TEXT CHECK (reason_code IN ('model_off', 'timeout', 'schema_invalid', 'model_error')),
  evidence      TEXT NOT NULL DEFAULT '[]',
  model_call_id INTEGER REFERENCES model_calls (id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (submission_id, constraint_id),
  CHECK (verdict <> 'violation' OR evidence <> '[]'),
  CHECK ((decided_by = 'fallback') = (reason_code IS NOT NULL))
);

-- The TA's review queue. Every violation, every unsure and a sample of the
-- passes get an item. Verdicts reach nobody else.
CREATE TABLE review_items (
  id          INTEGER PRIMARY KEY,
  verdict_id  INTEGER NOT NULL UNIQUE REFERENCES verdicts (id) ON DELETE CASCADE,
  lab_id      TEXT NOT NULL REFERENCES labs (id),
  reason      TEXT NOT NULL CHECK (reason IN ('violation', 'unsure', 'sample')),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed')),
  decision    TEXT CHECK (decision IN ('confirm', 'dismiss')),
  deduction   INTEGER CHECK (deduction >= 0),
  note        TEXT,
  reviewed_by TEXT REFERENCES users (id),
  reviewed_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((status = 'reviewed') = (decision IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
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
```

How today's in-memory store (`src/store.ts`) maps to the tables:

| Today (`src/store.ts`)            | Becomes                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| `User.token`                      | `sessions.token_hash`, the SHA-256 of the token                                        |
| `User.role`                       | `users.role`                                                                           |
| `User.classIds`                   | `class_members`                                                                        |
| `Lab.pendingReviews`, a number    | The count of `review_items` with status `pending` for the lab                          |
| `Lab.judgedSubmissions`, a number | The count of judged submissions of the lab, copied into `publications.marks_published` |
| `Lab.publication`                 | One row of `publications`                                                              |
| The idempotency map               | `idempotency_keys`                                                                     |

How this schema was checked: the file above was loaded into an in-memory SQLite (`node:sqlite` on Node 24.9) and exercised with 21 assertions: claim, lease expiry, reclaim, a stale worker finishing late, exactly-once verdicts, giving up after three attempts, and the constraints that must refuse bad rows. Those checks are not in the repository, and CI runs Node 22, which has not been tried. The behaviour has to be covered by tests written first (section 8). The statements use `RETURNING` and partial indexes, so they need SQLite 3.35 or later.

## 4. Worker queue state machine

The `status` column of `submissions` is the state machine. Only the worker moves a submission after it is created.

```mermaid
stateDiagram-v2
    [*] --> queued: student submits
    queued --> running: worker claims it, lease starts
    running --> running: heartbeat extends the lease
    running --> judged: guarded finish
    running --> queued: lease expired, attempts left
    running --> failed: lease expired, no attempts left
    judged --> [*]
    failed --> [*]
```

States:

| State     | Meaning                                                                                             | Who sets it                                                                             |
| --------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `queued`  | Waiting for a worker.                                                                               | The API, when the submission is created. The worker, when it reclaims an expired lease. |
| `running` | A worker holds a lease (`locked_by`, `lease_until`) and is judging it.                              | The worker, by claiming.                                                                |
| `judged`  | Judging is done and `judge_result` is set. If it was accepted, its verdicts and review items exist. | The worker, by the guarded finish.                                                      |
| `failed`  | The leases ran out `MAX_ATTEMPTS` times. A failure of the system, not of the student.               | The worker, when a claim step finds it.                                                 |

Transitions:

| From      | To        | Trigger                                       | Guard                                                 | Effect                                                                         |
| --------- | --------- | --------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| (new)     | `queued`  | A student submits.                            | The lab is open and the student is in its class.      | Row inserted.                                                                  |
| `queued`  | `running` | A worker claims the oldest queued row.        | `status` is `queued`.                                 | `attempts` + 1. `locked_by`, `lease_until` and `started_at` set.               |
| `running` | `running` | Heartbeat, every quarter of the lease.        | `locked_by` is this worker and `status` is `running`. | `lease_until` moved forward.                                                   |
| `running` | `judged`  | The pipeline finished.                        | `locked_by` is this worker and `status` is `running`. | `judge_result` set. Verdicts and review items written in the same transaction. |
| `running` | `queued`  | A claim step finds `lease_until` in the past. | `attempts` is below `MAX_ATTEMPTS`.                   | `locked_by` and `lease_until` cleared.                                         |
| `running` | `failed`  | A claim step finds `lease_until` in the past. | `attempts` is at `MAX_ATTEMPTS` or more.              | `finished_at` set. `locked_by` and `lease_until` cleared.                      |

### 4.1 The statements

Every claim step runs these three statements, in this order. Reclaiming first means a crashed worker's job can be taken in the same step.

```sql
-- 1. Give up on jobs whose lease ran out too many times.
UPDATE submissions
   SET status = 'failed', locked_by = NULL, lease_until = NULL, finished_at = :now
 WHERE status = 'running' AND lease_until < :now AND attempts >= :max_attempts;

-- 2. Put back jobs whose lease ran out.
UPDATE submissions
   SET status = 'queued', locked_by = NULL, lease_until = NULL
 WHERE status = 'running' AND lease_until < :now AND attempts < :max_attempts;

-- 3. Claim the oldest queued job. One statement, so two workers cannot take the same one.
UPDATE submissions
   SET status = 'running', locked_by = :worker, lease_until = :lease_until,
       attempts = attempts + 1, started_at = COALESCE(started_at, :now)
 WHERE id = (SELECT id FROM submissions WHERE status = 'queued' ORDER BY created_at LIMIT 1)
RETURNING id, lab_id, source_code;
```

While it judges, the worker extends the lease. If this changes no row, the worker has lost the job and must drop its work without writing anything.

```sql
UPDATE submissions SET lease_until = :lease_until
 WHERE id = :id AND status = 'running' AND locked_by = :worker;
```

The finish is one transaction, guarded by the lock. This is what makes the verdicts exactly-once:

```sql
BEGIN IMMEDIATE;

UPDATE submissions
   SET status = 'judged', judge_result = :result, judge_detail = :detail,
       finished_at = :now, locked_by = NULL, lease_until = NULL
 WHERE id = :id AND status = 'running' AND locked_by = :worker;
-- If this changed 0 rows, this worker lost the lease: ROLLBACK and write nothing.

INSERT INTO verdicts (submission_id, constraint_id, verdict, decided_by, reason_code, evidence, model_call_id)
VALUES (:id, :constraint_id, :verdict, :decided_by, :reason_code, :evidence, :model_call_id)
ON CONFLICT (submission_id, constraint_id) DO NOTHING;
-- One INSERT per constraint, only when the submission was accepted.

INSERT INTO review_items (verdict_id, lab_id, reason)
SELECT id, :lab_id, verdict FROM verdicts
 WHERE submission_id = :id AND verdict IN ('violation', 'unsure')
ON CONFLICT (verdict_id) DO NOTHING;
-- A sample of the passes gets an item with reason 'sample' (section 7).

COMMIT;
```

### 4.2 Rules and crash cases

- **Exactly once.** Two things protect the verdicts. The guarded `UPDATE` lets only the worker that holds the lease finish, and the unique key on `(submission_id, constraint_id)` refuses a second verdict. So even if a job is judged twice, one set of verdicts is stored.
- **Stop the worker, submit, start the worker.** The submission stays `queued`. The first claim after the restart takes it, and it is judged once.
- **A worker dies in the middle.** Its lease runs out. The next claim step puts the job back to `queued` (attempt 2), and another claim takes it. The dead worker's late write, if it ever comes, is refused by the guard.
- **A job that always crashes the worker.** After `MAX_ATTEMPTS` claims with a lease that ran out, it becomes `failed`. It is not retried forever, and the student sees that the system failed, not that the code was wrong.
- **Lease length.** The lease is longer than any single step (the compile limit, one test limit, one model timeout), and the worker extends it with a heartbeat while it works.
- **Review items and labs have their own small states.** A review item goes from `pending` to `reviewed`, once, by a TA. A lab goes from `open` to `published`, once, by Publish.
- **Publish reads the queue.** The pending count that Publish checks is `SELECT COUNT(*) FROM review_items WHERE lab_id = :lab AND status = 'pending'`. It replaces the plain number `pendingReviews` of the in-memory store.

## 5. Judging pipeline

The worker runs this for one claimed submission. The checker command runs steps 5 to 7 on a dataset folder, without the database.

```mermaid
flowchart TD
    A["Claim a queued submission<br>(worker, lease)"] --> B["Load the lab:<br>statement, tests, constraints"]
    B --> C["Sandbox: compile and run every test<br>(no network, limits, non-root)"]
    C --> D{"All tests passed?"}
    D -- "no" --> E["judge_result: compile_error, wrong_answer,<br>time_limit and so on"]
    E --> P2["Finish: guarded update only<br>No verdicts, no review items"]
    D -- "yes, accepted" --> F["For each constraint of the lab"]
    F --> G{"Constraint kind?"}
    G -- "ban_list" --> H["Hard rule: syntax-aware check<br>pass or violation with evidence<br>The model is NOT called"]
    G -- "semantic" --> I{"MODEL_OFF=1?"}
    I -- "yes" --> J["unsure (model_off)"]
    I -- "no" --> K["Prompt: statement, this constraint,<br>code without comments or identity"]
    K --> L["Model call with a timeout"]
    L --> M{"Answer valid?<br>schema and in time"}
    M -- "yes" --> N["Model verdict: pass, violation<br>or unsure, with evidence lines"]
    M -- "no" --> O["unsure (timeout, schema_invalid, model_error)"]
    H --> P["Finish in one transaction:<br>guarded update, verdicts, review items"]
    J --> P
    N --> P
    O --> P
    P --> Q["TA's review queue"]
```

### 5.1 Steps

- **Step 1, claim.** The worker claims a queued submission (section 4).
- **Step 2, load the lab.** The statement, the tests and the constraints of the lab. Each constraint has a `kind`, set by code when the TA saved it: a text that starts with "Do not use" or "Do not call" is `ban_list`, and its banned names are the backticked names in the text. Anything else is `semantic`.
- **Step 3, sandbox.** The code is compiled inside the sandbox (`g++ -std=c++17 -O2`, the flags the dev set uses) and run on every test. Output is compared token by token, ignoring whitespace. The outcome is one `judge_result`: `accepted`, `wrong_answer`, `compile_error`, `runtime_error`, `time_limit`, `memory_limit` or `output_limit`.
- **Step 4, not accepted.** The worker finishes with the `judge_result` and writes no verdict and no review item. The student sees the result. Only Accepted submissions are reviewed.
- **Step 5, ban-list constraints.** `judge/hard-rules.ts` reads the code with a syntax-aware check, not a text search, and returns `pass` or `violation` with the original source lines as evidence. A banned name inside a comment or a string does not count. A function of the student's own named `sort` does not count. `<algorithm>` included only for `std::swap` does not count. The model is not called, and the verdict has `decided_by = 'hard_rule'`. How the code is parsed (a real C++ parser or a tokenizer) is not decided yet (section 7).
- **Step 6, semantic constraints.** If `MODEL_OFF=1`, the verdict is `unsure` with reason `model_off`. Otherwise the pipeline builds a prompt and calls the model with a timeout. Every call is written to `model_calls`, also when it fails.
- **Step 7, guardrails.** The answer must match the schema: a verdict of `pass`, `violation` or `unsure`, and a list of evidence lines, each with a line number and text. Any other key is refused, so the model cannot add a deduction. A `violation` without evidence is refused. A refused answer, a timeout or a provider error gives `unsure` with reason `schema_invalid`, `timeout` or `model_error`, and `decided_by = 'fallback'`.
- **Step 8, finish.** One transaction (section 4.1) records the `judge_result`, the verdicts and the review items. A violation and an unsure always get a review item. A sample of the passes gets one too.
- **Step 9, who sees what.** The student sees `status` and `judge_result`. The TA sees the review queue. The marks do not change until the TA reviews every item and presses Publish.

### 5.2 What the model receives

A prompt for one semantic constraint holds exactly three things: the lab statement, that one constraint, and the code with its comments removed. The comments are blanked but the line breaks are kept, so line numbers stay the same and each evidence line can be mapped back to the original text. The student's name, id and email are never in the prompt, and neither is anything from the dev set. The text of the prompt is stored in `model_calls.prompt`, so anyone can check this.

### 5.3 The checker command

The checker takes a dataset folder (`problems/<id>/statement.md`, `constraints.json`, and `solutions/<id>/<name>.cpp`) and writes one JSON line per solution and constraint:

```text
{"solution":"sort-merge/s03","constraint":"C1","verdict":"violation","evidence":[{"line":12,"text":"std::sort(a, a + n);"}]}
```

It works from `statement.md` and `constraints.json` alone, so a held-out problem needs no per-problem setting. With `MODEL_OFF=1` it runs the hard rules only, writes `unsure` for every semantic constraint and opens no network connection. It is packaged with a Dockerfile, and `eval.mjs` from the lecturer scores its output.

### 5.4 Limits to settle

These are proposals and are not final: compile limit 10 s, one test limit set by the lab (default 2 s), one model call 20 s, lease 60 s with a heartbeat every 15 s, at most 3 attempts, and source code up to 64 KiB.

## 6. API endpoints

### 6.1 Conventions

- Authentication is `Authorization: Bearer <token>`. A missing or unknown token is `unauthenticated` (401). Login (planned) issues the token.
- Bodies are JSON. Every error is `application/problem+json` with a `type` under `https://leetkob.example/problems/`. Clients branch on `type`, not on `detail`.
- A TA or student who is not in a lab's class gets `lab-not-found` (404), the same answer as for a lab that does not exist, so ids of other classes do not leak. This is the rule of the publish contract, and it applies to every endpoint that takes a lab id.
- The order of checks of the publish contract is the model for the others: media type and JSON syntax, then authentication, then role, then existence and ownership, then the rest.
- Each endpoint that is not built gets `docs/contract/<endpoint>.md` first. The shapes below are proposals, and the contract file defines them.

### 6.2 Endpoints

| Method and path                           | Who may call it                            | Purpose                                                               | Status              |
| ----------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------- | ------------------- |
| `GET /health`                             | Anyone                                     | Liveness probe.                                                       | built               |
| `POST /auth/login`                        | Anyone                                     | Exchange an email and a password for a bearer token.                  | planned             |
| `POST /users`                             | Admin                                      | Create an account.                                                    | planned             |
| `POST /classes`                           | Admin                                      | Create a class.                                                       | planned             |
| `PUT /classes/{classId}/members/{userId}` | Admin                                      | Put a TA or a student in a class.                                     | planned             |
| `POST /classes/{classId}/labs`            | TA of the class                            | Create a lab with its tests and constraints.                          | planned             |
| `GET /labs/{labId}`                       | TA or student of the class                 | Read the lab. The TA also gets the tests and constraints.             | planned             |
| `POST /labs/{labId}/submissions`          | Student of the class                       | Submit C++ source. Answers 202 with a queued submission.              | planned             |
| `GET /submissions/{submissionId}`         | The student who submitted, TA of the class | Status, judge result and detail. Never a verdict.                     | planned             |
| `GET /labs/{labId}/review-queue`          | TA of the class                            | List the review items with verdict, evidence and deduction.           | planned             |
| `POST /review-items/{itemId}/decision`    | TA of the class                            | Confirm or dismiss one verdict.                                       | planned             |
| `POST /labs/{labId}/publish`              | TA of the class                            | Publish the marks once every review is done. Defined by its contract. | built, on a counter |

### 6.3 Notes on the planned endpoints

- `POST /auth/login`: body `email` and `password`. Answer 200 with `token`, `expiresAt` and the user. Only the SHA-256 of the token is stored. Wrong credentials give 401.
- `POST /users` and `POST /classes`: admin only. They are how the test accounts of `PA3.md` are created (one admin, two TAs in two classes, two students in the first TA's class).
- `POST /classes/{classId}/labs`: body `title`, `statementMd`, optional `timeLimitMs` and `memoryLimitMb`, a list of `tests` (`input`, `expectedOutput`) and a list of `constraints` (`text`, `deduction`). The answer lists each constraint with its `code`, its `kind` and its `bannedNames`, so the TA sees how the text was understood.
- `POST /labs/{labId}/submissions`: body `sourceCode`. The answer is 202 with a `submissionId` and `status` `queued`. The request returns before judging; the student polls the submission. Code over the size limit is refused with 413.
- `GET /submissions/{submissionId}`: `status`, `judgeResult` and `judgeDetail` (for example the first compiler error). It never contains a verdict, evidence or a model answer.
- `GET /labs/{labId}/review-queue`: optional `status` filter (`pending` by default). Each item has the submission id, the constraint (`code`, `text`, `deduction`), the verdict, the evidence lines, the reason (`violation`, `unsure` or `sample`) and its status. It is the only place a verdict can be read.
- `POST /review-items/{itemId}/decision`: body `decision` (`confirm` or `dismiss`), optional `note`. A confirmed violation applies the constraint's deduction unless the TA gives another number. After the lab is published the items are read-only, so the call is refused.
- `POST /labs/{labId}/publish`: defined by its contract. Once the review queue exists, its pending count comes from the queue, not from a number.

### 6.4 Who can see what

| Data                                  | TA of the class     | Student of the class        | Anyone else         |
| ------------------------------------- | ------------------- | --------------------------- | ------------------- |
| Lab statement and limits              | Read                | Read                        | Nothing (404)       |
| Tests and constraints with deductions | Read and write      | Not decided (see section 7) | Nothing (404)       |
| Submission source code                | Read                | Own submissions only        | Nothing (404)       |
| Judge result                          | Read                | Own submissions only        | Nothing (404)       |
| Verdicts, evidence and review items   | Read and decide     | Never                       | Nothing (404)       |
| Model call log                        | Not through the API | Not through the API         | Not through the API |

An admin manages accounts and classes and has no access to labs, submissions or verdicts.

### 6.5 Problem types

The types that exist in `src/problems.ts`:

| Type                      | Status | Title                                        |
| ------------------------- | ------ | -------------------------------------------- |
| `unsupported-media-type`  | 415    | Unsupported media type                       |
| `validation-failed`       | 422    | Request body is invalid                      |
| `unauthenticated`         | 401    | Authentication required                      |
| `forbidden-role`          | 403    | Only TAs may publish marks                   |
| `lab-not-found`           | 404    | Lab not found                                |
| `invalid-idempotency-key` | 400    | Idempotency-Key is missing or invalid        |
| `idempotency-key-reused`  | 422    | Idempotency-Key reused with a different body |
| `reviews-pending`         | 409    | Reviews are still pending                    |
| `internal`                | 500    | Internal server error                        |

The new endpoints will need more types, for example for wrong login credentials, a source file that is too large, and a lab that is already published. Each is named, with its fixed title and status, in the contract of the endpoint that uses it.

## 7. Open points

- **Publish and unjudged submissions.** The publish contract counts review items. A submission that is still `queued` or `running` has no review item yet, so a lab could be published while an Accepted submission has not been reviewed. The contract should count those submissions as pending too. That is a change to `docs/contract/publish-lab.md`, in its own commit first.
- **Titles are fixed per problem type.** `forbidden-role` is titled "Only TAs may publish marks", so the endpoints that only an admin or only a student may call need their own role types, or a more general title decided in a contract-first commit.
- **What a student may see.** Whether a student sees the constraints before submitting, or the evidence after publishing, is a product-owner question (brief section 8). Ask in the pinned post and cite the FAQ entry here once it is answered.
- **Sampling the passes.** The brief sends a random 10% of the pass verdicts to the review queue. The PA#3 rubric does not require it. The schema has the reason `sample`; the sampling itself can be added last.
- **Guardrails of PA#4.** Checking that every evidence line matches the submitted code exactly, and a cost cap per lab, are PA#4. The schema already keeps one evidence list per verdict and `cost_usd` per call, so they need no new tables.
- **Choices not made yet.** The database (SQLite is the proposal, Postgres would change the schema file only), how the hard rules read C++ (a parser such as tree-sitter, or a tokenizer), where the system is hosted (it needs Docker and must stay up until the PA#4 marks are out), and the model.
- **Not designed.** Deleting idempotency keys after 24 hours, deleting expired sessions, and requeueing a `failed` submission by hand.

## 8. Tests that prove the design

Tests land before, or in the same commit as, the code they test, one part per commit.

- Sandbox: one attack submission for each of the nine minimums, run in CI on the tag.
- Queue: stop the worker, submit, start the worker, and check that one set of verdicts exists. Also a stale worker that finishes after its lease ran out, which must write nothing.
- Hard rules: the traps (own `sort`, a banned name in a comment or a string, `<algorithm>` only for `std::swap`) must not fire, and the plain and disguised violations must.
- Model call: a fake model that returns bad JSON, an extra key, or nothing in time, each of which must give `unsure`. No test uses the real model.
- Review queue: Publish refuses while an item is pending, and a student request never returns a verdict.
- Isolation: a TA of another class gets `lab-not-found` for the lab and for its queue.
- Dev set: the SHA-256 of `eval.mjs` and `labels.jsonl` is pinned, so an edit turns CI red.
