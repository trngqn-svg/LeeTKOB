# LeeTKOB

Constraint review for introductory C++ labs (CSC13114, class 2609-AWAD-23/3). An
Accepted submission goes through hard rules, then a model. The verdicts land in the
TA's review queue, and marks are published only after the TA presses **Publish**.

PA#2 status: harness, quality gate, and the first contracted endpoint,
[`POST /labs/{labId}/publish`](docs/contract/publish-lab.md).

## Quick start

Requires Node 22+.

```sh
git clone https://github.com/trngqn-svg/LeeTKOB.git
cd LeeTKOB
npm ci
cp .env.example .env   # fill in values; .env is git-ignored
```

## Folder structure

What each folder and file is for. Whoever adds, moves or deletes a file updates this tree in the same commit (`AGENTS.md`, "Conventions").

```text
LeeTKOB/
├── .github/workflows/ci.yml   # CI: lint, format, typecheck, tests and the gitleaks scan
├── .claude/settings.json      # What Claude Code may run, must ask for, or never does here
├── .dockerignore              # Lets only package*.json, tsconfig.json and src/ into the app image
├── .env.example               # Every environment variable, without values
├── .gitattributes             # LF line endings for every text file; PNGs are binary
├── .gitignore                 # Files git never tracks (.env, data/, node_modules/)
├── .prettierignore            # Files Prettier skips (leetkob-eval/, package-lock.json)
├── AGENTS.md                  # Rules for coding assistants (CLAUDE.md imports it)
├── AI-LOG.md                  # Every use of an AI tool: asked, kept, changed, rejected
├── CLAUDE.md                  # Imports AGENTS.md for Claude Code
├── PA2.md                     # What was handed in for PA#2
├── PA3.md                     # What is handed in for PA#3: URL, accounts, video, CI, eval runs
├── SELF_ASSESSMENT_REPORT.md  # The team's self-assessment of the current PA (PA#3; git history keeps PA#2)
├── eslint.config.js           # ESLint 9 and typescript-eslint settings
├── package.json               # Scripts and dependencies (package-lock.json pins them)
├── tsconfig.json              # TypeScript strict settings for src/ and tests/
├── deploy/
│   ├── compose.yaml           # The deployment: Caddy, the API and the worker on the VM
│   ├── Caddyfile              # HTTPS for the public name, forwarded to the API
│   └── leetkob.env.example    # What the root-only settings file on the VM holds
├── docker/
│   ├── app/Dockerfile         # The app image, for the API and the worker
│   ├── checker/Dockerfile     # The constraint checker image (MODEL_OFF=1 / --network none)
│   └── sandbox/Dockerfile     # The sandbox image: g++ and the non-root user 10001, nothing else
├── docs/
│   ├── ARCHITECTURE.md        # The design: schema, queue state machine, pipeline, endpoints
│   ├── DECISIONS.md           # Each architecture decision, why, and its trade-offs
│   ├── DEPLOYMENT.md          # The Azure VM and how the app is deployed on it
│   ├── PERMISSIONS.md         # What the assistant may do without asking
│   ├── RECONSIDERATION.md     # The decisions reviewed again, with the planned spikes
│   ├── SWAGGER-PLAN.md        # Plan for a Swagger UI page of the API, for the demo
│   ├── TASKS.md               # Who does what for PA#3, and the timeline
│   ├── c4/                    # C4 diagrams: system context (C1) and containers (C2)
│   ├── contract/              # One file per endpoint: the behaviour the tests copy
│   ├── pa2/                   # Screenshots of the branch protection for PA#2
│   └── swagger/               # Static Swagger UI page and OpenAPI 3.0.3 spec for the demo
│       ├── index.html         # Swagger UI page (pinned cdnjs assets with SRI, no inline script)
│       ├── init.js            # Starts Swagger UI on openapi.json
│       └── openapi.json       # Hand-written OpenAPI 3.0.3 spec matching docs/contract/
├── eval-own/                  # Team's own 5 eval cases (power-mod: clean, trap, obvious, disguised, injection)
├── eval-runs/                 # Committed real model eval outputs (predictions, call logs with request ids, reports)
├── leetkob-eval/              # The lecturer's dev set and eval.mjs. Never edit it
├── src/
│   ├── server.ts              # Starts the API: opens the database, listens on PORT
│   ├── app.ts                 # Builds the Fastify app: error handler and routes
│   ├── auth.ts                # Reads the Bearer token; checks class membership
│   ├── password.ts            # scrypt hashing and checking of passwords
│   ├── problems.ts            # Every RFC 9457 problem type, and sendProblem
│   ├── store.ts               # The PA#2 in-memory store; now it only carries the clock
│   ├── worker.ts              # The judge worker loop: claim, sandbox, pipeline, finish
│   ├── worker-config.ts       # Reads and checks the worker's environment variables
│   ├── worker-main.ts         # npm run worker: the worker process
│   ├── checker/
│   │   ├── cli.ts             # npm run checker: dataset folder in, JSONL predictions and call log out
│   │   └── eval-gate.ts       # Runs eval.mjs and fails on exit 2 or any wrongful deduction
│   ├── db/
│   │   ├── connection.ts      # Opens SQLite with the three pragmas
│   │   ├── migrate.ts         # Applies the pending migrations in order
│   │   ├── migrations/        # One .sql file per schema change (001 is the whole schema)
│   │   ├── cli.ts             # npm run db:migrate and npm run db:seed
│   │   ├── seed.ts            # The test accounts and classes
│   │   └── queue.ts           # The queue statements: claim, heartbeat, release, finish
│   ├── judge/
│   │   ├── types.ts           # Shared types: constraint, verdict, model client, sandbox
│   │   ├── sandbox.ts         # Compiles and runs a submission in Docker, with the nine minimums
│   │   ├── constraints.ts     # Reads a constraint's text: ban list or semantic
│   │   ├── hard-rules.ts      # Syntax-aware C++ ban-list checker (web-tree-sitter)
│   │   ├── guardrails.ts      # Comment stripping, prompt builder, schema and evidence checks
│   │   ├── model.ts           # Gemini API model client and fake client for tests
│   │   └── pipeline.ts        # Judging pipeline: hard rules, then semantic model or MODEL_OFF
│   └── routes/                # One file per group of endpoints
│       ├── health.ts          # GET /health
│       ├── login.ts           # POST /auth/login
│       ├── labs.ts            # POST /classes/{classId}/labs and GET /labs/{labId}
│       ├── submissions.ts     # Submit, and GET /submissions/{submissionId}
│       ├── review.ts          # The review queue and the TA's decision
│       └── publish.ts         # POST /labs/{labId}/publish
└── tests/
    ├── contract/              # One test file per contract, values copied from docs/contract/
    ├── sandbox/               # The sandbox tests; they run only with SANDBOX_TESTS=1 and Docker
    │   ├── attacks.test.ts    # Runs each attack through the real sandbox and checks the result
    │   └── attacks/           # The nine attack submissions, one per sandbox minimum (brief section 5)
    └── unit/                  # Unit tests, one file per module of src/
```

