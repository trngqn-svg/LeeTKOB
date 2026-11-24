# Reconsidering the architecture decisions

Status: proposal, written on 24 November. The team has not agreed to it yet. Nothing in `DECISIONS.md` or `ARCHITECTURE.md` has been changed because of it.

## 1. Why we are looking again

The PA#3 deadline moved from Wednesday 25 November to Sunday 29 November at 22:00. Several decisions in `DECISIONS.md` were shaped by the old two-day limit (decision 14 says so). With more time we can replace a guess with a measurement.

The milestone post gives the dates that now bound the work:

- PA#3 is due Sunday 29 November at 22:00.
- PA#4 is still due Wednesday 2 December. There are only three days between the two.
- PA#5 is due Wednesday 16 December and includes the load test of 80 submissions and the logs, metrics and traces.
- PA#6 is the final demo and the individual oral in sessions 14 and 15.

So "more time" means about five days, followed by a short sprint. Every change below must be justified by a rubric item or by a later milestone.

## 2. What the milestones imply

1. **The PA#4 red team attacks the PA#3 deployment.** The sandbox and the parser are attacked from 29 November on, so they must be hardened before the deadline, and the deployment must stay up afterwards.
2. **PA#6 gives each member 60 points for explaining the team's code, with the assistant closed.** Every member must be able to defend every decision. We prefer options that we can explain without help, and we review each change with Trong Quan and Loc.
3. **The load test is in PA#5.** The database decision does not need to be final for PA#3.
4. **PA#5 asks for logs, metrics and traces.** Logging with a request id and a submission id on every line is cheap now and expensive later.
5. **The list of F1 to F11 and their rules was not available to this review.** By decision 17 (lecturer first) it outranks this document. Before any change is made, each decision must be checked against that list.

## 3. Method: decide by measurement

Each uncertain decision gets a short spike of two to three hours. A spike answers one question, writes its result into this file, and ends. Spike code is not part of the product and goes into a separate folder or branch.

## 4. Verdict for each decision

- **Decision 8, SQLite as database and queue: reconsider, by measurement.** Keep it if the load test shows no contention. Postgres adds `SKIP LOCKED` and several writers, at the cost of one more service and slower tests. `node:sqlite` is experimental, so `better-sqlite3` is the alternative to weigh. Keep the queue code behind a small interface so a swap stays cheap.
- **Decision 10, own Docker sandbox: keep, and harden.** This is the weakest point. The worker holds the Docker socket, which is root on the VM. The options, cheapest first, are a socket proxy that allows only a few calls, rootless Docker, and gVisor.
- **Decision 11, hard-rule parser: reconsider, by measurement.** Measure tree-sitter on the ban-list pairs of the dev set first. Clang understands macros and name lookup exactly, but it must run inside a sandbox, because an include of an arbitrary path could read secrets. tree-sitter never opens files, which is a security advantage.
- **Decision 6, Gemini free tier: reconsider.** Choose the model from a comparison on the dev set, and check that the free-tier rate limit survives the load test.
- **Decision 14, API only: change.** Plan a UI and real-time results now. PA#5 asks for real-time results, so the API shape (for example a server-sent events endpoint, and bearer tokens against cookies) should be decided now. The brief also says students are told about the review when they submit.
- **Decision 1, `tsx` in production: small change.** Use a proper production build instead of a dev dependency at runtime.
- **Decisions 7, 9, 12, 13, 15, 16, 17, 18 and 19: keep.** They hold on merit. Add a worker concurrency setting for the load test, and a rehearsed deploy and backup for decision 15.

## 5. The spikes

Spike A, the parser. Question: how accurate is tree-sitter on the ban-list constraints?

- Input: the 55 ban-list pairs of the dev set, with their known labels.
- Measure: correct, wrong and unsure counts, and the time per file.
- Done when: we have a number and a list of the wrong cases, and we know whether those cases are fixable or need another approach.

Spike B, the sandbox. Question: how much harder can we make the worker's access without breaking judging?

- Try: a socket proxy that allows only create, start, wait, logs and remove, then rootless Docker.
- Measure: time per run, and whether the lecturer's walk-through still passes.
- Done when: we choose a level, and the attacks we can think of (fork bomb, network access, large output, writing outside the work folder, reading the host) are listed with their result.

Spike C, the model. Question: which model gives the best accuracy and cost on the semantic constraints?

- Input: the dev set, two or three models, the same prompt and schema.
- Measure: accuracy, `unsure` rate, cost and rate-limit errors.
- Done when: we choose a model and record the numbers in decision 6.

Spike D, the database. Question: does SQLite hold up under 80 simultaneous submissions?

- Input: the real claim, heartbeat and finish statements, and 80 submissions at once.
- Measure: lock waits, failed writes, and the time to the last verdict.
- Done when: we keep SQLite or write the case for Postgres. This runs before PA#5, not before PA#3.

## 6. Order

1. Spikes A and B, because PA#3 needs hard rules and PA#4 attacks them.
2. Spike C, because PA#3 needs the model running and PA#4 evaluates it.
3. Spike D, before PA#5.

## 7. Decisions we have not made yet

- Logging from day one, with a request id and a submission id on every line.
- The load test tool.
- Worker concurrency.
- Backups and restore.
- Deploy automation.
- The UI.
- The notice shown to students when they submit.

Each becomes a numbered decision in `DECISIONS.md` once chosen.

## 8. What we do not change

- The lecturer-first rule.
- Contract first.
- The exactly-once queue design.
- The pinned dev set.
- One part per commit, with tests first.

## 9. Open points

- Whether the review queue shows every submission or only the last one (for the lecturer).
- Whether a lab needs a deadline (for the lecturer).
- Whether a `failed` submission blocks Publish. Our recommendation is yes, until it is requeued.
- The task assignment in `TASKS.md` still has to be agreed with Trong Quan and Loc, and its timeline still assumes the old Wednesday deadline.

## 10. Results

No spike has been run yet. Results are added here, one subsection per spike, with the date, the numbers, and the decision they led to.
