# Contract — `POST /labs/{labId}/submissions`

A student submits C++ source code to a lab. The answer comes at once, before any
judging: the submission is queued, and a separate worker judges it later. The student
follows it with [`GET /submissions/{submissionId}`](get-submission.md).

Status: specified here first. Nothing in this file is implemented yet. The code and the
tests follow in later commits (task T6 in `docs/TASKS.md`).

## Who may call it

| Rule          | Value                                                                                                                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authenticated | `Authorization: Bearer <token>`, as in [`auth-login.md`](auth-login.md), section "Using the token". No, unknown or expired token → `unauthenticated` (401).                                                                       |
| Role          | `student` only. A `ta` or `admin` → `role-not-allowed` (403).                                                                                                                                                                     |
| Ownership     | The student must be a member of the **class the lab belongs to**. Anyone else gets `lab-not-found` (404), the **same response** as for a lab that does not exist, so a student cannot learn which lab ids exist in other classes. |

## Request

```
POST /labs/{labId}/submissions
Authorization: Bearer <token>
Content-Type: application/json
```

| Part           | Rule                                                                       |
| -------------- | -------------------------------------------------------------------------- |
| `labId` (path) | String. Opaque lab id. Unknown → `lab-not-found`.                          |
| `Content-Type` | `application/json`. A body with any other type → `unsupported-media-type`. |
| Body size      | At most 256 KiB. A larger body → `payload-too-large` (413).                |

Body:

```json
{ "sourceCode": "#include <iostream>\nint main() { ... }\n" }
```

| Field        | Type   | Rule                                                                                                                                                                                        |
| ------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sourceCode` | string | **Required.** At least 1 character that is not whitespace. At most **64 KiB (65 536 bytes) in UTF-8** (FAQ-05); more → `payload-too-large` with `limitBytes` 65536. Stored exactly as sent. |

No other fields are allowed. A body that is missing, not an object, not valid JSON,
has an unknown field, or breaks a rule above → `validation-failed` (422).

The body limit (256 KiB) is larger than the source limit (64 KiB) because JSON escaping
can make a source longer than it is. The source limit is the one that counts.

The language is C++17, compiled with `g++ -std=c++17 -O2` inside the sandbox. There is no
field to choose another one.

## Responses

### `202 Accepted` — the submission is queued

```http
HTTP/1.1 202 Accepted
Content-Type: application/json
Location: /submissions/sub-91d0e4

{
  "submissionId": "sub-91d0e4",
  "labId": "lab-7f3c2a",
  "status": "queued",
  "createdAt": "2026-11-26T09:15:00.000Z",
  "notice": "If this submission is Accepted, automatic rules and an AI model check it against the lab's constraints. The model receives your code without comments, name or student ID. No deduction reaches your mark until a TA has reviewed it."
}
```

| Field          | Type             | Meaning                                                                                                                                                                                                                                                                      |
| -------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `submissionId` | string           | The new submission's id, opaque. Also in `Location`.                                                                                                                                                                                                                         |
| `labId`        | string           | Echo of the path parameter.                                                                                                                                                                                                                                                  |
| `status`       | `"queued"`       | Always this value here. The submission then moves to `running` and `judged` (or `failed`, a failure of the system), as `get-submission.md` describes.                                                                                                                        |
| `createdAt`    | string, ISO 8601 | UTC time the submission was stored.                                                                                                                                                                                                                                          |
| `notice`       | string           | Exactly the text above, the same for every submission. It tells the student about the review, as the brief requires ("Students are told about the review when they submit", section 3): who checks the code, what the model receives, and that a TA decides every deduction. |

The answer never contains a judge result or a verdict: nothing is judged yet.

Each call stores a new submission. A retried request stores a second one. There is no
idempotency key: a student may submit any number of times before the deadline (FAQ-02),
so a duplicate is just one more submission.

## Limits on submitting

These limits slow a flood down. They never cap the number of submissions (FAQ-02,
decision 19 in `docs/DECISIONS.md`). Both count the calling student's own submissions,
in all labs, and are checked in the same transaction that stores the submission.

| Limit               | Default | Set by                  | Over it                                                                           |
| ------------------- | ------- | ----------------------- | --------------------------------------------------------------------------------- |
| Pending submissions | 15      | `SUBMIT_MAX_PENDING`    | The student already has this many `queued` or `running` → `too-many-submissions`. |
| Recent submissions  | 30      | `SUBMIT_MAX_PER_MINUTE` | The student made this many in the last 60 seconds → `too-many-submissions`.       |

A refused submission is not stored and does not count against the student. For the
recent limit the answer carries `Retry-After`: the whole seconds, rounded up, until the
oldest of those submissions is more than 60 seconds old. The pending limit has no
`Retry-After`, because nobody knows when a judging ends.

## Errors

Every error is `application/problem+json` (RFC 9457), with `type`, `title`, `status` and
`instance` always present. `title` is fixed per `type`. Every `type` below is
`https://leetkob.example/problems/<slug>`. Nothing is stored when any of them is answered.

