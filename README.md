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
- The model is not called yet (it arrives in PA#3). When it is, the key never enters the judging sandbox, including its environment variables.
- **Spending cap: US$0.** Provider: Google Gemini API, **free tier**. The key is created in Google AI Studio on a Google Cloud project with **no billing account linked**, so it cannot be charged. Requests above the free quota are refused (HTTP 429), not billed. If billing is ever enabled, set a budget and a quota cap first, then update this line.
- Model: set by `LLM_MODEL`, chosen in PA#3 and recorded here. Cost of one lab: _to be measured in PA#3_.
- On the free tier Google may use prompts to improve its products. We send only the lab statement, the constraints, and code with names and student IDs removed (brief §3).

## For the assistant

The rules are in [`AGENTS.md`](AGENTS.md) (`CLAUDE.md` imports it for Claude Code), and the permissions in [`docs/PERMISSIONS.md`](docs/PERMISSIONS.md).
Use of AI tools is logged in [`AI-LOG.md`](AI-LOG.md).
