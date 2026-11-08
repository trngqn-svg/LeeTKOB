# LeeTKOB — rules for coding assistants

Constraint review for C++ lab submissions: hard rules, then the model, then a TA
review queue, then Publish. Read `docs/contract/` before touching an endpoint.

## Stack

- Node 22, TypeScript (strict, run by `tsx`, no build step), Fastify 5.
- Tests: Vitest with `app.inject()`. Lint: ESLint 9 + typescript-eslint. Format: Prettier.
- Storage is in memory for PA#2 (`src/store.ts`). A database arrives in PA#3.

## Commands (the same ones CI runs)

| Check        | Command                |
| ------------ | ---------------------- |
| Lint         | `npm run lint`         |
| Format check | `npm run format:check` |
| Type check   | `npm run typecheck`    |
| Tests        | `npm test`             |
| Fix format   | `npm run format`       |
| Run server   | `npm start`            |

## Conventions

- Every error is `application/problem+json` (RFC 9457), sent through `sendProblem` in
  `src/problems.ts`. Clients branch on `type`.
- An endpoint's behaviour is defined by `docs/contract/<endpoint>.md`. To change the
  behaviour, change the contract first, in its own commit, then the code and the tests.
- Contract tests copy expected statuses and titles from the contract. Never import them from `src/`.
- Work on a branch and open a PR. `main` is protected.

## Never

- Never put a secret in the repo, in a prompt, or in the sandbox. That covers its
  environment variables too. The model API key lives only in `.env` (git-ignored) and in CI secrets.
- Never call a real model in unit or contract tests. Use a fake.
- Never edit a test, the eval data, or a label to make a check pass. If a test is
  wrong, say why in the PR and fix it in a commit that touches no `src/` file.
- Never pipe a check into `tail`/`head`/`grep`, and never add `|| true` or
  `continue-on-error`, in CI or when reporting a result. A pipe returns the last
  command's exit code, so the check can no longer fail.
  (Why: AI-LOG 2026-11-08 — a red `format:check` was reported as green.)
- Never use `undefined` to mean "omit this" in a test helper with defaults. The
  destructuring default silently replaces it. Use `null`.
  (Why: AI-LOG 2026-11-08 — the "no body" test was sending a body.)
- Never add a Fastify JSON schema to a contracted route. Fastify validates before the
  handler, which would answer 422 before 401 and break the contract's order of checks.
- Never push to `main`, force-push, or rewrite published history.
