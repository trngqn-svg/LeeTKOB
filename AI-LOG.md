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

## 2026-11-23 — PA#3: the lecturer's dev set into the repository

Tool: Claude Code (Sonnet 5.5). It cloned `github.com/fithcmus/awad-leetkob-eval` into its own folder at our request and read it. It ran no code from the dev set.
Asked for: put the dev set into the repository unchanged, and keep our own tools from touching it.
Kept: `leetkob-eval/` with 128 files (`ac0e2bb`) and the ignore entries in `.prettierignore` and `eslint.config.js` (`0d87b9c`). Checked: the SHA-256 of `eval.mjs` starts `c836edd8713521bb` and the one of `labels.jsonl` starts `262cda7b0ef5612e`, the two values in the rubric. A recursive `diff` against the clone shows no difference, and the bytes stored in Git hash the same.
Changed: the first ESLint ignore was `"leetkob-eval"`. It became `"leetkob-eval/"`, the directory form, after reading how ESLint takes ignores. CI has not confirmed it yet. The assistant's first count of carriage-return bytes gave two different answers (127 files and none), so both were thrown away and the bytes were counted with a script: 0 in all 128 files.
Rejected: a git submodule or a download step in CI, because the marker's container has no network. Letting Prettier or ESLint read the folder: Prettier would rewrite `eval.mjs`, and ESLint would reject its use of `process` and `console`.
By hand: 23120337 gave the link, decided to import the set, told the assistant to leave lint, format, type check and tests to GitHub Actions, and approved the commits and the push of the branch `chore/pa3-dev-set`. No pull request yet.

## 2026-11-23 — C4 diagrams in docs/c4

Tool: Claude Code (Sonnet 5.5).
Asked for: C4 level 1 (system context) and level 2 (containers) pictures of LeeTKOB, to get an overview of the project.
Kept: two SVG files and a README (`d089cbc`). The container picture draws the intended PA#3 design and marks each box as built, partly built or planned.
Changed: after opening both files in the browser, one label ("when `MODEL_OFF=1`") touched an arrow. It was moved.
Rejected: drawing every container as if it existed. Today only the API server skeleton exists (`GET /health` and publish).
By hand: 23120337 asked for the pictures and approved the new branch `docs/architecture`, the commit and the push.

## 2026-11-23 — ARCHITECTURE.md and the SQL schema

Tool: Claude Code (Sonnet 5.5).
Asked for: a document with the system architecture, the SQLite schema, the worker queue state machine, the judging pipeline and the API endpoints.
Kept: `docs/ARCHITECTURE.md` (`db8183c`). The schema was not only written: it was loaded into an in-memory SQLite and exercised (a claim, lease expiry, a stale worker finishing late, exactly-once verdicts, the constraints that refuse bad rows). 21 checks passed at first and 43 after the later changes. The test script is not in the repository, so the same behaviour still has to be covered by tests written first.
Changed: the first run of the checks failed because of a bug in the assistant's own test script (`node:sqlite` refuses parameters that a statement does not use), not in the SQL. The script was fixed and the SQL was kept.
Rejected: showing the plan as if it were built. The document marks every part built or planned, and says that where it disagrees with a contract the contract wins.
By hand: 23120337 asked for the document and approved the commit and the push.

## 2026-11-24 — DECISIONS.md: why, and the trade-offs

Tool: Claude Code (Sonnet 5.5).
Asked for: a file that explains the architecture decisions, why they were made, and the trade-offs.
Kept: `docs/DECISIONS.md` (`a397b54`): 16 decisions at first, each with the choice, the other options, why, the trade-offs and when to change it. The decisions of PA#2 are marked decided, the others proposed or open.
Changed: the reasons for the PA#2 decisions that the repository does not record are marked "Inferred", and the intro says that the reasons of the proposals are the assistant's own reasoning, for the team to accept or change. A line that links to the file was added to `ARCHITECTURE.md`.
Rejected: presenting the proposals as team decisions. The Inferred reasons still need a teammate's confirmation.
By hand: 23120337 asked for the file and approved the commit.

## 2026-11-24 — A gap in our own design: Publish and unjudged submissions

