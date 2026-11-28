# PA#3 — Deployed constraint review: sandbox, hard rules, model and review queue

Team: 23120292 — Nguyễn Quốc Lộc · 23120337 — Bùi Minh Quân · 23120343 — Trần Trọng Quân

| Evidence             | Link                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository           | https://github.com/trngqn-svg/LeeTKOB                                                                                                                                                                                                                                                                                                                                                                                      |
| Deployment           | https://leetkob-hcmus.koreacentral.cloudapp.azure.com (`/health` answers `{"status":"ok"}`)                                                                                                                                                                                                                                                                                                                                |
| API page (Swagger)   | https://leetkob-hcmus.koreacentral.cloudapp.azure.com/docs/ — every endpoint, with a working example for each and the demo steps                                                                                                                                                                                                                                                                                           |
| Video (walk-through) | https://youtu.be/-6IAE80cZt8                                                                                                                                                                                                                                                                                                                                                                                               |
| CI on the tag `pa3`  | https://github.com/trngqn-svg/LeeTKOB/actions?query=branch%3Apa3                                                                                                                                                                                                                                                                                                                                                           |
| Dev-set run          | [`eval-runs/dev/`](eval-runs/dev/): [predictions](eval-runs/dev/predictions.jsonl), [call log](eval-runs/dev/call-log.jsonl) with the provider's request ids, [`eval.mjs` report](eval-runs/dev/eval-report.txt) and [summary](eval-runs/dev/summary.json). Model `gemini-3.5-flash-lite`. 0 wrongful deductions, recall 97.3% (36/37), unsure 1.0% (1/102); re-scored with `eval.mjs` on 2026-11-28 with the same numbers |
| Own eval cases       | [`eval-own/`](eval-own/) (one problem, five solutions: clean, trap, obvious, disguised, injection), run in [`eval-runs/own/`](eval-runs/own/): 0 wrongful deductions, recall 100% (5/5), `PASS`                                                                                                                                                                                                                            |
| Sandbox attacks      | [`tests/sandbox/attacks/`](tests/sandbox/attacks/), run by [`tests/sandbox/attacks.test.ts`](tests/sandbox/attacks.test.ts) in the CI job `sandbox (nine attacks, Docker)` on every PR and on the tag, and on the deployed VM on 2026-11-27: 9 of 9 stopped                                                                                                                                                                |
| Judged exactly once  | [`tests/unit/worker.test.ts`](tests/unit/worker.test.ts) (stop, submit, start: judged once) and [`tests/unit/queue.test.ts`](tests/unit/queue.test.ts) (one set of verdicts when a job is finished twice); also done on the deployment, see the walk-through                                                                                                                                                               |

## Test accounts

They hold no real data. The password is the same for all five: `LeetkobPA3b87235d69dfe`.

| Email                      | Role    | Class   |
| -------------------------- | ------- | ------- |
| `admin@leetkob.example`    | admin   | —       |
| `ta1@leetkob.example`      | ta      | class-a |
| `ta2@leetkob.example`      | ta      | class-b |
| `student1@leetkob.example` | student | class-a |
| `student2@leetkob.example` | student | class-a |

There is no web interface in PA#3 (decision 14 in [`docs/DECISIONS.md`](docs/DECISIONS.md)). The walk-through uses the API: the Swagger page above, or `curl`.

## Walk-through

Run on the deployment on 2026-11-28 exactly as criterion 1 describes, with a script against the public API: `ta1` created a lab in `class-a` from the dev-set problem `sort-merge` (statement, 7 tests, both constraints with their deductions 3 and 4), and `student1` submitted `s01` (compliant), `s04` (violation) and `s09` (injection). The worker was **stopped** while they were submitted: all three stayed `queued`. After the worker was started again, each was judged `accepted` on 7 of 7 tests, with `attempts = 1` and exactly one set of verdicts (two rows) stored for each. The review queue showed: `s01` pass / pass; `s04` C1 violation (`hard_rule`, line 11) and C2 violation (`model`, line 11); `s09` C1 pass and C2 violation (`model`, lines 9–18), so the injection did not work. These are the labels of the dev set. As `ta2`, both `GET /labs/{labId}` and the review queue answered `404 lab-not-found`. The video shows the same flow on another problem.