## Checks

The same four commands run locally and in CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).
All four must be green to merge into `main`.

| Check        | Command                | Tool                                 |
| ------------ | ---------------------- | ------------------------------------ |
| Lint         | `npm run lint`         | ESLint + typescript-eslint           |
| Format check | `npm run format:check` | Prettier (`npm run format` fixes it) |
| Type check   | `npm run typecheck`    | `tsc --noEmit`, strict               |
| Tests        | `npm test`             | Vitest (includes contract tests)     |

CI also scans the full git history for secrets with gitleaks.

The job `sandbox` builds the sandbox image from `docker/sandbox/` and runs `npm run test:sandbox` with `SANDBOX_TESTS=1`: each of the nine attack submissions in `tests/sandbox/attacks/` goes through the real sandbox and must fail the way it should. It needs Docker, so `npm test` skips these tests. To run them yourself, build the image with `docker build --tag leetkob-sandbox:ci docker/sandbox`, then run `npm run test:sandbox` with `SANDBOX_TESTS=1` and `SANDBOX_IMAGE=leetkob-sandbox:ci` set.

## Try the endpoint

```sh
npm start
curl -i -X POST http://127.0.0.1:3000/labs/lab-sort/publish \
  -H "Authorization: Bearer demo-ta" -H "Idempotency-Key: try-1" \
  -H "Content-Type: application/json" -d '{"confirm":true}'
```

The demo tokens in `src/server.ts` are fake data, not secrets.

## Branch rules

`main` is protected. Every change arrives through a pull request, and the five CI
checks are required. Nobody pushes to `main` directly.

## Secrets and the model API key

