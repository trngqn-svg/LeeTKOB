# PA#2 — Harness and quality gate

Team: <!-- FILL IN: StudentID — Name, one line per member -->

| Evidence                                 | Link                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Repository                               | https://github.com/trngqn-svg/LeeTKOB                                                                                                                                                                                                                                                                                          |
| Protected-branch settings                | [docs/pa2/branch-protection.png](docs/pa2/branch-protection.png)                                                                                                                                                                                                                                                               |
| Blocked PR (red check stopped the merge) | https://github.com/trngqn-svg/LeeTKOB/pull/1. Its first commit [`047ad61`](https://github.com/trngqn-svg/LeeTKOB/commit/047ad6114b1c8a11e1a541a8e619274e1804d5f9) failed `lint` and `format:check`. Screenshot with all five checks marked Required and merging blocked: [docs/pa2/pr1-blocked.png](docs/pa2/pr1-blocked.png). |
| Commit that turned it green              | [`113a536`](https://github.com/trngqn-svg/LeeTKOB/commit/113a5362c16efbec5cd9e81c89dab1ea70abaa59): removes the unused import and formats.                                                                                                                                                                                     |
| Deliberate contract break caught by CI   | https://github.com/trngqn-svg/LeeTKOB/pull/2. Commit [`0c48a28`](https://github.com/trngqn-svg/LeeTKOB/commit/0c48a28c5dec6b4d19753c39bbeebd238c220461) changes `reviews-pending` from 409 to 400 in `src/` only. `check (test)` goes red. Closed unmerged.                                                                    |
| CI run for the tag `pa2`                 | https://github.com/trngqn-svg/LeeTKOB/actions?query=branch%3Apa2                                                                                                                                                                                                                                                               |

## Where things are

- Rules file: [`AGENTS.md`](AGENTS.md) (Claude Code reads it through [`CLAUDE.md`](CLAUDE.md), which only imports it). Permissions: [`docs/PERMISSIONS.md`](docs/PERMISSIONS.md), enforced in [`.claude/settings.json`](.claude/settings.json).
- Checks: `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm test` ([README](README.md#checks)). CI: [`.github/workflows/ci.yml`](.github/workflows/ci.yml).
- Contract: [`docs/contract/publish-lab.md`](docs/contract/publish-lab.md) (`POST /labs/{labId}/publish`).
- Contract tests: [`tests/contract/publish-lab.test.ts`](tests/contract/publish-lab.test.ts).
- AI use: [`AI-LOG.md`](AI-LOG.md). Self-assessment: [`SELF_ASSESSMENT_REPORT.md`](SELF_ASSESSMENT_REPORT.md).

## Push history

`main` received one direct push, commit `6439623` (the initial harness), **before** branch
protection was turned on. Everything after it arrived through pull requests.
