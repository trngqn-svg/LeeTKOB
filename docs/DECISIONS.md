# LeeTKOB architecture decisions

This file records the main architecture decisions of LeeTKOB: what was chosen, what else was possible, why, what it costs, and what would make us change it. `docs/ARCHITECTURE.md` says how the system is built. This file says why it is built that way.

Each decision has a status:

- **decided**: already in the repository (PA#2).
- **proposed**: the design for PA#3 in `docs/ARCHITECTURE.md`. The team has not confirmed it.
- **open**: no choice has been made.

Where the team wrote a reason down, the reason starts with "Recorded" and names the file. Otherwise it starts with "Inferred": the reason was worked out from the code and the class brief, and the team should confirm or correct it. The reasons of the proposed decisions are not recorded anywhere yet. They are the reasoning behind the proposal, offered for the team to accept or change. This file was drafted with Claude from the repository. Nobody on the team has reviewed it yet.

| No. | Decision                                                | Status   | Main trade-off                                         |
| --- | ------------------------------------------------------- | -------- | ------------------------------------------------------ |
| 1   | Node 22, TypeScript and Fastify 5                       | decided  | One thread, so CPU-heavy work must stay out of the API |
| 2   | Errors as problem+json with fixed titles                | decided  | A fixed title cannot fit every case, so more types     |
| 3   | Contract first, tests copy the contract                 | decided  | More writing, and two copies that can drift            |
| 4   | One CI job per check, and a secret scan                 | decided  | More CI minutes                                        |
| 5   | Protected main, three permission tiers                  | decided  | Every commit and push needs a human answer             |
| 6   | Gemini free tier with a US$0 cap                        | decided  | Quota limits and HTTP 429 under load                   |
| 7   | One repository, two processes                           | proposed | One host only, because of the shared SQLite file       |
| 8   | SQLite as the database and the queue                    | proposed | One writer at a time, and an experimental module       |
| 9   | Leases and a guarded finish                             | proposed | A job can be judged twice                              |
| 10  | Our own Docker sandbox, not Judge0                      | proposed | Shared kernel, and the worker needs Docker             |
| 11  | Syntax-aware parser for the hard rules                  | proposed | Syntax without meaning: macros and aliases             |
| 12  | One model call per semantic constraint                  | proposed | More calls and more quota                              |
| 13  | Strict rules for model input and output                 | proposed | More unsure, and comments that explain intent are lost |
| 14  | Verdicts only in the review queue, API only             | proposed | TA workload, and no early signal for students          |
| 15  | Hosting on one Azure for Students VM                    | proposed | Burstable CPU, unknown region limits, one owner        |
| 16  | Dev set copied unchanged, pinned by hash                | proposed | A manual update if the lecturer republishes it         |
| 17  | The lecturer's requirements come first                  | decided  | Some FAQ rules are delayed or reduced                  |
| 18  | Publish also waits for queued and running submissions   | proposed | A stuck job blocks Publish                             |
| 19  | A database check to limit how fast a student can submit | decided  | Protects submissions only, not login                   |

## Fixed by the brief

These are not our choices, and the decisions below do not reopen them. They come from the lecturer. The decisions are about how to meet them.

- Hard rules run first, and when a hard rule decides a constraint the model is not called for it.
- The model judges only the semantic constraints and never decides a deduction. The TA sets it.
- A human gate: every violation, every unsure and a sample of the passes go to the TA's review queue, and marks are published only after the TA reviews them and presses Publish.
- The sandbox minimums: no network, limits on CPU, time, memory, processes and output, a non-root user, no host mounts, no Docker socket, and no secrets.
- The bar for the checker: no wrongful deduction on a compliant solution, at least 90% of violations caught, at most 20% unsure.

The reason behind all of them is in the brief: a wrongful deduction can push a student below a pass mark, and if one constraint is misread systematically, all 80 students lose marks at once.

## Decisions made in PA#2

### 1. Node 22, TypeScript and Fastify 5

- **Status:** decided.
- **Choice:** one language, TypeScript in strict mode, run by `tsx` with no build step. Fastify 5 for HTTP, Vitest for tests, ESLint and Prettier for checks (`AGENTS.md`).
- **Other options:** Python with FastAPI. Node with Express. Separate services in several languages, as in the brief's original proposal (three services, three languages, five data stores).
- **Why:** Inferred, the repository does not record it. With one language the API, the worker and the checker share code, above all the hard rules and the model client. `app.inject()` lets the contract tests call the app without a network. Node 22 ships `node:sqlite`, so a database needs no native package. The brief allows any stack and says that fewer moving parts is a legitimate decision.
- **Trade-offs:** Node runs JavaScript on one thread, so CPU-heavy work such as compiling and parsing code has to stay out of the API process. That is one reason for a separate worker. Running TypeScript through `tsx` avoids a build step, but `tsx` is a dev dependency in `package.json`, so a production image must install it or the team must move it. Strict TypeScript catches mistakes early and costs some writing speed.
- **Change it when:** start-up time or image size matters, or someone on the team cannot work in TypeScript.

### 2. Errors as problem+json with fixed titles

- **Status:** decided.
- **Choice:** every error is RFC 9457 `application/problem+json`, sent only through `sendProblem`. Each problem `type` has one fixed title and status.
- **Other options:** plain bodies such as `{ "error": "message" }`, or the framework's default errors.
- **Why:** Recorded in `AGENTS.md`: clients branch on `type`, not on text. Fixed titles let the contract tests copy exact values from the contract.
- **Trade-offs:** a fixed title cannot describe a particular case, so each case needs its own type. This already shows: `forbidden-role` is titled "Only TAs may publish marks", which does not fit endpoints for admins or students. More types also means a longer contract for every endpoint.
- **Change it when:** the types multiply faster than clients use them. Then use fewer, more general types and put the specifics in `detail`.

### 3. Contract first, and tests copy the contract

- **Status:** decided.
- **Choice:** an endpoint is defined by `docs/contract/<endpoint>.md`. To change behaviour, change the contract first, in its own commit, then the code and the tests. Contract tests copy statuses and titles from the contract and never import them from `src/`.
- **Other options:** code first and document afterwards, or generate the documentation from the code.
- **Why:** Recorded in `AI-LOG.md` (2026-11-08): the first draft had no title per error type, so the tests would have copied titles from the code and could never fail. `AGENTS.md` also forbids a Fastify JSON schema on a contracted route, because Fastify would answer 422 before 401 and break the contract's order of checks.
- **Trade-offs:** more writing before coding, and two copies of each fact (the contract and the tests) that can drift apart. Every contract change costs its own commit, which hurts in a deadline week. In exchange the contract catches a change of behaviour that nobody meant. PR 2 of PA#2 showed this: a deliberate change from 409 to 400 turned a required check red.
- **Change it when:** hand-written contracts become a bottleneck. Then generate the contract from a schema and keep the tests.

### 4. One CI job per check, required by name, and a secret scan

- **Status:** decided.
- **Choice:** lint, format check, type check and tests are four separate jobs. Branch protection requires each one. Gitleaks scans the full git history.
- **Other options:** one job that runs all four, or a scan of the diff only.
- **Why:** Recorded in a comment of `.github/workflows/ci.yml`: each check is its own job so that branch protection can require it by name. A red job also shows which check failed.
- **Trade-offs:** every job installs the dependencies again (the cache helps), so CI takes more minutes. A full-history scan gets slower as the history grows. In exchange a failure points at one check, and a secret that was committed and later deleted is still found.
- **Change it when:** CI minutes or waiting time become a problem. Then share the install step between jobs.

### 5. Protected main, and three permission tiers for the assistant

- **Status:** decided.
- **Choice:** `main` accepts only pull requests with five required checks. The coding assistant works in three tiers. Allowed: read, edit `src/`, run the checks. Ask first: install packages, commit, push, tag, edit tests, contracts or workflows, make network calls. Never: read `.env`, push to `main`, force-push, run Docker on the host, call a real model from tests.
- **Other options:** trust the assistant fully, or allow only reads.
- **Why:** Recorded in `docs/PERMISSIONS.md`: a test, the contract or CI can be edited to make a check pass, and pushing or tagging is visible to others. The never tier covers what cannot be undone.
- **Trade-offs:** every commit, push and package install needs a human answer, which costs time near a deadline. The rule against Docker on the host means the sandbox tests can run only in CI, so a developer cannot repeat them locally without breaking the rule. At the moment the checks are also left to CI instead of being run locally, so a mistake shows only after a push.
- **Change it when:** the Docker rule blocks real work, for example while debugging the sandbox. Change that line of `docs/PERMISSIONS.md` in its own pull request.

### 6. Google Gemini free tier with a US$0 cap

- **Status:** decided for the provider. The model itself is open.
- **Choice:** the Google Gemini API on the free tier. The key is made on a Google Cloud project with no billing account. It lives only in `.env` and in CI secrets.
- **Other options:** a paid provider with a budget cap, or a model that runs on our own machine.
- **Why:** Recorded in `README.md`: with no billing account the key cannot be charged, and requests over the free quota are refused with HTTP 429, not billed.
- **Trade-offs:** the quota limits how fast the dev-set run and the deployment can call the model, so a burst of 80 submissions may hit 429 and produce `unsure`. That is safe but not helpful. Google may use free-tier prompts to improve its products, which is why only the statement, one constraint and code without comments or identity are sent. Free-tier limits and terms can change. The cost of one lab in the README will be a calculation at list prices, not an invoice. Because the test accounts are published in `PA3.md`, anyone can spend the quota, so the quota is the spending cap.
- **Change it when:** 429 makes the product unusable in the PA#5 load test, or the free terms change.

## Decisions proposed for PA#3

### 7. One repository, two processes: the API and the worker

- **Status:** proposed.
- **Choice:** the API and the judge worker are two processes of one codebase. They share the database file and the code for hard rules and the model client.
- **Other options:** judge inside the request handler. Separate services, as in the original proposal. An external queue service such as Redis.
- **Why:** the PA#3 rubric wants a queue and a separate worker, and scores a direct call from the request handler lower (11 to 16 of 20). A separate process also keeps compiling and judging 80 submissions from blocking the API. One repository means the checker command reuses the same hard rules and model client. The brief says that fewer moving parts is a legitimate choice.
- **Trade-offs:** both processes must open the same SQLite file, so they run on one host and workers cannot be spread over machines. Two processes are two things to deploy, watch and restart. A bug in shared code hits both. In exchange there is no network protocol between them to design, version or secure.
- **Change it when:** the PA#5 load test with 80 simultaneous submissions shows that one host cannot keep up. Then move to Postgres and several workers.

### 8. SQLite as the database and as the queue

- **Status:** proposed.
- **Choice:** one SQLite file (the `node:sqlite` module of Node 22, in WAL mode) holds all the data. The `submissions` table is also the queue: a worker claims a row with one `UPDATE ... RETURNING`.
- **Other options:** Postgres. SQLite plus a queue service. Keeping the in-memory store.
- **Why:** there is no extra service to run, in CI or in production. A claim is one atomic statement, and rules such as one verdict per submission and constraint are enforced by the database itself. `node:sqlite` is built in, so there is no native build and no new package. Creating a submission and queueing it is one insert.
- **Trade-offs:** SQLite takes one writer at a time (readers continue in WAL mode), so a burst of writes waits. The writes are short, but this is unproven until the load test. Both processes must be on the same machine. The worker polls the table, so a job waits up to the poll interval. We write the lease and retry logic ourselves instead of using a queue library. `node:sqlite` is marked experimental and prints an ExperimentalWarning, so its API could change. `better-sqlite3` is the stable alternative but adds a native dependency. A backup is a file copy, and migrations are written by hand.
- **Change it when:** write contention shows in the load test, or the system must run on more than one machine. Most of the schema moves to Postgres as it is. The claim would use `FOR UPDATE SKIP LOCKED`, and the timestamp defaults would change.

### 9. Leases and a guarded finish for exactly-once judging

- **Status:** proposed.
- **Choice:** a claim sets `locked_by` and `lease_until`. The worker extends the lease while it works. An expired lease puts the job back, up to three attempts, and then marks it `failed`. A worker that catches an error that is not the student's releases the job at once. The finish is one transaction that updates the row only if this worker still holds it and the lab is still open, and a unique key refuses a second verdict.
- **Other options:** delete the job when it is taken (at most once). A long lock with no expiry. Trust a single worker never to crash.
- **Why:** the rubric asks for exactly one set of verdicts after the worker is stopped and started, even if the judging itself ran twice. A job held by a worker that crashes must not be lost or stuck. The SQL was run against an in-memory SQLite: a stale worker writes nothing, and a second finish is refused.
- **Trade-offs:** a job can be judged twice, which repeats the sandbox run and the model calls, so it can cost money twice. The lease length is a guess: too short causes duplicate runs, too long delays recovery. More states mean more code and more tests.
- **Change it when:** duplicate judging shows up in the model call log. Then lengthen the lease or send the heartbeat more often.

### 10. Our own Docker sandbox instead of Judge0

- **Status:** proposed.
- **Choice:** the worker starts one short-lived container per submission with `docker run`. The code goes in on stdin. The container has no network, a memory limit equal to its swap limit, a process limit, a non-root user, a read-only filesystem, dropped capabilities and no mounts.
- **Other options:** a self-hosted Judge0 (the rubric accepts it, and then the tests attack its configuration). gVisor or Firecracker for stronger isolation.
- **Why:** with our own flags we can prove each of the nine minimums with our own attack submission, and there is no extra service to run. Judge0 brings its own stack and a large configuration surface to secure.
- **Trade-offs:** a container shares the host kernel, so a kernel bug could let code escape. The flags reduce that risk but do not remove it. The worker needs access to Docker, which is close to root on the host, so it must accept no inbound connections. A container per run costs start-up time compared with a warm pool. The sandbox tests need Docker, so they run only in CI.
- **Change it when:** a red-team attack in PA#4 gets out. Then run the containers under gVisor, or switch to Judge0.

### 11. A syntax-aware parser for the hard rules

- **Status:** proposed. A one-hour test decides.
- **Choice:** ban-list constraints are decided by code that reads C++ syntax: tree-sitter (a parser that runs in Node as WebAssembly) if it works on Windows and in CI, and otherwise a hand-written tokenizer.
- **Other options:** regular expressions or a text search (the rubric scores them 3 to 7 of 15). A full compiler front end such as clang.
- **Why:** the traps are about syntax: a banned name in a comment or a string, a function of the student's own named `sort`, `<algorithm>` included only for `std::swap`. The constraint "no loop statements" is about statements, not names. The rule must work on any problem, so it reads the banned names from the backticks in the constraint text.
- **Trade-offs:** tree-sitter gives a syntax tree but not meaning. It does not expand macros or decide which `sort` a bare call means, so disguised cases (a macro or an alias that hides the name) need extra code. It adds a WebAssembly dependency. A tokenizer has no dependency, but we must write the scope rules ourselves. Clang resolves names and macros exactly, but it is a large binary in the image and slower.
- **Change it when:** the dev set shows wrongful deductions or missed disguised violations that the parser cannot express.

### 12. One model call per submission and semantic constraint

- **Status:** proposed.
- **Choice:** each semantic constraint of each Accepted submission gets its own call, and the prompt holds only that constraint.
- **Other options:** one call per submission with all its constraints. One call per lab.
- **Why:** a failure, a timeout or an injection touches only one constraint, which becomes `unsure`, not the whole submission. The prompt is shorter and the evidence maps to one constraint. Cost and latency are recorded per call.
- **Trade-offs:** more calls. In the dev set a lab has zero, one or two semantic constraints, so a lab of 80 submissions needs at most about 160 calls. That costs more time and quota, and the code is sent more than once. On the free tier it raises the chance of HTTP 429.
- **Change it when:** quota or cost per lab is too high. Then put all constraints of one submission in a single call, and accept that they fail together.

### 13. Rules for what goes to the model and what comes back

- **Status:** proposed.
- **Choice:** the prompt holds the statement, one constraint and the code with its comments blanked (line breaks kept) and no identity. The answer must match a strict schema: a verdict of `pass`, `violation` or `unsure` and evidence lines. Any other key, a violation without evidence, an invalid answer or a timeout becomes `unsure`.
- **Other options:** send the whole submission with comments. Accept free text and parse it. Retry bad answers until one is valid.
- **Why:** comments are where injections and hints hide. Blanking them but keeping the line numbers lets each evidence line be mapped back to the original text, which the eval needs. The brief and the syllabus rule forbid a model answer from being used without a schema check and a time limit. A schema with no deduction field makes it impossible for the model to set one.
- **Trade-offs:** useful comments that explain intent are lost, so the model may be less sure. String literals still reach the model and can carry instructions, so the schema and the human gate are what limit the damage. More answers become `unsure`, and the PA#4 limit is 20%; every unsure is work for a TA. Retrying would lower the unsure rate but multiplies the cost.
- **Change it when:** the dev-set run shows too many unsure. Then try one retry and measure the extra cost.

### 14. Verdicts only in the review queue, and no web interface in PA#3

- **Status:** proposed.
- **Choice:** a verdict can be read only through the TA's review queue. A student sees the status and the judge result of their own submission. PA#3 has an API and no web pages.
- **Other options:** show verdicts to students at once. Build a web interface now.
- **Why:** the brief makes the human gate the step that is hard to undo, and nothing in this build turns a verdict into a mark. The FAQ agrees: before Publish a student sees only test results (FAQ-08). The rubric accepts the API for the walk-through, and with two days left the time goes into the sandbox, the queue and the model.
- **Trade-offs:** the TA must review every violation and every unsure before Publish, which is work and delays the marks. Students get no early signal about a constraint violation. Demos and grading use `curl` or scripts, which is harder to follow than a screen. A web interface is still needed for the real-time results of PA#5.
- **Change it when:** the lecturer asks for a screen in the demo, or the product owners change FAQ-08.

### 15. Hosting on one Azure for Students VM

- **Status:** proposed. A team member suggested it on 2026-11-24 and the configuration is in `docs/DEPLOYMENT.md`. The VM is not created yet.
- **Choice:** one Ubuntu VM (2 vCPU and 4 GiB at first) in an Azure for Students subscription. It runs the API, the worker and the sandbox containers with Docker, behind Caddy with HTTPS on a free Azure DNS name.
- **Other options:** a small VPS from another provider. A team member's computer with a tunnel such as Cloudflare Tunnel. A platform that cannot run Docker, which cannot run the sandbox. Serverless.
- **Why:** the worker starts containers, so the host must be a machine with Docker, and a VM stays up on its own. The student credit should cover the weeks needed, and, as far as we know, it has a spending limit, which suits a deployment whose test accounts are public. There is no domain to buy.
- **Trade-offs:** nobody knows yet whether the HCMUS student account qualifies, or which regions and sizes the subscription allows. A burstable VM slows down under sustained load, so compiling for every submission and the PA#5 load test may need a bigger size. One person owns the subscription, so the others need access. The credit could end before the PA#4 marks. The VM is the security boundary and must hold no identity and no other secrets. The deployment is plain Docker and Compose, so moving to another host is mostly copying the Compose file and the data volume.
- **Change it when:** the subscription cannot create a suitable VM, the credit runs short, or the load test shows the size is wrong. Then use another VPS or a tunnel.

### 16. The dev set copied unchanged and pinned by hash

- **Status:** proposed. It sits on the branch `chore/pa3-dev-set`, which is not merged yet.
- **Choice:** the lecturer's dev set lives unchanged in `leetkob-eval/`. It is excluded from lint and format. A planned test pins the SHA-256 of `eval.mjs` and `labels.jsonl`. The team's own cases go in a separate folder.
- **Other options:** a git submodule or a download step in CI. Editing the files to fit our tools.
- **Why:** the rubric scores 0 on the checker criterion if the dev set or `eval.mjs` was edited, and the lecturer re-scores with their own copy. A copy keeps the repository self-contained, so CI and the marker's container need no network. Prettier would rewrite `eval.mjs` and ESLint would reject its use of `process`, so both must skip the folder.
- **Trade-offs:** 128 files and about 2.6 MB in the history. If the lecturer republishes the set, we replace it by hand and the pinned hash fails until we update it. Because of the ignores, none of our tools checks that folder.
- **Change it when:** the lecturer changes the published set.

### 17. The lecturer's requirements come first

- **Status:** decided.
- **Choice:** when sources disagree the order is the lecturer (the class brief, the rubrics, the published dev set and `eval.mjs`), then the product owners' FAQ where the brief is silent, then the team's own choices. Every FAQ entry we rely on is cited in the repository.
- **Other options:** follow the FAQ literally, or follow whatever the team finds best.
- **Why:** Recorded: the brief (section 8) says that the brief wins over the FAQ, and the FAQ says the same about itself. The PA#3 rubric (criterion 5) asks for the FAQ to be cited for what a student sees before publishing. A team member stated this rule on 2026-11-24.
- **Trade-offs:** some FAQ rules are delayed or reduced, so the product can differ from what the product owners wrote. The deadline is optional, and every Accepted submission is reviewed instead of only the last one (section 1.1 of `docs/ARCHITECTURE.md`). Each such case needs an answer from the lecturer, and until it comes the rubric's walk-through decides. The FAQ can also change, so a citation must name the entry.
- **Change it when:** the lecturer says that a FAQ rule must be followed as written.

### 18. Publish also waits for queued and running submissions

- **Status:** proposed. One team member agreed on 2026-11-24. The contract now says it (`docs/contract/publish-lab.md`, section "What blocks publishing"). The code and the tests do not follow it yet.
- **Choice:** Publish refuses while any review item is pending and while any submission of the lab is `queued` or `running`. The worker's finish also refuses to write into a lab that is already published.
- **Other options:** count only the review items, as the contract does today. Count only the latest submission of each student, which would follow FAQ-02 but not the rubric's walk-through.
- **Why:** a submission that is still waiting has no review item, so counting only the items lets Publish succeed with a submission that was not even judged. That breaks the brief's rule that marks are published only after the TA has reviewed them (section 3). The gap and the fix were both run against the real schema.
- **Trade-offs:** a stuck job blocks Publish until it is judged or fails: up to about 3 minutes with the lease rules, less with the release on error. A `failed` submission is not counted yet, which is an open point. Publish reads one more count in its transaction. The tests and the code have to follow the contract, each in its own commit.
- **Change it when:** the team adopts FAQ-02's rule that only the last submission is graded. Then count only those submissions.

### 19. A database check to limit how fast a student can submit

- **Status:** decided on 2026-11-24 by a team member, for now. The team plans to review later whether to move to a library.
- **Choice:** two checks per student, made in the same transaction that inserts the submission. At most `SUBMIT_MAX_PENDING` submissions queued or running (default 15), and at most `SUBMIT_MAX_PER_MINUTE` created in the last 60 seconds (default 30). A student over a limit gets 429 `too-many-submissions` with `Retry-After`, and nothing is stored. The check reads the `submissions` table and the index on `(student_id, created_at)`.
- **Other options:** (a) a rate-limit library, such as the official Fastify plugin. (b) a limit at the proxy or tunnel in front of the app. (c) a hard cap on the number of submissions, which FAQ-02 does not allow.
- **Why:** the pending cap depends on state (which submissions are queued or running), which a request counter does not know. The check and the insert are one transaction, so two requests at the same moment cannot both pass. It needs no new dependency, survives a restart, and counts only real submissions. The current handlers authenticate inside the handler, so a library keyed by user would first need authentication moved into a hook, and a library keyed by IP would put all students behind one university network under one limit. The defaults stay well above what the lecturer's flows need (the walk-through of three submissions and about ten attack submissions), and they are environment variables.
- **Trade-offs:** it protects submissions only: login, malformed requests and a flood spread over many accounts are not limited. We write and test the code ourselves, and the numbers are a guess. A window of 60 seconds is exact but has no "burst then steady refill" shape. Two accounts can still queue up to 30 jobs. Every submission costs three small count queries.
- **Change it when:** the PA#4 red team or the logs show abuse that this does not cover, or the team wants one limit for every route. Then add a library or a proxy limit for the generic cases and keep this check for the domain rules. A library with an in-memory store would also need Redis if the API ever runs as more than one process.

## Adding a decision

When the team makes a choice that is hard to undo, add a section with the same six lines (status, choice, other options, why, trade-offs, change it when) and a row in the table at the top. If a choice here changes, change its section in the same pull request, and say what replaced it. If a proposed decision is confirmed, change its status to decided and say who confirmed it.