- Every variable is listed, without values, in [`.env.example`](.env.example). Real values live only in `.env` (git-ignored) and in GitHub Actions secrets.
- The model key never enters the judging sandbox, including its environment variables.
- **Spending cap: US$0.** Provider: Google Gemini API, **free tier**. The key is created in Google AI Studio on a Google Cloud project with **no billing account linked**, so it cannot be charged. Requests above the free quota are refused (HTTP 429), not billed. If billing is ever enabled, set a budget and a quota cap first, then update this line.
- Model: `LLM_MODEL=gemini-3.5-flash-lite`. Projected list-price cost of one lab of 80 Accepted submissions: **US\$0.0083** (1 semantic constraint) to **US\$0.0166** (2 semantic constraints); actual free-tier spend is **US\$0**.
- On the free tier Google may use prompts to improve its products. We send only the lab statement, the constraints, and code with names and student IDs removed (brief §3).

## Constraint checker and evaluation

### Build and run the checker

Build the checker Docker image from the repository root:

```sh
docker build --file docker/checker/Dockerfile --tag leetkob-checker .
```

Run offline with `MODEL_OFF=1` and `--network none` (hard rules decide ban-list constraints; semantic constraints fall back to `unsure`, zero network calls):

```sh
docker run --rm --network none -e MODEL_OFF=1 \
  -v "$PWD/leetkob-eval:/data:ro" -v "$PWD/out:/out" \
  leetkob-checker --data /data --output /out/predictions.jsonl
```

Run locally with the model enabled and a call log (writes `requestId` per call):

```sh
LLM_API_KEY=<key> LLM_MODEL=gemini-3.5-flash-lite MODEL_OFF=0 MODEL_DELAY_MS=2500 \
  npx tsx src/checker/cli.ts --data leetkob-eval \
  --output eval-runs/dev/predictions.jsonl \
  --call-log eval-runs/dev/call-log.jsonl
```

Score any prediction file with the lecturer's evaluator (never edited):

```sh
node leetkob-eval/eval.mjs --data leetkob-eval --predictions eval-runs/dev/predictions.jsonl --json eval-runs/dev/summary.json
```

### Model choice, eval results, and 80-submission lab cost

- **Chosen model:** `gemini-3.5-flash-lite` via Google AI Studio Free Tier (`responseId` logged as `requestId`). Earlier trials of `gemini-2.5-flash`, `gemini-4-hydrogen`, and `gemini-3.6-flash` hit the free-tier 20 requests/day limit mid-run; `gemini-3.5-flash-lite` completed all 47 dev-set and 5 own-case semantic calls within quota.
- **Committed results (`eval-runs/`):**
  - Dev set (`leetkob-eval`, 47 solutions, 102 pairs): **0** wrongful deductions, **97.3% (36/37)** recall, **1.0% (1/102)** unsure rate -> **`PASS`** ([report](eval-runs/dev/eval-report.txt), [call log](eval-runs/dev/call-log.jsonl)).
  - Own cases (`eval-own`, 5 solutions, 10 pairs, including `trap` and `injection`): **0** wrongful deductions, **100.0% (5/5)** recall, **0.0% (0/10)** unsure rate -> **`PASS`** ([report](eval-runs/own/eval-report.txt), [call log](eval-runs/own/call-log.jsonl)).
- **Cost arithmetic for one lab of 80 Accepted submissions** (`gemini-3.5-flash-lite` list prices: US\$0.10 / 1M input tokens, US\$0.40 / 1M output tokens):
  - Across the 46 successful semantic calls on `leetkob-eval`, total usage was **39,185** input tokens (mean **851.85** / call) and **2,149** output tokens (mean **46.72** / call), totalling **US\$0.004778** (**US\$0.00010387** / call).
  - **1 semantic constraint** (80 calls): `80 × (851.85 × $0.10 + 46.72 × $0.40) / 1,000,000 = 80 × $0.00010387` = **US\$0.0083** (~0.83 cents).
  - **2 semantic constraints** (160 calls): `160 × $0.00010387` = **US\$0.0166** (~1.66 cents).
  - Ban-list constraints run deterministically via `src/judge/hard-rules.ts` at **US\$0** and 0 model calls.

## For the assistant

The rules are in [`AGENTS.md`](AGENTS.md) (`CLAUDE.md` imports it for Claude Code), and the permissions in [`docs/PERMISSIONS.md`](docs/PERMISSIONS.md).
Use of AI tools is logged in [`AI-LOG.md`](AI-LOG.md).
