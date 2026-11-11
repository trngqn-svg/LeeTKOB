# Self-assessment — PA#2 Harness and quality gate

Submitted by:

- 23120292 — Nguyễn Quốc Lộc
- 23120337 — Bùi Minh Quân
- 23120343 — Trần Trọng Quân

I claim: **89 / 100**

| #   | Criterion                   | Max | I claim | Evidence                                                                                                                                                                                                                                                |
| --- | --------------------------- | --- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Rules file                  | 15  | 13      | `AGENTS.md`: stack, commands, conventions, never. Two Never lines trace to AI-LOG 2026-11-08 (the pipe that hid a red `format:check`; the test helper whose `undefined` became a default body).                                                         |
| 2   | Permissions and secrets     | 10  | 9       | `docs/PERMISSIONS.md` + `.claude/settings.json` (allow / ask / deny). `.env.example` lists every variable without values. The gitleaks job scans the full history. README › Secrets states the spending cap.                                            |
| 3   | One command for every check | 10  | 10      | README › Checks. `ci.yml` runs `npm run ${{ matrix.check }}` over the same four scripts.                                                                                                                                                                |
| 4   | CI that blocks a merge      | 20  | 18      | `docs/pa2/branch-protection.png`. PR #1 blocked by red `lint`/`format:check`, turned green by `113a536`. PR #2 blocked by a red required `check (test)`: `docs/pa2/pr2-blocked.png`. The only direct push to `main` (`6439623`) came before protection. |
| 5   | Contract of one endpoint    | 25  | 22      | `docs/contract/publish-lab.md`: role + ownership (404 for another class), field rules, 9 problem types with status and title, two-layer idempotency, order of checks, side effects.                                                                     |
| 6   | Contract tests that bite    | 15  | 13      | `tests/contract/publish-lab.test.ts` (39 tests): each error type, ownership, idempotency, concurrency, order of checks. PR #2: a deliberate break in `src/` only, CI red.                                                                               |
| 7   | AI-LOG.md                   | 5   | 4       | `AI-LOG.md`: one entry per task (PR #1, PR #2, contract, tests, PA2.md, final fixes) with real Changed, Rejected and By hand lines.                                                                                                                     |
|     | **Total**                   | 100 | **89**  |                                                                                                                                                                                                                                                         |

## What we did not manage

- Storage is in memory. Idempotency keys never expire, and "exactly one publication" holds only for one Node process. A database in PA#3 must keep both guarantees.
- The review queue is a count (`pendingReviews`), not real items yet.
- The "spending cap" is the free tier with no billing account (US$0), not a budget set in a billing console. The model is not chosen yet.

## What we would do differently

Turn on branch protection before the very first push, so even the initial commit goes through a PR.
