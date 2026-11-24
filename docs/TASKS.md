# PA#3 task assignment

This file says who does what for PA#3. **It is a proposal.** It was written without knowing the skills and the free time of each member, so swap tasks between you if you have to, but keep the order of dependencies. The deadline is Wednesday 25 November 2026 at 22:00. Late work loses 20% of the mark (up to 2 hours late) or 50% (2 to 24 hours late).

The team is the same as in PA#2: Nguyễn Quốc Lộc (23120292), Bùi Minh Quân (23120337) and Trần Trọng Quân (23120343). In this file they are Loc, Quan and Trong Quan.

| Person     | Student ID | Area                                                                                           | Why this split                                                                                  |
| ---------- | ---------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Quan       | 23120337   | The VM, the deployment and the sandbox                                                         | Asked for the VM tasks. The sandbox runs in Docker on that VM, so it stays with the same person |
| Trong Quan | 23120343   | The backend: contracts, database, accounts, labs, submissions, queue, review queue and Publish | Built the PA#2 harness, contracts and tests, and owns the repository                            |
| Loc        | 23120292   | The judging logic: hard rules, the model call, the checker command and the dev-set run         | Self-contained work that starts from the dev set and needs little from the others at first      |

## Rules for everyone

- The lecturer's requirements come first (decision 17 in `docs/DECISIONS.md`). Where the rubric and a FAQ entry disagree, the rubric wins.
- Tests before the code they test, or in the same commit, and one part per commit. Never loosen a test or an eval case to make it pass.
- Every change goes through a pull request. Another member reviews it before it is merged. The checks run in CI, not on your machine.
- Contract first: a new endpoint gets its file in `docs/contract/` before any code.
- No secret in the repository, in a prompt or in the sandbox.
- Whoever uses an assistant adds an entry to `AI-LOG.md` when the work happens, with a real Changed and Rejected line.
- Never edit `leetkob-eval/` (the dev set) or the files of the lecturer in it.

## Timeline

| When                     | What                                                                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tonight, first hour      | Agree the shared interfaces (verdict, constraint result, model client, sandbox function). Quan creates the VM, Loc runs the two spikes, Trong Quan writes the first contracts |
| Tonight                  | The schema in code, accounts and login, the hard-rule tests, the nine attack submissions, and the health route over HTTPS                                                     |
| Wednesday 09:00          | One thin slice works with the model off: submit, queue, sandbox, hard rule, review queue                                                                                      |
| Wednesday 09:00 to 14:00 | The real model, the checker command, the real dev-set run, Publish rewired, the attacks run on the VM                                                                         |
| Wednesday 14:00          | Code freeze. Only fixes after this                                                                                                                                            |
| Wednesday 14:00 to 17:00 | The walk-through on the deployment as the lecturer will do it, the video, and `PA3.md`                                                                                        |
| Wednesday 17:00          | The tag `pa3` is pushed and CI is green on the tag                                                                                                                            |
| Wednesday, by 20:00      | Self-assessment, zip, turn in. The deadline is 22:00 and the late penalty starts then                                                                                         |

## Quan: the VM, the deployment and the sandbox

Priority is Must or Should. The ids are used in `docs/DEPLOYMENT.md`.

| No. | Task                                                                                                                                                         | Output                                                                                        | Rubric | Needs                           | Priority                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ------ | ------------------------------- | ---------------------------------- |
| Q1  | Activate Azure for Students and try to create a VM in an allowed region and size                                                                             | The subscription works. The region and the size are written in `docs/DEPLOYMENT.md`           | 1      | Nothing                         | Must, tonight                      |
| Q2  | Create the VM as in `docs/DEPLOYMENT.md`: resource group, image, size, disk, static IP with a DNS name, firewall rules, SSH key                              | A VM you can log in to                                                                        | 1      | Q1                              | Must, tonight                      |
| Q3  | Install Docker, create the deploy user, a root-owned env file and automatic security updates. Run the checks of section 7                                    | The checks pass and swap is 0                                                                 | 2      | Q2                              | Must, tonight                      |
| Q4  | Write the Dockerfile for the app image and a Compose file (caddy, api, worker, data volume). Deploy the health route over HTTPS. Add an outside uptime check | `/health` answers 200 on the public DNS name                                                  | 1      | Q3                              | Must, tonight or Wednesday morning |
| Q5  | Tests first: the nine attack submissions (`.cpp`) and their tests, and a CI job that has Docker                                                              | Nine tests that fail the way an attack should, in CI                                          | 2      | Nothing                         | Must                               |
| Q6  | Then the sandbox runner `src/judge/sandbox.ts`: compile and run inside the sandbox, with the limits of the lab                                               | A function for the worker: source, tests and limits in, judge result and per-test results out | 2      | Q5 and T2                       | Must                               |
| Q7  | Run the nine attacks against the deployed VM, with the 1 GiB memory read-back and the wall-time kill, and check that no container is left                    | A short note for `AI-LOG.md`                                                                  | 2      | Q4 and Q6                       | Must, Wednesday afternoon          |
| Q8  | Set the budget alerts, check the remaining credit, give the teammates access, and write the recovery steps (restart, logs) in `docs/DEPLOYMENT.md`           | Alerts set, and everyone can reach the VM                                                     | -      | Q2                              | Should, tonight                    |
| Q9  | Draft `PA3.md` (URL, test accounts, CI link, checker command, dev-set run folder, video link) and record the video of the walk-through (5 minutes at most)   | `PA3.md` and the video link                                                                   | 1      | The tasks of Trong Quan and Loc | Must, Wednesday 14:00 to 17:00     |
| Q10 | Keep the deployment up until the PA#4 marks are out, and watch the credit                                                                                    | A deployment that answers                                                                     | 1      | Q4                              | Must, ongoing                      |