| Slug                     | Status | `title`                      | When                                                                                             | Extra members                                                                                                    |
| ------------------------ | ------ | ---------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `payload-too-large`      | 413    | Request body is too large    | The body is larger than 256 KiB, or `sourceCode` is larger than 64 KiB in UTF-8.                 | `limitBytes`: 262144 for the body, 65536 for the source.                                                         |
| `unsupported-media-type` | 415    | Unsupported media type       | A body is sent with a `Content-Type` other than `application/json`.                              | none                                                                                                             |
| `validation-failed`      | 422    | Request body is invalid      | No body, body is not valid JSON, or it breaks the body rules.                                    | `errors`: array of `{ "pointer": "/sourceCode", "message": "..." }` (JSON Pointer).                              |
| `unauthenticated`        | 401    | Authentication required      | No `Authorization: Bearer` header, or the token is unknown or expired.                           | none                                                                                                             |
| `role-not-allowed`       | 403    | Your role may not do this    | The caller is a TA or an admin.                                                                  | `requiredRole`: `"student"`.                                                                                     |
| `lab-not-found`          | 404    | Lab not found                | No such lab, **or** the student is not a member of the lab's class.                              | none                                                                                                             |
| `lab-published`          | 409    | The lab is already published | The lab is `published` ([`publish-lab.md`](publish-lab.md)): it takes no more submissions.       | `publishedAt`: ISO 8601.                                                                                         |
| `deadline-passed`        | 409    | The deadline has passed      | The lab has a deadline and it is in the past.                                                    | `deadline`: ISO 8601.                                                                                            |
| `too-many-submissions`   | 429    | Too many submissions         | One of the two limits above.                                                                     | `limit`: `"pending"` or `"per-minute"`. `max`: the limit in force. Header `Retry-After` for `"per-minute"` only. |
| `internal`               | 500    | Internal server error        | Unexpected server error. The submission may or may not be stored: check before submitting again. | none                                                                                                             |

For `lab-not-found`, `detail` is the same for both causes, so the two responses differ
only in `instance`.

### Order of checks

When several errors apply, the first one in this order wins:

1. `payload-too-large` for the body. The size is checked before the body is read.
2. `unsupported-media-type`, then JSON syntax (`validation-failed`). The body is parsed before authentication.
3. `unauthenticated`
4. `role-not-allowed`
5. `lab-not-found` (existence and membership)
6. `validation-failed` (body rules)
7. `payload-too-large` for the source
8. `lab-published`
9. `deadline-passed`
10. `too-many-submissions`
11. `202`

The size of the source, the state of the lab and the deadline come before the limits on
submitting (`docs/ARCHITECTURE.md`, section 6.6), so a request that would be refused
anyway does not use up the student's limit.

## What happens when it succeeds

- One row is stored with status `queued`, in the same transaction as the limit checks.
- The worker claims it later, compiles and runs it in the sandbox, and, if it is
  Accepted, checks it against every constraint of the lab. Its verdicts go only to the
  TA's review queue. The student never sees a verdict before Publish (FAQ-08).
- The source code is visible to the student who sent it and to the TAs of the class.

## Not in this contract

Choosing a language, uploading a file instead of JSON, deleting or replacing a
submission, late submissions (FAQ-03), which submission counts for the mark (FAQ-02:
the last one before the deadline, not applied in PA#3), and being told when judging ends.
