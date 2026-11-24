# Contract — `POST /classes/{classId}/labs`

Creates a lab in a class: its statement, its limits, its tests and its constraints with
their deductions. Students of the class can submit to it as soon as it exists.

Status: specified here first. Nothing in this file is implemented yet. The code and the
tests follow in later commits (task T5 in `docs/TASKS.md`).

## Who may call it

| Rule          | Value                                                                                                                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authenticated | `Authorization: Bearer <token>`, as in [`auth-login.md`](auth-login.md), section "Using the token". No, unknown or expired token → `unauthenticated` (401).                                     |
| Role          | `ta` only. A `student` or `admin` → `role-not-allowed` (403).                                                                                                                                   |
| Ownership     | The TA must be assigned to the class. A TA of another class gets `class-not-found` (404), the **same response** as for a class that does not exist, so a TA cannot learn which class ids exist. |

## Request

```
POST /classes/{classId}/labs
Authorization: Bearer <token>
Content-Type: application/json
```

| Part             | Rule                                                                       |
| ---------------- | -------------------------------------------------------------------------- |
| `classId` (path) | String. Opaque class id. Unknown → `class-not-found`.                      |
| `Content-Type`   | `application/json`. A body with any other type → `unsupported-media-type`. |
| Body size        | At most 8 MiB. A larger body → `payload-too-large` (413).                  |

Body:

```json
{
  "title": "Merge sort",
  "statementMd": "# Sort the numbers\n\nRead n, then n integers...",
  "deadline": null,
  "timeLimitMs": 1000,
  "memoryLimitMb": 256,
  "tests": [{ "input": "5\n3 1 4 1 5\n", "expectedOutput": "1 1 3 4 5\n" }],
  "constraints": [
    {
      "text": "Do not call a library sort function: `std::sort`, `std::stable_sort`, `qsort`.",
      "deduction": 3
    },
    {
      "text": "Sort with a merge sort you wrote yourself: split the range, sort both halves, merge them.",
      "deduction": 4
    }
  ]
}
```

| Field                     | Type           | Rule                                                                                                                                                             |
| ------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`                   | string         | **Required.** 1–200 characters after trimming.                                                                                                                   |
| `statementMd`             | string         | **Required.** 1–100 000 characters. Markdown, stored as given. It is the statement the model receives.                                                           |
| `deadline`                | string \| null | Optional, default `null` (no deadline). ISO 8601 with a time zone (`Z` or `+07:00`), and in the future when the lab is created. Stored in UTC.                   |
| `timeLimitMs`             | integer        | Optional, default `1000`. CPU time per test, 1000–5000 (FAQ-05). Wall time is 3 times this, set by the sandbox.                                                  |
| `memoryLimitMb`           | integer        | Optional, default `256`. 64–512 (FAQ-05).                                                                                                                        |
| `tests`                   | array          | **Required.** 1–50 tests, judged in this order.                                                                                                                  |
| `tests[].input`           | string         | **Required.** 0–2 MiB in UTF-8. Given to the program on standard input.                                                                                          |
| `tests[].expectedOutput`  | string         | **Required.** 0–1 MiB in UTF-8, the output limit of the sandbox (FAQ-05): a longer output could never be accepted. Compared token by token, ignoring whitespace. |
| `constraints`             | array          | **Required.** 0–20 constraints. An empty list is allowed: then an Accepted submission gets no verdict.                                                           |
| `constraints[].text`      | string         | **Required.** 1–2000 characters after trimming.                                                                                                                  |
| `constraints[].deduction` | integer        | **Required.** 0–10, points out of 10 taken off for a violation (the dev set's `deduction`). The TA's number: no verdict and no model changes it.                 |

No other fields are allowed, at any level. A body that is missing, not an object, not
valid JSON, has an unknown field, or breaks a rule above → `validation-failed` (422).

### How the server reads a constraint

The server, not the client, decides the kind of each constraint, by the rule of the dev
set (`leetkob-eval/README.md`):

- A text that starts with `Do not use` or `Do not call` (after trimming, case as written)
  is a **ban list**. Its banned names are every name written in backticks in the text,
  in order, without duplicates. A ban list with no name in backticks →
  `validation-failed` with the pointer `/constraints/<i>/text`, because code could not
  decide it.
- Any other text is **semantic**, with no banned names. The model judges it.

Constraints get the codes `C1`, `C2`, ... in the order they are sent.

## Responses

### `201 Created` — the lab was created

```http
HTTP/1.1 201 Created
Content-Type: application/json
Location: /labs/lab-7f3c2a

