# Contract — `GET /labs/{labId}/review-queue`

The TA's review queue for one lab. It lists every submission of the lab and, for each
Accepted one, the verdict on every constraint with its evidence lines and the deduction
the TA chose. The verdicts that need the TA's decision carry a review item. This is the
**only** place where a verdict can be read.

Status: specified here first. Nothing in this file is implemented yet. The code and the
tests follow in later commits (task T8 in `docs/TASKS.md`).

## Who may call it

| Rule          | Value                                                                                                                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authenticated | `Authorization: Bearer <token>`, as in [`auth-login.md`](auth-login.md), section "Using the token". No, unknown or expired token → `unauthenticated` (401).                                                                        |
| Role          | `ta` only. A `student` or `admin` → `role-not-allowed` (403). A student never reads a verdict before Publish (FAQ-08).                                                                                                             |
| Ownership     | The TA must be assigned to the **class the lab belongs to**. A TA of another class gets `lab-not-found` (404), the **same response** as for a lab that does not exist. This is the isolation the PA#3 rubric checks (criterion 1). |

## Request

```
GET /labs/{labId}/review-queue
GET /labs/{labId}/review-queue?pending=true
Authorization: Bearer <token>
```

| Part              | Rule                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `labId` (path)    | String. Opaque lab id. Unknown → `lab-not-found`.                                                                                                                              |
| `pending` (query) | Optional, `true` or `false`, default `false`. `true` keeps only the submissions that have at least one pending review item. Any other value, or given twice → `invalid-query`. |

No other query parameter is allowed: one → `invalid-query`. No body. A body, if sent, is
ignored.

## Responses

### `200 OK`

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: private, no-store