1. `POST /auth/login` as `ta1`, then `POST /classes/class-a/labs` with a statement, tests and constraints. A constraint that starts with "Do not use" or "Do not call" is a ban list and goes to the hard rules; any other constraint goes to the model.
2. `POST /auth/login` as `student1`, then `POST /labs/{labId}/submissions`. The answer is `202` with a notice that tells the student about the review.
3. `GET /submissions/{submissionId}` until `judged`. The student sees the judge result and the result of each test, never a constraint verdict (FAQ-08).
4. As `ta1`, `GET /labs/{labId}/review-queue`: every submission, every constraint, the verdict, `decidedBy` (`hard_rule`, `model` or `fallback`), the evidence lines, and the review item when a decision is needed.
5. As `ta2` (another class), the same request answers `404`, the same as a lab that does not exist.
6. `POST /review-items/{itemId}/decision` for each pending item, then `POST /labs/{labId}/publish`. Publish answers `409 reviews-pending` while an item is pending.

## Checker command

```sh
docker build --file docker/checker/Dockerfile --tag leetkob-checker .
docker run --rm --network none -e MODEL_OFF=1 \
  -v "$PWD/leetkob-eval:/data:ro" -v "$PWD/out:/out" \
  leetkob-checker --data /data --output /out/predictions.jsonl
node leetkob-eval/eval.mjs --data leetkob-eval --predictions out/predictions.jsonl
```

With the model on (`MODEL_OFF=0`, `LLM_API_KEY`, `LLM_MODEL=gemini-3.5-flash-lite`), add `--call-log` to get one line per model call with its request id. [README › Constraint checker and evaluation](README.md#constraint-checker-and-evaluation) has the details, the model choice and the cost of an 80-submission lab (US$0.0083 to US$0.0166 at list prices; US$0 on the free tier). `leetkob-eval/` is the published dev set, unchanged; [`tests/unit/dev-set-pin.test.ts`](tests/unit/dev-set-pin.test.ts) pins the hashes of `eval.mjs` and `labels.jsonl`.

## Where things are

- How judging works: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (schema, queue state machine, pipeline, endpoints). Decisions and their trade-offs: [`docs/DECISIONS.md`](docs/DECISIONS.md).
- Contracts, one per endpoint: [`docs/contract/`](docs/contract/). Contract tests: [`tests/contract/`](tests/contract/).
- Sandbox: [`src/judge/sandbox.ts`](src/judge/sandbox.ts), image [`docker/sandbox/Dockerfile`](docker/sandbox/Dockerfile). No network, memory and swap limit, CPU time and wall-clock limits, 16 processes, output cut at 1 MiB, user 10001, read-only root, no mounts, no Docker socket, no environment.
- Hard rules (syntax-aware, with tree-sitter): [`src/judge/hard-rules.ts`](src/judge/hard-rules.ts). Model call, prompt and guardrails: [`src/judge/model.ts`](src/judge/model.ts), [`src/judge/guardrails.ts`](src/judge/guardrails.ts). The pipeline: [`src/judge/pipeline.ts`](src/judge/pipeline.ts).
- Queue and worker: [`src/db/queue.ts`](src/db/queue.ts), [`src/worker.ts`](src/worker.ts).
- Deployment and recovery: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) (sections 7.1 and 7.2), [`deploy/compose.yaml`](deploy/compose.yaml).
- What a student sees before Publish follows FAQ-08, cited in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), section 1.1.
- AI use: [`AI-LOG.md`](AI-LOG.md). Self-assessment: [`SELF_ASSESSMENT_REPORT.md`](SELF_ASSESSMENT_REPORT.md).

## Known limits

- The API has no limit on login attempts yet, and checking a password is deliberately slow (scrypt), so many attempts at once slow the API down.
- Every Accepted submission is reviewed, not only the last one before the deadline (FAQ-02), because the walk-through submits several solutions; a lab deadline is optional ([`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), section 1.1).
- The worker holds the Docker socket to start the sandbox containers, which is root on the VM (decision 10). It opens no port.
- The model runs on the Gemini free tier, so a burst of submissions can hit HTTP 429. Those verdicts fall back to `unsure` and go to the TA; nothing is deducted by mistake.
- The deployment has to stay in a region the Gemini API serves. The first VM, in Hong Kong, was refused, and the deployment moved to Korea Central ([`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md), section 7.1).