{
  "id": "lab-7f3c2a",
  "classId": "class-a",
  "title": "Merge sort",
  "status": "open",
  "deadline": null,
  "timeLimitMs": 1000,
  "memoryLimitMb": 256,
  "testCount": 1,
  "constraints": [
    {
      "code": "C1",
      "text": "Do not call a library sort function: `std::sort`, `std::stable_sort`, `qsort`.",
      "kind": "ban_list",
      "bannedNames": ["std::sort", "std::stable_sort", "qsort"],
      "deduction": 3
    },
    {
      "code": "C2",
      "text": "Sort with a merge sort you wrote yourself: split the range, sort both halves, merge them.",
      "kind": "semantic",
      "bannedNames": [],
      "deduction": 4
    }
  ],
  "createdBy": "u-ta-1",
  "createdAt": "2026-11-26T09:00:00.000Z"
}
```

| Field                       | Type                         | Meaning                                                                                     |
| --------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------- |
| `id`                        | string                       | The new lab's id, opaque. Also in `Location`.                                               |
| `classId`                   | string                       | Echo of the path parameter.                                                                 |
| `title`                     | string                       | The title, trimmed.                                                                         |
| `status`                    | `"open"`                     | Always this value for a new lab.                                                            |
| `deadline`                  | string \| null               | The deadline in UTC, ISO 8601, or `null`.                                                   |
| `timeLimitMs`               | integer                      | The limit in force, default included.                                                       |
| `memoryLimitMb`             | integer                      | The limit in force, default included.                                                       |
| `testCount`                 | integer ≥ 1                  | How many tests were stored. The tests themselves are not repeated here.                     |
| `constraints[].code`        | string                       | `C1`, `C2`, ...                                                                             |
| `constraints[].text`        | string                       | The text, trimmed.                                                                          |
| `constraints[].kind`        | `"ban_list"` \| `"semantic"` | How the server read the text, so the TA can see it and fix the text if it was read wrongly. |
| `constraints[].bannedNames` | string[]                     | The names a hard rule looks for. Empty for a semantic constraint.                           |
| `constraints[].deduction`   | integer                      | The TA's number.                                                                            |
| `createdBy`                 | string                       | User id of the TA.                                                                          |
| `createdAt`                 | string, ISO 8601             | UTC time of creation.                                                                       |

The statement is not repeated in the answer either. `GET /labs/{labId}` returns the
whole lab.

Sending the same body twice creates two labs. There is no idempotency key on this
endpoint: a duplicate lab is visible, harmless and easy to ignore.

## Errors

Every error is `application/problem+json` (RFC 9457), with `type`, `title`, `status` and
`instance` always present. `title` is fixed per `type`. Every `type` below is
`https://leetkob.example/problems/<slug>`.

| Slug                     | Status | `title`                   | When                                                                                  | Extra members                                                                                   |
| ------------------------ | ------ | ------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `payload-too-large`      | 413    | Request body is too large | The body is larger than the endpoint allows.                                          | `limitBytes`: integer, the endpoint's limit.                                                    |
| `unsupported-media-type` | 415    | Unsupported media type    | A body is sent with a `Content-Type` other than `application/json`.                   | none                                                                                            |
| `validation-failed`      | 422    | Request body is invalid   | No body, body is not valid JSON, or it breaks the body rules.                         | `errors`: array of `{ "pointer": "/tests/0/expectedOutput", "message": "..." }` (JSON Pointer). |
| `unauthenticated`        | 401    | Authentication required   | No `Authorization: Bearer` header, or the token is unknown or expired.                | none                                                                                            |
| `role-not-allowed`       | 403    | Your role may not do this | The caller's role may not call this endpoint.                                         | `requiredRole`: the role the endpoint needs, here `"ta"`.                                       |
| `class-not-found`        | 404    | Class not found           | No such class, **or** the TA is not assigned to it.                                   | none                                                                                            |
| `internal`               | 500    | Internal server error     | Unexpected server error. The lab may or may not exist: list the labs before retrying. | none                                                                                            |

For `class-not-found`, `detail` is the same for both causes, so the two responses differ
only in `instance`.

`role-not-allowed` is new, for every endpoint after Publish. `forbidden-role` keeps its
title "Only TAs may publish marks" and stays on Publish only, so the Publish contract and
its tests do not change.

### Order of checks

When several errors apply, the first one in this order wins:

1. `payload-too-large`. The size is checked before the body is read.
2. `unsupported-media-type`, then JSON syntax (`validation-failed`). The body is parsed before authentication.
3. `unauthenticated`
4. `role-not-allowed`
5. `class-not-found` (existence and ownership)
6. `validation-failed` (body rules, then the reading of each constraint)
7. `201`

## What happens when it succeeds

- The lab, its tests and its constraints are stored in one transaction: either all of
  them exist or none.
- The lab is `open`. Students of the class may submit to it at once.
- The tests are visible to the TAs of the class only, never to a student (FAQ-02). The
  constraints and their deductions are visible to the students of the class from now on
  (FAQ-06).

## Not in this contract

Editing or deleting a lab, its tests or its constraints after creation (FAQ-07), listing
the labs of a class, uploading tests as files, and how the deduction becomes a mark.
