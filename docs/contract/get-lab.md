# Contract — `GET /labs/{labId}`

Reads one lab: its statement, its limits, its deadline, its status and its constraints
with their deductions. A TA of the class can also ask for the tests with
`?include=tests`. A student never gets them.

Status: specified here first. Nothing in this file is implemented yet. The code and the
tests follow in later commits (task T5 in `docs/TASKS.md`).

## Who may call it

| Rule          | Value                                                                                                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authenticated | `Authorization: Bearer <token>`, as in [`auth-login.md`](auth-login.md), section "Using the token". No, unknown or expired token → `unauthenticated` (401).                                                                     |
| Role          | `ta` or `student`. An `admin` → `role-not-allowed` (403). Admins manage accounts and classes; they have no access to labs.                                                                                                      |
| Ownership     | The caller must be a member of the **class the lab belongs to**. Anyone else gets `lab-not-found` (404), the **same response** as for a lab that does not exist, so a caller cannot learn which lab ids exist in other classes. |

## Request

```
GET /labs/{labId}
GET /labs/{labId}?include=tests
Authorization: Bearer <token>
```

| Part              | Rule                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `labId` (path)    | String. Opaque id from `POST /classes/{classId}/labs`. Unknown → `lab-not-found`.                                                                                                                       |
| `include` (query) | Optional. The only value is `tests`: the answer then carries the member `tests`. TA only: a student who sends it → `role-not-allowed`. Any other value, or the parameter given twice → `invalid-query`. |

No other query parameter is allowed: one → `invalid-query`. No body. A body, if sent, is
ignored.

Without `include=tests` the answer is the same for a TA and a student, and stays small
even when the tests are large (a lab's tests can reach several MiB, see
[`create-lab.md`](create-lab.md)).

## Responses

### `200 OK` — a TA with `?include=tests`

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: private, no-store

{
  "id": "lab-7f3c2a",
  "classId": "class-a",
  "title": "Merge sort",
  "statementMd": "# Sort the numbers\n\nRead n, then n integers...",
  "status": "open",
  "deadline": null,
  "publishedAt": null,
  "timeLimitMs": 1000,
  "memoryLimitMb": 256,
  "constraints": [
    {
      "code": "C1",
      "text": "Do not call a library sort function: `std::sort`, `std::stable_sort`, `qsort`.",
      "kind": "ban_list",
      "bannedNames": ["std::sort", "std::stable_sort", "qsort"],
      "deduction": 3
    }
  ],
  "createdBy": "u-ta-1",
  "createdAt": "2026-11-26T09:00:00.000Z",
  "testCount": 1,
  "tests": [{ "position": 1, "input": "5\n3 1 4 1 5\n", "expectedOutput": "1 1 3 4 5\n" }]
}
```

### `200 OK` — without `include` (a TA or a student)

The same body **without** the member `tests`. `testCount` stays, so a student knows how
many tests a submission runs. The members of each constraint are the same for a TA and a
student: the student sees every constraint and its deduction from the day the lab opens
(FAQ-06).

| Field           | Type                             | Meaning                                                                                                                 |
| --------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `id`            | string                           | The lab's id.                                                                                                           |
| `classId`       | string                           | The class the lab belongs to.                                                                                           |
| `title`         | string                           | The title.                                                                                                              |
| `statementMd`   | string                           | The statement, Markdown, as the TA sent it.                                                                             |
| `status`        | `"open"` \| `"published"`        | `published` once a TA has pressed Publish ([`publish-lab.md`](publish-lab.md)).                                         |
| `deadline`      | string \| null                   | The deadline in UTC, ISO 8601, or `null` for no deadline.                                                               |
| `publishedAt`   | string \| null                   | UTC time of the first successful Publish, or `null`.                                                                    |
| `timeLimitMs`   | integer                          | CPU time per test.                                                                                                      |
| `memoryLimitMb` | integer                          | Memory limit.                                                                                                           |
| `constraints[]` | array                            | In code order: `code`, `text`, `kind`, `bannedNames`, `deduction`, as in [`create-lab.md`](create-lab.md).              |
| `createdBy`     | string                           | User id of the TA who created the lab.                                                                                  |
| `createdAt`     | string, ISO 8601                 | UTC time of creation.                                                                                                   |
| `testCount`     | integer ≥ 1                      | How many tests the lab has.                                                                                             |
| `tests[]`       | array, only with `include=tests` | `position` (1-based, the order of judging), `input`, `expectedOutput`. Only for a TA. Never sent to a student (FAQ-02). |

The answer never contains a verdict, a review item or a mark: those are read through the
review queue, by a TA (FAQ-08). `Cache-Control: private, no-store` keeps the tests and
the statement out of shared caches.

## Errors

Every error is `application/problem+json` (RFC 9457), with `type`, `title`, `status` and
`instance` always present. `title` is fixed per `type`. Every `type` below is
`https://leetkob.example/problems/<slug>`.

| Slug               | Status | `title`                    | When                                                                                                                       | Extra members                                       |
| ------------------ | ------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `unauthenticated`  | 401    | Authentication required    | No `Authorization: Bearer` header, or the token is unknown or expired.                                                     | none                                                |
| `invalid-query`    | 400    | Query parameter is invalid | An unknown query parameter, an unknown value of `include`, or `include` given twice.                                       | `parameter`: the name of the first wrong parameter. |
| `role-not-allowed` | 403    | Your role may not do this  | The caller is an admin (`requiredRole`: `["ta", "student"]`), or a student sends `include=tests` (`requiredRole`: `"ta"`). | `requiredRole`: the role or roles that may do it.   |
| `lab-not-found`    | 404    | Lab not found              | No such lab, **or** the caller is not a member of the lab's class.                                                         | none                                                |
| `internal`         | 500    | Internal server error      | Unexpected server error. Safe to retry.                                                                                    | none                                                |

For `lab-not-found`, `detail` is the same for both causes, so the two responses differ
only in `instance`.

`requiredRole` is a string when one role may call the endpoint
([`create-lab.md`](create-lab.md)) and an array of strings when several may.

### Order of checks

When several errors apply, the first one in this order wins:

1. `unauthenticated`
2. `role-not-allowed` (the caller is an admin)
3. `invalid-query`
4. `lab-not-found` (existence and membership)
5. `role-not-allowed` (a student sends `include=tests`)
6. `200`

The student's `include=tests` is checked after membership on purpose: a student of
another class gets `lab-not-found`, as for any other request, and learns nothing about
the lab.

## Not in this contract

Listing the labs of a class, reading one test at a time, editing a lab, and what a
student sees after Publish (PA#5).