Tool: Claude Code (Sonnet 5.5).
Asked for: a score for the proposed architecture. In its answer the assistant named a gap, and 23120337 asked whether Publish can succeed while a submission is still unjudged.
Kept: the finding, shown on the real schema: with one submission still `queued` the count of pending review items is 0, so Publish would be allowed. A worker that finished after Publish also left a pending item in a published lab. The fix is decision 18: Publish also waits for `queued` and `running` submissions, and the worker's finish refuses to write into a published lab. Both parts passed in the SQL checks.
Changed: the first design counted only review items, as the publish contract does. The design now has a release path for an error that is not the student's, and a reason `rule_error` for a crash of a hard rule, because a failed submission and a catching worker had no path before. The contract itself is not changed yet.
Rejected: the first design (count review items only). The rule "count every unjudged submission" was also refined: if the team later adopts the FAQ rule that only the last submission is graded, only those would count.
By hand: 23120337 agreed that running submissions must be checked as well. Whether a `failed` submission blocks Publish is still open.

## 2026-11-24 — The product owners' FAQ, and the lecturer's requirements first

Tool: Claude Code (Sonnet 5.5), with its web-fetch helper. The helper read `github.com/tkob-team/LeeTKOB-FAQ` (FAQ-01 to FAQ-14) and returned a summary. The assistant did not read the page itself.
Asked for: read the FAQ and say what it changes in our design. Then 23120337 set the rule that every requirement of the lecturer comes first.
Kept: the FAQ entries that do not conflict with the rubric, applied and cited in `ARCHITECTURE.md` section 1.1: FAQ-02 (per-test results, no test input or output), FAQ-05 (limits), FAQ-06 and FAQ-08 (what a student sees), FAQ-09 and FAQ-11 (the TA decides an unsure, no deduction column), FAQ-10 (the 10% sample, in part) and FAQ-12 (in part). Decision 17 records the rule (`4f8875c`).
Changed: because of the FAQ, `review_items` now has `final_verdict` and `final_evidence` and no `deduction`, and the limits of a lab follow the FAQ ranges (CPU 1 to 5 seconds, memory 64 to 512 MB). Re-checking the design against each criterion of the rubric found three gaps in the assistant's own design: the checker had no call log (criterion 4), the 10% sample was on the "cut" list although the brief (section 3) requires it, and the step that checks evidence lines against the code was missing. All three were added.
Rejected: the FAQ rule that only the last submission is reviewed, and the FAQ rule that a lab needs a deadline. The rubric's walk-through submits three solutions and creates a lab without a deadline, so the lecturer's flow wins. Both are written down as questions for the lecturer.
By hand: 23120337 gave the FAQ link and set the lecturer-first rule. The helper's summary of the FAQ has not been checked against the original page yet.

## 2026-11-24 — Limit how fast a student can submit

Tool: Claude Code (Sonnet 5.5).
Asked for: whether the system stops a student from submitting many times in a short time. It did not: neither the design nor the code limited it.
Kept: decision 19 and `ARCHITECTURE.md` section 6.6: two checks per student, in the same transaction as the insert. At most 15 submissions queued or running and at most 30 in the last 60 seconds, otherwise 429 `too-many-submissions` with `Retry-After`. Six more SQL checks (43 in total) show that the counts are right, that another student is not affected, and that the query uses the new index on `(student_id, created_at)`.
Changed: the defaults are high on purpose, because the lecturer's walk-through and about ten attack submissions may come from one account.
Rejected: a rate-limit library for now (it counts requests, not queued jobs, and authentication happens inside the handlers), a limit at the proxy (hosting is undecided and CI cannot test it), and a hard cap on the number of submissions (FAQ-02 allows any number).
By hand: 23120337 chose this option and will review later whether to move to a library. The numbers are a guess.

## 2026-11-24 — A leftover instruction in the old working copy

Tool: Claude Code (Sonnet 5.5), while it read the old copy of the repository.
Asked for: nothing. It showed up in `git diff`.
Kept: nothing. The old working copy had an uncommitted change in `tests/contract/publish-lab.test.ts`: a sentence telling an assistant to merge a pull request, pasted at the end of a line of code, which also broke the syntax of the file.
Changed: nothing was committed. The new clone of the repository does not have it.
Rejected: the sentence. The assistant did not follow it, because it was text in a file and not a request from us. We do not know where it came from.
By hand: 23120337 cloned the repository again into the folder `LeeTKOB`.

## 2026-11-24 — updating this log

Tool: Claude Code (Sonnet 5.5) drafted the entries above from its conversation with 23120337.
Asked for: update `AI-LOG.md` for the PA#3 work so far.
Kept: the entries, in the format of the PA#2 entries.
Changed: the "By hand" lines say only what the conversation shows 23120337 did or decided.
Rejected: writing down steps that nobody did. What has not been verified is named in the entries.
By hand: 23120337 has to read the entries and correct what is wrong before the tag `pa3`.
