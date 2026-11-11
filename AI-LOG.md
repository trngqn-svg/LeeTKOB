# AI-LOG

## 2026-11-08 — PA#2 harness: repo setup, CI, permissions

Tool: Claude Code (Opus).
Asked for: set up Node/TypeScript/Fastify with lint, format check, type check and tests as one npm script each, a GitHub Actions workflow that runs the same scripts, a rules file, and permissions.
Kept: the npm scripts, one CI job per check (a matrix) so branch protection can require each one by name, the gitleaks job over the full history.
Changed: while checking its own work, the assistant ran `npm run format:check | tail` and read the result as green, but Prettier had failed. The pipe returned `tail`'s exit code, not Prettier's. We changed the local run to read each exit code directly, made sure CI has no pipe, `|| true` or `continue-on-error`, and added a line to `AGENTS.md` › Never.
Rejected: nothing. We reviewed the scripts and the workflow and kept them.
By hand: created the GitHub repository. Turned on branch protection for `main` in the web UI (5 required checks, no bypass). Opened PR #1 and PR #2, closed #2 unmerged, merged #1 with a merge commit. Took the screenshots in `docs/pa2/`.

## 2026-11-08 — contract for `POST /labs/{labId}/publish`

Tool: Claude Code (Opus).
Asked for: a contract for the publish endpoint with roles, ownership, RFC 9457 errors and idempotency, in `docs/contract/publish-lab.md`.
Kept: 404 (not 403) for a TA of another class, with the same body as a missing lab. Two-layer idempotency (Idempotency-Key replay, plus 200 on a lab that is already published). Errors are not stored.
Changed: the first draft gave no `title` per error type, so the tests would have had to copy titles from the code. We added a `title` column so the tests copy from the contract. We also found that Fastify parses the body before the handler runs, so 415 and invalid JSON come before 401. We wrote that into the "Order of checks" section instead of hiding it, and added a Never rule against Fastify schemas on contracted routes.
Rejected: nothing.
By hand: read the contract and checked it against the class brief (TA only, own class only; refuse while reviews are pending; safe to repeat).

## 2026-11-08 — contract tests

Tool: Claude Code (Opus).
Asked for: tests that follow the contract: each error type, ownership, idempotency, order of checks.
Kept: 39 tests with `app.inject()`. Expected status and title are copied from the contract, not imported from `src/`.
Changed: the "no body" test passed `body: undefined`, and the helper's destructuring default replaced it with `{ confirm: true }`. The test was sending a body and failing for the wrong reason. The test helper was wrong, not the code: we fixed the helper to use `null` and touched no `src/` file. Added to `AGENTS.md` › Never.
Verified the tests bite: changing `reviews-pending` from 409 to 400 in `src/problems.ts` turns `npm test` red. Recorded as PR #2.
Rejected: nothing.
By hand: checked that PR #2 went red in CI and that the merge was blocked.

## 2026-11-08 — rules file renamed to AGENTS.md

Tool: Claude Code (Opus).
Asked for: rename `CLAUDE.md` because not every member uses Claude.
Kept: `AGENTS.md` holds the rules. Copilot, Cursor and Codex read it directly.
Changed: Claude Code does not read `AGENTS.md` on its own. A plain rename would have left Claude without rules, so `CLAUDE.md` now contains only `@AGENTS.md` (an import). There is one source and no copy that can drift.
Rejected: keeping the rules only in `CLAUDE.md`. Not every member uses Claude.
By hand: the decision to rename.

## 2026-11-08 — PR #1: `GET /health` and a red check on purpose

Tool: Claude Code (Opus).
Asked for: a small first change to go through a pull request, so we could show branch protection stopping a red PR.
Kept: the `/health` route and its unit test (`047ad61`).
Changed: the first commit was left with an unused import and a missing semicolon on purpose, so `lint` and `format:check` went red. The fix (`113a536`) came right after. This failure was planted to show the gate, not found by accident.
Rejected: nothing.
By hand: opened PR #1, checked that the merge button was blocked while two required checks were red, merged it after they went green.

## 2026-11-08 — PR #2: deliberate contract break

Tool: Claude Code (Opus).
Asked for: one commit that breaks the contract in `src/` only, to prove the contract tests in required CI catch it.
Kept: `0c48a28` changes `reviews-pending` from 409 to 400 in `src/problems.ts` and touches no test and no contract. `check (test)` went red (2 contract tests fail).
Changed: nothing.
Rejected: nothing.
By hand: opened PR #2, checked the red required check, closed it unmerged.

## 2026-11-08 — PA2.md and the self-assessment

Tool: Claude Code (Opus).
Asked for: a first draft of `PA2.md` (links to the evidence) and `SELF_ASSESSMENT_REPORT.md` (`6867d4c`).
Kept: the table layout and the evidence links.
Changed: nothing.
Rejected: nothing.
By hand: checked every link and chose the marks we claim.

## 2026-11-11 — final PA#2 fixes after a rubric review

Tool: Claude Code (Opus).
Asked for: a review of the repository against the PA#2 rubric, then drafts of the missing AI-LOG entries and small fixes.
Kept: the three 2026-11-08 entries above (PR #1, PR #2, PA2.md); "two layers" in the contract became "three cases", because the section lists three numbered cases.
Changed: we raised criterion 2 to 9 in the self-assessment, because the 9–10 band (three permission tiers, `.env.example`, clean history, spending cap in the README) is met.
Rejected: nothing.
By hand: Quân chose four Never rules for `AGENTS.md` from the class brief (§3, §5) after the review said the Never list had no rule about the LLM feature itself; the assistant typed them in. Quân also rewrote the "real model" rule by hand, to say the real model is used only in the eval.

## 2026-11-11 — PA#2 evidence: screenshot of the red required check

Tool: Claude Code (Opus), to review our PA#2 against the rubric and add this entry.
Asked for: what evidence row 4 still lacked. It pointed out that the PR #1 screenshot shows merging blocked by the required review, not by the red checks.
Kept: the advice to reuse PR #2 instead of opening a new PR with another planted failure.
Changed: nothing in `src/`, `tests/` or the contract.
Rejected: creating a new PR just to show a failing check. PR #2 already had one.
By hand: 2026-11-11: reopened PR #2 to screenshot the red required check, closed it again unmerged. Screenshot: `docs/pa2/pr2-blocked.png`.
