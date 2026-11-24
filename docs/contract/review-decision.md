# Contract — `POST /review-items/{itemId}/decision`

A TA decides one review item: the final verdict is `pass` or `violation`, never `unsure`
(FAQ-09). An item is decided once. Publish waits until every item of the lab is decided
([`publish-lab.md`](publish-lab.md)).

Status: specified here first. Nothing in this file is implemented yet. The code and the
tests follow in later commits (task T8 in `docs/TASKS.md`).

## Who may call it

| Rule          | Value                                                                                                                                                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authenticated | `Authorization: Bearer <token>`, as in [`auth-login.md`](auth-login.md), section "Using the token". No, unknown or expired token → `unauthenticated` (401).                                                                             |
| Role          | `ta` only. A `student` or `admin` → `role-not-allowed` (403).                                                                                                                                                                           |
| Ownership     | The TA must be assigned to the class of the item's lab. A TA of another class gets `review-item-not-found` (404), the **same response** as for an item that does not exist. Any TA of the class may decide, not only the lab's creator. |

## Request

```
POST /review-items/{itemId}/decision
Authorization: Bearer <token>
Content-Type: application/json
```

| Part            | Rule                                                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `itemId` (path) | A positive integer, the `reviewItem.id` of [`review-queue.md`](review-queue.md). Unknown, or not a positive integer → `review-item-not-found`. |
| `Content-Type`  | `application/json`. A body with any other type → `unsupported-media-type`.                                                                     |
| Body size       | At most 64 KiB. A larger body → `payload-too-large` (413).                                                                                     |

Body:

```json
{
  "finalVerdict": "violation",
  "evidence": [{ "line": 12, "text": "std::sort(a, a + n);" }],
  "note": "Calls std::sort through an alias."
}
```

| Field             | Type                      | Rule                                                                                                                                                                             |
| ----------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `finalVerdict`    | `"pass"` \| `"violation"` | **Required.** `unsure` is not allowed: the TA must decide (FAQ-09).                                                                                                              |
| `evidence`        | array of `{ line, text }` | **Required and non-empty when `finalVerdict` is `violation`**, at most 20 lines. Must be absent or empty when it is `pass`. The TA may keep the pipeline's lines or give others. |
| `evidence[].line` | integer ≥ 1               | A line number of the submission's **original** source.                                                                                                                           |
| `evidence[].text` | string                    | That line's text. It must equal the source line, leading and trailing whitespace ignored, as in the eval (`leetkob-eval/README.md`).                                             |
| `note`            | string \| null            | Optional. 0–1000 characters. Shown to the other TAs of the class in the review queue.                                                                                            |

There is **no deduction field**. A violation costs the constraint's own deduction, set
when the lab was created, once per submission (FAQ-11).

No other fields are allowed. A body that is missing, not an object, not valid JSON, has
an unknown field, breaks a rule above, or cites a line that is not in the source, or
whose text differs from it → `validation-failed` (422).

## Responses

### `200 OK` — the item is decided

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "reviewItem": {
    "id": 41,
    "submissionId": "sub-91d0e4",
    "constraintCode": "C1",
    "reason": "violation",
    "status": "reviewed",
    "finalVerdict": "violation",
    "finalEvidence": [{ "line": 12, "text": "std::sort(a, a + n);" }],
    "note": "Calls std::sort through an alias.",
    "reviewedBy": "u-ta-1",
    "reviewedAt": "2026-11-26T10:02:00.000Z"
  },
  "pendingReviews": 1
}
```

| Field            | Type        | Meaning                                                                                                                                     |
| ---------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `reviewItem`     | object      | The item as the review queue shows it, plus `submissionId` and `constraintCode`. `finalEvidence` is `null` for a `pass`.                    |
| `pendingReviews` | integer ≥ 0 | Review items of the lab still without a decision, after this one. When it is 0, only waiting or failed submissions can still block Publish. |

### Deciding again

An item is decided **once** (`docs/ARCHITECTURE.md`, section 4.2).

- The same decision again (the same `finalVerdict`, the same evidence lines and the same
  `note`), for example a retried request: `200` with the stored item. Nothing changes.
- A different decision → `review-already-decided` (409). Nothing changes. Changing a
  decided verdict, with a log of who changed it and why, is later (FAQ-10).

If two TAs decide the same item at the same moment, one decision is stored. The other
TA gets `200` if the two decisions are the same, otherwise `review-already-decided`.

## Errors

Every error is `application/problem+json` (RFC 9457), with `type`, `title`, `status` and
`instance` always present. `title` is fixed per `type`. Every `type` below is
`https://leetkob.example/problems/<slug>`. Nothing changes when any of them is answered.

| Slug                     | Status | `title`                            | When                                                                                                      | Extra members                                                                            |
| ------------------------ | ------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `payload-too-large`      | 413    | Request body is too large          | The body is larger than 64 KiB.                                                                           | `limitBytes`: 65536.                                                                     |
| `unsupported-media-type` | 415    | Unsupported media type             | A body is sent with a `Content-Type` other than `application/json`.                                       | none                                                                                     |
| `validation-failed`      | 422    | Request body is invalid            | No body, body is not valid JSON, it breaks the body rules, or an evidence line does not match the source. | `errors`: array of `{ "pointer": "/evidence/0/text", "message": "..." }` (JSON Pointer). |
| `unauthenticated`        | 401    | Authentication required            | No `Authorization: Bearer` header, or the token is unknown or expired.                                    | none                                                                                     |
| `role-not-allowed`       | 403    | Your role may not do this          | The caller is a student or an admin.                                                                      | `requiredRole`: `"ta"`.                                                                  |
| `review-item-not-found`  | 404    | Review item not found              | No such item, **or** the TA is not assigned to the class of the item's lab.                               | none                                                                                     |
| `lab-published`          | 409    | The lab is already published       | The item's lab is `published`: its review items are read-only.                                            | `publishedAt`: ISO 8601.                                                                 |
| `review-already-decided` | 409    | The review item is already decided | The item is `reviewed`, with a different decision.                                                        | `reviewItem`: the stored item, as in the `200` answer.                                   |
| `internal`               | 500    | Internal server error              | Unexpected server error. Safe to retry with the same body.                                                | none                                                                                     |

For `review-item-not-found`, `detail` is the same for both causes, so the two responses
differ only in `instance`.

### Order of checks

When several errors apply, the first one in this order wins:

1. `payload-too-large`. The size is checked before the body is read.
2. `unsupported-media-type`, then JSON syntax (`validation-failed`). The body is parsed before authentication.
3. `unauthenticated`
4. `role-not-allowed`
5. `review-item-not-found` (existence and ownership)
6. `validation-failed` (body rules, then each evidence line against the source)
7. `lab-published`
8. The item is already decided: `200` with the stored item if the decision is the same, otherwise `review-already-decided`
9. `200`

The check of the item's state and the decision happen in one transaction, so Publish
cannot run between them.

## What happens when it succeeds

- The item becomes `reviewed`, with the final verdict, the evidence, the note, the TA
  and the time. The pipeline's own verdict stays as it was, so both can be compared.
- A `violation` will cost the constraint's deduction once Publish runs. A `pass` costs
  nothing. No mark changes before Publish.
- The student sees nothing of it before Publish (FAQ-08).

## Not in this contract

Changing a decided item and its change log (FAQ-10), deciding several items in one call,
deciding a pass that has no review item, appeals after Publish (FAQ-13), and how the
final verdicts become marks.
