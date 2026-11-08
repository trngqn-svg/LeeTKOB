# AI-LOG

## 2026-11-08 — PA#2 harness: repo setup, CI, permissions

Tool: Claude Code (Opus).
Asked for: set up Node/TypeScript/Fastify with lint, format check, type check and tests as one npm script each, a GitHub Actions workflow that runs the same scripts, a rules file, and permissions.
Kept: the npm scripts, one CI job per check (a matrix) so branch protection can require each one by name, the gitleaks job over the full history.
Changed: while checking its own work, the assistant ran `npm run format:check | tail` and read the result as green, but Prettier had failed. The pipe returned `tail`'s exit code, not Prettier's. We changed the local run to read each exit code directly, made sure CI has no pipe, `|| true` or `continue-on-error`, and added a line to `CLAUDE.md` › Never.
Rejected: <!-- team: add what you threw away -->
By hand: <!-- team: what you wrote yourselves -->

## 2026-11-08 — contract for `POST /labs/{labId}/publish`

Tool: Claude Code (Opus).
Asked for: a contract for the publish endpoint with roles, ownership, RFC 9457 errors and idempotency, in `docs/contract/publish-lab.md`.
Kept: 404 (not 403) for a TA of another class, with the same body as a missing lab. Two-layer idempotency (Idempotency-Key replay, plus 200 on a lab that is already published). Errors are not stored.
Changed: the first draft gave no `title` per error type, so the tests would have had to copy titles from the code. We added a `title` column so the tests copy from the contract. We also found that Fastify parses the body before the handler runs, so 415 and invalid JSON come before 401. We wrote that into the "Order of checks" section instead of hiding it, and added a Never rule against Fastify schemas on contracted routes.
Rejected: <!-- team -->
By hand: <!-- team -->

## 2026-11-08 — contract tests

Tool: Claude Code (Opus).
Asked for: tests that follow the contract: each error type, ownership, idempotency, order of checks.
Kept: 39 tests with `app.inject()`. Expected status and title are copied from the contract, not imported from `src/`.
Changed: the "no body" test passed `body: undefined`, and the helper's destructuring default replaced it with `{ confirm: true }`. The test was sending a body and failing for the wrong reason. The test helper was wrong, not the code: we fixed the helper to use `null` and touched no `src/` file. Added to `CLAUDE.md` › Never.
Verified the tests bite: changing `reviews-pending` from 409 to 400 in `src/problems.ts` turns `npm test` red. Recorded as PR #2.
Rejected: <!-- team -->
By hand: <!-- team -->
