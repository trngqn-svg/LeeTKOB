# Plan: an API page (Swagger UI) for the demo

Status: built on 27 November (`docs/swagger/`, `tests/unit/openapi.test.ts`, and the `/docs/` block in `deploy/Caddyfile`); not yet seen in a browser on the deployment. Written on 27 November for whoever builds it (the plan is meant to be handed to a coding assistant). It is optional work: it earns no rubric points by itself, but it makes the lecturer's walk-through and the video easier. Time-box it to about three hours, and drop it if the code freeze (Saturday 28, 18:00) is near and anything required is open.

## 1. Goal

One web page on the deployment, at `https://leetkob-hcmus.koreacentral.cloudapp.azure.com/docs/`, that lists the nine endpoints, lets a person log in, press "Authorize" once, and try the whole flow with the mouse: create a lab, submit, poll, read the review queue, decide, publish.

## 2. The decision: a hand-written spec, served as static files

`@fastify/swagger` builds the spec from the JSON schemas of the routes. We must not do that: `AGENTS.md` forbids a Fastify JSON schema on a contracted route, because Fastify would validate before the handler and answer 422 before 401, which breaks the order of checks in the contracts. So:

- The spec is a file we write by hand from `docs/contract/*.md` (the contracts stay the source of truth).
- It is served as static files by **Caddy**, not by the API. No API code changes, no new dependency in `package.json`, and nothing new for the PA#4 red team to attack in the Node process.
- Swagger UI itself comes from a pinned version on cdnjs with an integrity hash (SRI), because Caddy has no `node_modules`.

## 3. Files to add

| File                         | What it is                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| `docs/swagger/openapi.json`  | OpenAPI 3.0.3, JSON (no YAML parser needed, and Prettier formats it)                                   |
| `docs/swagger/index.html`    | The page: loads Swagger UI from cdnjs (exact version, `integrity` attribute), no inline script         |
| `docs/swagger/init.js`       | Starts Swagger UI on `openapi.json` (a separate file, so the CSP needs no `unsafe-inline` for scripts) |
| `tests/unit/openapi.test.ts` | Checks the spec against `docs/contract/` (see section 5)                                               |

Changes to existing files: `deploy/Caddyfile` and `deploy/compose.yaml` (serve the folder), `README.md` (the folder-structure tree, as `AGENTS.md` requires, one line per new file), `docs/DEPLOYMENT.md` (one paragraph), `AI-LOG.md` (an entry).

## 4. What the spec must contain

- `info.description`: a short "demo in 8 steps" (below), and the notice that the accounts hold no real data.
- `servers`: `[{"url": "/"}]`, so "Try it out" calls the same host, with no CORS.
- `components.securitySchemes.bearer`: `http` / `bearer`. Every operation except `/health` and `/auth/login` has `security: [{"bearer": []}]`.
- Every operation: summary, who may call it (role and ownership, copied from the contract), path and query parameters, the request body with the field rules, and **every response status the contract lists** with the problem `type` and `title` of each error (RFC 9457, `application/problem+json`). Success bodies follow the contract's examples.
- Request examples that work on the seeded data: logins for `ta1@leetkob.example` and `student1@leetkob.example` (password field left as `<the password of PA3.md>`, never the real value), a lab for `class-a` built from our own `eval-own/` problem (power-mod), and a source code example from `eval-own/solutions/`. **Do not use code or names from `leetkob-eval/`** (`AGENTS.md`: never quote dev-set code).
- The nine operations, exactly: `GET /health`, `POST /auth/login`, `POST /classes/{classId}/labs`, `GET /labs/{labId}`, `POST /labs/{labId}/submissions`, `GET /submissions/{submissionId}`, `GET /labs/{labId}/review-queue`, `POST /review-items/{itemId}/decision`, `POST /labs/{labId}/publish`.

Demo in 8 steps (goes into `info.description`):

1. Log in as `ta1`, copy the token, press Authorize.
2. `POST /classes/class-a/labs`: create the lab, copy its `id`.
3. Press Authorize again with the token of `student1` (log in as them first).
4. `POST /labs/{labId}/submissions`: send a solution, copy `submissionId`.
5. `GET /submissions/{submissionId}` until `status` is `judged`.
6. Log in as `ta1` again: `GET /labs/{labId}/review-queue`.
7. `POST /review-items/{itemId}/decision` for each pending item.
8. `POST /labs/{labId}/publish`.

## 5. Tests first (the rubric reads the commit history)

Commit the test red, then the files green, as for every other task.

`tests/unit/openapi.test.ts` must:

- parse `docs/swagger/openapi.json` and check `openapi` starts with `3.0`;
- read the first request line (`GET /...`, `POST /...`) of every file in `docs/contract/` and check that each path and method is in the spec, and that the spec has no operation the contracts do not have (except `GET /health`);
- for each contract, check that every status code in its responses table is a response of the operation in the spec (copy the numbers from the contract with a regex; never import anything from `src/`);
- check that `index.html` has no inline `<script>` and that every `<script src>` and `<link href>` to another host carries an `integrity` attribute.

The test reads only files, so it needs no server and no Docker.

## 6. Caddy and Compose

In `deploy/Caddyfile`, inside the site block, before `reverse_proxy`:

```
handle /docs/* {
	root * /srv
	file_server
	header Content-Security-Policy "default-src 'none'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' https://cdnjs.cloudflare.com 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
}
redir /docs /docs/
```

(The exact directives are for the builder to check with `caddy validate`; the point is: `/docs/` is files, everything else goes to the API, and the CSP allows only our host and cdnjs.) In `deploy/compose.yaml`, under `caddy`: `- ../docs/swagger:/srv/docs:ro`.

## 7. Safety rules

- The page is static and holds no secret, no real password, no token. The login password is typed by the user.
- `connect-src 'self'` means the page can talk only to our own API.
- No cookies are used by the API (bearer tokens), so a page on the same host adds no session risk.
- The page is public, so the PA#4 red team will see it. That is fine: the endpoints are public anyway, and the contracts are in the repository.
- Pin the Swagger UI version (for example `swagger-ui-dist@5.x.y`, at least two weeks old) and its SRI hash. Do not use a floating `latest`.

## 8. Rules the builder must follow

- Read `AGENTS.md` first. Contract first: if the spec and a contract disagree, the contract wins and the spec is fixed.
- Never edit `leetkob-eval/`, an existing test, or a contract to make something pass.
- When you create a file, add it to the tree in `README.md` in the same commit.
- Do not run lint, format, typecheck or tests locally: leave them to GitHub Actions (project rule). Formatting is `npx -y prettier@3.9.10`, and only when the owner says so.
- One part per commit: the test (red), then the spec and page (green), then Caddy and Compose, then the docs and `AI-LOG.md`.
- Work on a branch and open a PR. Never push to `main`.

## 9. Done when

- The unit test is green in CI and every other check stays green.
- `caddy validate` accepts the Caddyfile (run it in the Caddy container, not on the host).
- After the owner redeploys (`docs/DEPLOYMENT.md`, section 7.2, step 5), `https://leetkob-hcmus.koreacentral.cloudapp.azure.com/docs/` shows the nine operations, and the 8 steps above work from the page, ending with a published lab.
- `/health` and the API paths still answer as before, and `/docs/` has the CSP header (`curl -I`).

## 10. Not in this plan

A UI for students or TAs, real-time results (PA#5), generating the spec from code, and a second copy of the contracts in another format.