{
  "labId": "lab-7f3c2a",
  "labStatus": "open",
  "summary": {
    "submissions": 3,
    "pendingReviews": 2,
    "unjudgedSubmissions": 0,
    "failedSubmissions": 0
  },
  "constraints": [
    { "code": "C1", "text": "Do not call a library sort function: `std::sort`, ...", "kind": "ban_list", "deduction": 3 },
    { "code": "C2", "text": "Sort with a merge sort you wrote yourself: ...", "kind": "semantic", "deduction": 4 }
  ],
  "submissions": [
    {
      "submissionId": "sub-91d0e4",
      "studentId": "u-st-1",
      "studentName": "Student One",
      "status": "judged",
      "judgeResult": "accepted",
      "createdAt": "2026-11-26T09:15:00.000Z",
      "verdicts": [
        {
          "constraintCode": "C1",
          "deduction": 3,
          "verdict": "violation",
          "decidedBy": "hard_rule",
          "reasonCode": null,
          "evidence": [{ "line": 12, "text": "std::sort(a, a + n);" }],
          "reviewItem": {
            "id": 41,
            "reason": "violation",
            "status": "pending",
            "finalVerdict": null,
            "finalEvidence": null,
            "note": null,
            "reviewedBy": null,
            "reviewedAt": null
          }
        },
        {
          "constraintCode": "C2",
          "deduction": 4,
          "verdict": "pass",
          "decidedBy": "model",
          "reasonCode": null,
          "evidence": [],
          "reviewItem": null
        }
      ]
    }
  ]
}
```

#### The lab

| Field                         | Type                      | Meaning                                                                                    |
| ----------------------------- | ------------------------- | ------------------------------------------------------------------------------------------ |
| `labId`                       | string                    | Echo of the path parameter.                                                                |
| `labStatus`                   | `"open"` \| `"published"` | Once `published`, every item is read-only.                                                 |
| `summary.submissions`         | integer ≥ 0               | Submissions in `submissions` below, after the filter.                                      |
| `summary.pendingReviews`      | integer ≥ 0               | Review items of the lab without a decision. Always for the whole lab, whatever the filter. |
| `summary.unjudgedSubmissions` | integer ≥ 0               | Submissions of the lab that are `queued` or `running`. Whole lab.                          |
| `summary.failedSubmissions`   | integer ≥ 0               | Submissions of the lab that are `failed`. Whole lab.                                       |
| `constraints[]`               | array                     | The lab's constraints in code order: `code`, `text`, `kind`, `deduction`.                  |

Publish succeeds only when `pendingReviews`, `unjudgedSubmissions` and
`failedSubmissions` are all 0 ([`publish-lab.md`](publish-lab.md)). The three numbers
are the same ones Publish counts, so the TA sees here what still blocks it.

#### Each submission

Every submission of the lab, of every student and in every status, oldest first. With
`pending=true`, only those with a pending review item.

| Field          | Type                                                  | Meaning                                                                                                                          |
| -------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `submissionId` | string                                                | The submission's id. Its source and test results are in [`get-submission.md`](get-submission.md).                                |
| `studentId`    | string                                                | The student who sent it.                                                                                                         |
| `studentName`  | string                                                | The student's display name. The TA sees it here. The model never does.                                                           |
| `status`       | `"queued"` \| `"running"` \| `"judged"` \| `"failed"` | As in [`get-submission.md`](get-submission.md).                                                                                  |
| `judgeResult`  | string \| null                                        | As in [`get-submission.md`](get-submission.md). `null` unless `judged`.                                                          |
| `createdAt`    | string, ISO 8601                                      | UTC time it was stored.                                                                                                          |
| `verdicts[]`   | array                                                 | One entry per constraint, in code order, when the submission is `judged` and `accepted`. **Empty** in every other case (FAQ-04). |

Every Accepted submission appears with **all** its verdicts, including a compliant one
whose verdicts are all `pass` and none of them sampled. The PA#3 rubric (criterion 1)
expects the queue to show each submission and each constraint.

#### Each verdict

| Field            | Type                                       | Meaning                                                                                                                                                                                |
| ---------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `constraintCode` | string                                     | `C1`, `C2`, ...                                                                                                                                                                        |
| `deduction`      | integer                                    | The deduction the TA chose for this constraint when the lab was created. It is the constraint's number: neither the verdict nor the model sets it (FAQ-11).                            |
| `verdict`        | `"pass"` \| `"violation"` \| `"unsure"`    | What the pipeline decided.                                                                                                                                                             |
| `decidedBy`      | `"hard_rule"` \| `"model"` \| `"fallback"` | `hard_rule`: code decided a ban-list constraint and the model was not called. `model`: the model's answer passed the schema check. `fallback`: nobody could decide, so it is `unsure`. |
| `reasonCode`     | string \| null                             | Why it fell back: `model_off`, `timeout`, `schema_invalid`, `model_error`, `evidence_mismatch`, `cost_cap` or `rule_error`. `null` unless `decidedBy` is `fallback`.                   |
| `evidence[]`     | array of `{ line, text }`                  | Lines of the **original** source, 1-based, with their exact text. At least one for a `violation`. Empty for a fallback.                                                                |
| `reviewItem`     | object \| null                             | Present when the verdict needs the TA's decision: every `violation`, every `unsure`, and the passes drawn in the 10% sample (brief section 3). `null` for a pass that was not drawn.   |

The model's own text is never shown: only the verdict and the evidence that passed the
checks are stored.

#### Each review item

| Field           | Type                                      | Meaning                                                                                                   |
| --------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `id`            | integer                                   | The item's id, for [`POST /review-items/{itemId}/decision`](review-decision.md).                          |
| `reason`        | `"violation"` \| `"unsure"` \| `"sample"` | Why it is in the queue.                                                                                   |
| `status`        | `"pending"` \| `"reviewed"`               | `pending` until a TA decides it.                                                                          |
| `finalVerdict`  | `"pass"` \| `"violation"` \| null         | The TA's decision, `null` while pending. Never `unsure` (FAQ-09).                                         |
| `finalEvidence` | array of `{ line, text }` \| null         | The evidence the TA kept or gave. At least one line when `finalVerdict` is `violation`, otherwise `null`. |
| `note`          | string \| null                            | The TA's note.                                                                                            |
| `reviewedBy`    | string \| null                            | User id of the TA who decided it.                                                                         |
| `reviewedAt`    | string \| null                            | UTC time of the decision.                                                                                 |

## Errors

Every error is `application/problem+json` (RFC 9457), with `type`, `title`, `status` and
`instance` always present. `title` is fixed per `type`. Every `type` below is
`https://leetkob.example/problems/<slug>`.

| Slug               | Status | `title`                    | When                                                                                                     | Extra members                                       |
| ------------------ | ------ | -------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `unauthenticated`  | 401    | Authentication required    | No `Authorization: Bearer` header, or the token is unknown or expired.                                   | none                                                |
| `role-not-allowed` | 403    | Your role may not do this  | The caller is a student or an admin.                                                                     | `requiredRole`: `"ta"`.                             |
| `invalid-query`    | 400    | Query parameter is invalid | An unknown query parameter, a value of `pending` other than `true` or `false`, or `pending` given twice. | `parameter`: the name of the first wrong parameter. |
| `lab-not-found`    | 404    | Lab not found              | No such lab, **or** the TA is not assigned to the lab's class.                                           | none                                                |
| `internal`         | 500    | Internal server error      | Unexpected server error. Safe to retry.                                                                  | none                                                |

For `lab-not-found`, `detail` is the same for both causes, so the two responses differ
only in `instance`.

### Order of checks

When several errors apply, the first one in this order wins:

1. `unauthenticated`
2. `role-not-allowed`
3. `invalid-query`
4. `lab-not-found` (existence and ownership)
5. `200`

## Not in this contract

Paging (a lab of 80 students is answered whole in PA#3), sorting and other filters,
showing the model's prompt or call log (not through the API), changing a verdict that
has no review item (FAQ-10, later), and what a student sees after Publish (PA#5).
