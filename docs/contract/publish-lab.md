# Contract — `POST /labs/{labId}/publish`

Publishes the marks of one lab. After this call students see their marks and may
appeal. It is the step in LeeTKOB that is hard to undo, so it is **safe to repeat**
and it **refuses while any review is pending**.

Status: implemented in [`src/routes/publish.ts`](../../src/routes/publish.ts), held to
this file by [`tests/contract/publish-lab.test.ts`](../../tests/contract/publish-lab.test.ts).

## Who may call it

| Rule          | Value                                                                                                                                                                                                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authenticated | `Authorization: Bearer <access token>`. No or unknown token → `unauthenticated` (401).                                                                                                                                                                                                   |
| Role          | `ta` only. A `student` or `admin` → `forbidden-role` (403). Admins manage accounts; they do not publish marks.                                                                                                                                                                           |
| Ownership     | The TA must be assigned to the **class the lab belongs to**. A TA of another class gets `lab-not-found` (404), the **same response** as for a lab that does not exist, so a TA cannot learn which lab ids exist in other classes. Any TA of the class may publish, not only its creator. |

## Request

```
POST /labs/{labId}/publish
Authorization: Bearer <token>
Idempotency-Key: <key>
Content-Type: application/json
```

| Part                     | Rule                                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `labId` (path)           | String. Opaque id from the labs API. Unknown → `lab-not-found`.                                                                                                        |
| `Idempotency-Key` header | **Required.** 1–64 characters from `A-Z a-z 0-9 _ -`. A fresh random value (a UUID works) per user action "Publish". Missing or malformed → `invalid-idempotency-key`. |
| `Content-Type`           | `application/json`. A body with any other type → `unsupported-media-type`.                                                                                             |

Body:

```json
{ "confirm": true, "note": "Sorting lab, reviewed 2026-11-10" }
```

| Field     | Type    | Rule                                                                                                  |
| --------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `confirm` | boolean | **Required**, must be exactly `true`. A client must not publish on a single click without confirming. |
| `note`    | string  | Optional. 0–500 characters. Stored with the publication, shown to other TAs of the class.             |

No other fields are allowed. A body that is missing, not an object, not valid JSON,
has an unknown field, or breaks a rule above → `validation-failed` (422).

## Responses

### `201 Created` — the lab was published by this call

```http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "labId": "lab-sort",
  "status": "published",
  "publishedAt": "2026-11-10T14:03:00.000Z",
  "publishedBy": "u-ta-1",
  "marksPublished": 80,
  "note": "Sorting lab, reviewed 2026-11-10"
}
```

| Field            | Type             | Meaning                                                    |
| ---------------- | ---------------- | ---------------------------------------------------------- |
| `labId`          | string           | Echo of the path parameter.                                |
| `status`         | `"published"`    | Always this value on success.                              |
| `publishedAt`    | string, ISO 8601 | UTC time of the **first** successful publish.              |
| `publishedBy`    | string           | User id of the TA who published first.                     |
| `marksPublished` | integer ≥ 0      | Number of submissions whose marks became visible.          |
| `note`           | string \| null   | The `note` of the **first** successful publish, or `null`. |

### `200 OK` — the lab was already published

Same body as above, describing the **existing** publication (its `publishedAt`,
`publishedBy`, `note`). Nothing changes. A client that receives 200 should treat it as
success and must not show "published" twice.

## Idempotency

Publishing is idempotent. There are three cases.

1. **Same `Idempotency-Key`, same body** (a retried request): the server returns the
   **stored response** (same status, same body) and the header `Idempotent-Replayed: true`.
   No side effect runs again.
2. **Same `Idempotency-Key`, different body** → `idempotency-key-reused` (422). Nothing
   happens. Use a new key for a new action.
3. **New key, lab already published** → `200 OK` with the existing publication. No side
   effect runs again.

Keys are scoped to **(caller, lab)**. Only successful (2xx) responses are stored. An
error is not stored, so a client may retry with the same key after fixing the cause
(for example, after the pending reviews are finished). Stored keys are kept for at
least 24 hours.

Two concurrent requests for the same lab produce exactly one publication. One gets
`201`, the other `200` (or a replay).

## Errors

Every error is `application/problem+json` (RFC 9457):

```json
{
  "type": "https://leetkob.example/problems/reviews-pending",
  "title": "Reviews are still pending",
  "status": 409,
  "detail": "3 reviews in this lab are still pending.",
  "instance": "/labs/lab-sort/publish",
  "pendingCount": 3
}
```

`type`, `title`, `status` and `instance` are always present. `title` is fixed per
`type`. `detail` is for humans and may change, so clients must branch on `type`, not
on `detail`. Every `type` below is `https://leetkob.example/problems/<slug>`.

| Slug                      | Status | `title`                                      | When                                                                | Extra members                                                                    |
| ------------------------- | ------ | -------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `unsupported-media-type`  | 415    | Unsupported media type                       | A body is sent with a `Content-Type` other than `application/json`. | none                                                                             |
| `validation-failed`       | 422    | Request body is invalid                      | No body, body is not valid JSON, or it breaks the body rules.       | `errors`: array of `{ "pointer": "/confirm", "message": "..." }` (JSON Pointer). |
| `unauthenticated`         | 401    | Authentication required                      | No `Authorization: Bearer` header, or the token is unknown.         | none                                                                             |
| `forbidden-role`          | 403    | Only TAs may publish marks                   | Caller is not a TA.                                                 | none                                                                             |
| `lab-not-found`           | 404    | Lab not found                                | No such lab, **or** the TA is not assigned to the lab's class.      | none                                                                             |
| `invalid-idempotency-key` | 400    | Idempotency-Key is missing or invalid        | `Idempotency-Key` missing or not matching the format.               | none                                                                             |
| `idempotency-key-reused`  | 422    | Idempotency-Key reused with a different body | Key already used by this caller on this lab with a different body.  | none                                                                             |
| `reviews-pending`         | 409    | Reviews are still pending                    | At least one item in the lab's review queue is not reviewed yet.    | `pendingCount`: integer ≥ 1.                                                     |
| `internal`                | 500    | Internal server error                        | Unexpected server error. Safe to retry with the same key.           | none                                                                             |

For `lab-not-found`, `detail` is the same for both causes, so the two responses differ
only in `instance`.

### Order of checks

When several errors apply, the first one in this order wins:

1. `unsupported-media-type`, then JSON syntax (`validation-failed`). The body is parsed before authentication.
2. `unauthenticated`
3. `forbidden-role`
4. `lab-not-found` (existence and ownership)
5. `invalid-idempotency-key`
6. `validation-failed` (body rules)
7. `idempotency-key-reused`, then replay of a stored response
8. Already published → `200`
9. `reviews-pending`
10. Publish → `201`

## What happens when it succeeds (201 only)

- The lab's status becomes `published`. It never goes back through this endpoint.
  Reopening marks belongs to appeals.
- The marks of every judged submission in the lab become visible to their students.
- Verdicts in the review queue become read-only. Later changes go through appeals.
- Appeals (`POST /submissions/{id}/appeals`) are accepted for this lab from `publishedAt` on.

`200`, a replay and every error change nothing.

## Not in this contract

Login and token issuing, how reviews are done, the appeals endpoint, and notifications
to students.
