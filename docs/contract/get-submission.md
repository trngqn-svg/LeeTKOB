# Contract — `GET /submissions/{submissionId}`

Reads one submission: where it is in the queue and, once it is judged, the judge result
and the result of each test. A student polls it after
[`POST /labs/{labId}/submissions`](submit.md). It never contains a constraint verdict.

Status: specified here first. Nothing in this file is implemented yet. The code and the
tests follow in later commits (task T6 in `docs/TASKS.md`).

## Who may call it

| Rule          | Value                                                                                                                                                                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authenticated | `Authorization: Bearer <token>`, as in [`auth-login.md`](auth-login.md), section "Using the token". No, unknown or expired token → `unauthenticated` (401).                                                                                                                |
| Role          | `student` or `ta`. An `admin` → `role-not-allowed` (403).                                                                                                                                                                                                                  |
| Ownership     | A student may read **only their own** submissions. A TA may read every submission of a lab of **their class**. Anyone else, including another student of the same class, gets `submission-not-found` (404), the **same response** as for a submission that does not exist. |

## Request

```
GET /submissions/{submissionId}
Authorization: Bearer <token>
```

| Part                  | Rule                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `submissionId` (path) | String. Opaque id from the `202` of [`submit.md`](submit.md). Unknown → `submission-not-found`. |

No query parameters and no body. A body, if sent, is ignored.

## Responses

### `200 OK`

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: private, no-store

{
  "id": "sub-91d0e4",
  "labId": "lab-7f3c2a",
  "studentId": "u-st-1",
  "status": "judged",
  "judgeResult": "wrong_answer",
  "judgeDetail": {
    "tests": [
      { "position": 1, "result": "passed", "timeMs": 4 },
      { "position": 2, "result": "wrong_answer", "timeMs": 6 }
    ]
  },
  "sourceCode": "#include <iostream>\n...",
  "createdAt": "2026-11-26T09:15:00.000Z",
  "startedAt": "2026-11-26T09:15:01.000Z",
  "finishedAt": "2026-11-26T09:15:03.000Z"
}
```

| Field         | Type                                                  | Meaning                                                                         |
| ------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| `id`          | string                                                | The submission's id.                                                            |
| `labId`       | string                                                | The lab it was sent to.                                                         |
| `studentId`   | string                                                | The student who sent it.                                                        |
| `status`      | `"queued"` \| `"running"` \| `"judged"` \| `"failed"` | Where it is. See "Status" below.                                                |
| `judgeResult` | string \| null                                        | Set only when `status` is `judged`, otherwise `null`. See "Judge result" below. |
| `judgeDetail` | object \| null                                        | Set only when `status` is `judged`, otherwise `null`. See "Judge detail" below. |
| `sourceCode`  | string                                                | The source exactly as sent.                                                     |
| `createdAt`   | string, ISO 8601                                      | UTC time it was stored.                                                         |
| `startedAt`   | string \| null                                        | UTC time a worker first took it, or `null` while it has never been taken.       |
| `finishedAt`  | string \| null                                        | UTC time it became `judged` or `failed`, otherwise `null`.                      |

The answer is the same for the student and for a TA.

**Never in this answer:** a constraint verdict, evidence lines, a review item, a model
answer, a deduction or a mark, and no test input or expected output. A student sees only
the test results before Publish (FAQ-02, FAQ-08). A TA reads verdicts in the review
queue ([`review-queue.md`](review-queue.md)).

### Status

| `status`  | Meaning                                                                                                                            | Final |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `queued`  | Waiting for a worker. It goes back to this state if a worker stopped in the middle; it is then judged again, once.                 | no    |
| `running` | A worker is compiling and running it.                                                                                              | no    |
| `judged`  | Done. `judgeResult` and `judgeDetail` are set.                                                                                     | yes   |
| `failed`  | Judging failed several times because of **the system** (for example the sandbox was down), **not because of the code**. No result. | yes   |

A client polls while the status is `queued` or `running`. Once every second or two is
enough.

### Judge result

| `judgeResult`   | Meaning                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| `accepted`      | Compiled, and every test passed. Only an Accepted submission is checked against the constraints (FAQ-04). |
| `compile_error` | `g++ -std=c++17 -O2` failed, or took more than 10 seconds (FAQ-05). No test ran.                          |
| `wrong_answer`  | A test's output differs from the expected output, compared token by token, whitespace ignored.            |
| `runtime_error` | A test ended with a crash or a non-zero exit code, or wrote more than 1 MiB of output (FAQ-05).           |
| `time_limit`    | A test used more CPU time than the lab allows, or more than 3 times that in wall time.                    |
| `memory_limit`  | A test used more memory than the lab allows.                                                              |

### Judge detail

For `compile_error`:

```json
{ "compilerMessage": "main.cpp:3:1: error: expected ';' before '}' token\n..." }
```

`compilerMessage` is what the compiler printed, cut to its first 16 KiB.

For every other result:

```json
{ "tests": [{ "position": 1, "result": "passed", "timeMs": 4 }] }
```

| Field              | Type                                                                                      | Meaning                                  |
| ------------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------- |
| `tests[].position` | integer ≥ 1                                                                               | The test's position in the lab.          |
| `tests[].result`   | `"passed"` \| `"wrong_answer"` \| `"runtime_error"` \| `"time_limit"` \| `"memory_limit"` | The outcome of this test.                |
| `tests[].timeMs`   | integer ≥ 0                                                                               | CPU time the test used, in milliseconds. |

Tests run in their order. Judging **stops at the first test that does not pass**: `tests`
holds the results up to and including that test, and `judgeResult` is that test's
result. For `accepted`, `tests` holds every test of the lab, all `passed`.

## Errors

Every error is `application/problem+json` (RFC 9457), with `type`, `title`, `status` and
`instance` always present. `title` is fixed per `type`. Every `type` below is
`https://leetkob.example/problems/<slug>`.

| Slug                   | Status | `title`                   | When                                                                                              | Extra members                        |
| ---------------------- | ------ | ------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `unauthenticated`      | 401    | Authentication required   | No `Authorization: Bearer` header, or the token is unknown or expired.                            | none                                 |
| `role-not-allowed`     | 403    | Your role may not do this | The caller is an admin.                                                                           | `requiredRole`: `["student", "ta"]`. |
| `submission-not-found` | 404    | Submission not found      | No such submission, **or** the caller is a student who did not send it, or a TA of another class. | none                                 |
| `internal`             | 500    | Internal server error     | Unexpected server error. Safe to retry.                                                           | none                                 |

For `submission-not-found`, `detail` is the same for every cause, so the responses differ
only in `instance`.

### Order of checks

When several errors apply, the first one in this order wins:

1. `unauthenticated`
2. `role-not-allowed`
3. `submission-not-found` (existence and ownership)
4. `200`

## Not in this contract

Listing a student's submissions or a lab's submissions, being told when judging ends
(real-time results are PA#5), requeueing a `failed` submission, and what a student sees
after Publish (PA#5).