## Trong Quan: the backend

| No. | Task                                                                                                                                                                                                                                        | Output                                                                                      | Rubric | Needs     | Priority         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------ | --------- | ---------------- |
| T1  | Merge the contract branch for Publish (`docs/contract-publish-rules`). Then write one contract per new endpoint in `docs/contract/` before any code                                                                                         | Contracts for login, create lab, get lab, submit, get submission, review queue and decision | 1, 5   | Nothing   | Must, tonight    |
| T2  | The shared interfaces: verdict, constraint result, model client and sandbox function                                                                                                                                                        | `src/judge/types.ts`                                                                        | 2, 4   | Nothing   | Must, first hour |
| T3  | The database in code from the schema in `docs/ARCHITECTURE.md`: a connection with the three pragmas, the schema as a separate migration command, and a seed script for 1 admin, 2 TAs in two classes and 2 students in the first TA's class | The accounts of `PA3.md` can be created with one command                                    | 1      | T2        | Must             |
| T4  | Login, the bearer token (only its hash is stored) and the class rule: a TA of another class gets `lab-not-found`                                                                                                                            | Contract tests pass                                                                         | 1      | T1 and T3 | Must             |
| T5  | Labs: create with tests and constraints (the kind and the banned names come from the constraint text, by code), and get                                                                                                                     | Contract tests pass                                                                         | 1, 3   | T4        | Must             |
| T6  | Submissions: create (the limits of section 6.6, the size limit, 202) and get (status, result, per-test results, never a verdict)                                                                                                            | Contract tests pass                                                                         | 1, 5   | T5        | Must             |
| T7  | The queue and the worker loop: claim, heartbeat, release and the guarded finish. Tests first: stop the worker, submit, start it, one set of verdicts                                                                                        | A worker that calls Q6 and the pipeline of L7                                               | 2      | T3 and Q6 | Must             |
| T8  | The review queue and the decision endpoint. Publish reads the queue and the unjudged submissions (the contract change)                                                                                                                      | Contract tests pass. A student never gets a verdict                                         | 1, 5   | T7        | Must             |
| T9  | Make the repository public and check it before the tag                                                                                                                                                                                      | A public repository                                                                         | All    | Nothing   | Must, Wednesday  |

## Loc: the judging logic

| No. | Task                                                                                                                                                                                         | Output                                                                                    | Rubric  | Needs     | Priority                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------- | --------- | ---------------------------- |
| L1  | Two spikes first: tree-sitter for C++ on Windows and in CI, and whether the model provider returns a request id                                                                              | The result is written in `docs/DECISIONS.md` (decisions 11 and 6)                         | 3, 4    | Nothing   | Must, tonight, 1 to 2 hours  |
| L2  | Hard rules, tests first: the traps of the dev set and your own, then `src/judge/hard-rules.ts`, generic from the constraint text                                                             | A model-off run on the dev set with 0 wrongful deductions and every ban-list pair decided | 3       | L1        | Must                         |
| L3  | The model client with a fake one for tests, the prompt (comments blanked, line numbers kept, no identity), the schema check, the timeout, the evidence mapping and the call log              | Fake-model tests: bad JSON, an extra key and no answer in time each give unsure           | 4, 5    | T2        | Must                         |
| L4  | The checker command and its Dockerfile, with `MODEL_OFF=1` and the call log. Run it with `docker run --network none` on the dev set                                                          | `eval.mjs` exits 0 or 1, never 2                                                          | 6       | L2 and L3 | Must                         |
| L5  | The real run on the dev set, committed: the predictions, the `eval.mjs` report and the call log with request ids. At least five own cases in a separate folder, with a trap and an injection | The folder named in `PA3.md`                                                              | 4, 6    | L4        | Must, Wednesday morning      |
| L6  | The README: the command, the build line, the model-off switch, the model, and the cost of a lab of 80 submissions with the arithmetic                                                        | A README section                                                                          | 4, 6    | L5        | Must                         |
| L7  | The pipeline glue `src/judge/pipeline.ts`, with Trong Quan and Quan, and the 10 percent sample of the passes (brief section 3)                                                               | Review items for violations, unsures and samples                                          | 3, 4, 5 | T7        | Must (glue), Should (sample) |

## Together

- Review each other's pull requests, one reviewer before a merge.
- Fill `PA3.md` and `SELF_ASSESSMENT_REPORT.md` together and decide the marks together. The honesty rule of the rubric punishes marks that are far above the real ones.
- The zip is named `23120292-23120337-23120343_TOTAL.zip`, where TOTAL is the total in the self-assessment. One member turns it in from their `@student.hcmus.edu.vn` account. Proposed: Quan, who also does the last check of the deployment. Confirm it among you.
- The tag `pa3` is pushed after the last merge, and CI must be green on the tag.

## If time runs short

Cut in this order, and never cut the last group.

- First: the 10 percent sample of the passes (it is in the brief, but the PA#3 rubric does not mark it), then the per-test detail of a result (keep the compile error and the judge result).
- Never: the nine attack tests, a queue with a separate worker that judges once, the schema check and the timeout with their tests, `MODEL_OFF=1`, one real dev-set run with request ids, verdicts only in the review queue, and a deployment that answers.

Build one thin slice first and add the rest on it: a submission goes through the queue, the sandbox and a hard rule into the review queue, with the model off. Add the real model last.
