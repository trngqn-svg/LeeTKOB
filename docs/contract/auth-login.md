# Contract — `POST /auth/login`

Exchanges an email and a password for a bearer token. Every other endpoint that needs
a caller reads this token from `Authorization: Bearer <token>`.

Status: specified here first. Nothing in this file is implemented yet. The code and the
tests follow in later commits (task T4 in `docs/TASKS.md`).

## Who may call it

Anyone. The endpoint needs no token.

## Request

```
POST /auth/login
Content-Type: application/json
```

| Part           | Rule                                                                       |
| -------------- | -------------------------------------------------------------------------- |
| `Content-Type` | `application/json`. A body with any other type → `unsupported-media-type`. |

Body:

```json
{ "email": "ta1@leetkob.example", "password": "a-test-password" }
```

| Field      | Type   | Rule                                                                               |
| ---------- | ------ | ---------------------------------------------------------------------------------- |
| `email`    | string | **Required.** 3–254 characters and contains `@`. Compared without regard to case.  |
| `password` | string | **Required.** 1–128 characters. Compared as given: no trimming, no change of case. |

No other fields are allowed. A body that is missing, not an object, not valid JSON,
has an unknown field, or breaks a rule above → `validation-failed` (422).

## Responses

### `200 OK` — the credentials are right

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store

{
  "token": "3q2-7wPZ...43 characters",
  "tokenType": "Bearer",
  "expiresAt": "2026-11-26T09:00:00.000Z",
  "user": {
    "id": "u-ta-1",
    "email": "ta1@leetkob.example",
    "displayName": "TA One",
    "role": "ta"
  }
}
```

| Field              | Type                               | Meaning                                                                                |
| ------------------ | ---------------------------------- | -------------------------------------------------------------------------------------- |
| `token`            | string                             | 32 random bytes, base64url without padding (43 characters). Shown only in this answer. |
| `tokenType`        | `"Bearer"`                         | Always this value.                                                                     |
| `expiresAt`        | string, ISO 8601                   | UTC time after which the token is refused. 24 hours after the login.                   |
| `user.id`          | string                             | The caller's user id.                                                                  |
| `user.email`       | string                             | The email as stored, which may differ in case from the one sent.                       |
| `user.displayName` | string                             | The name shown in the product.                                                         |
| `user.role`        | `"admin"` \| `"ta"` \| `"student"` | What the caller may do.                                                                |

The answer never contains the password or its hash. `Cache-Control: no-store` keeps the
token out of any cache.

Each successful login issues a new token. Earlier tokens of the same user stay valid
until they expire.

## Using the token

This section holds for every endpoint that needs a caller, so their contracts can refer
to it.

- The client sends `Authorization: Bearer <token>`.
- The server stores only the SHA-256 of the token (`sessions.token_hash`), never the
  token itself, so a copy of the database does not let anyone sign in.
- No header, a header that is not `Bearer <token>`, an unknown token and an expired
  token all get the same answer: `unauthenticated` (401). A client cannot tell an
  expired token from a wrong one, and must log in again.

## Errors

Every error is `application/problem+json` (RFC 9457), with `type`, `title`, `status` and
`instance` always present. `title` is fixed per `type`. Every `type` below is
`https://leetkob.example/problems/<slug>`.

| Slug                     | Status | `title`                    | When                                                                | Extra members                                                                  |
| ------------------------ | ------ | -------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `unsupported-media-type` | 415    | Unsupported media type     | A body is sent with a `Content-Type` other than `application/json`. | none                                                                           |
| `validation-failed`      | 422    | Request body is invalid    | No body, body is not valid JSON, or it breaks the body rules.       | `errors`: array of `{ "pointer": "/email", "message": "..." }` (JSON Pointer). |
| `invalid-credentials`    | 401    | Email or password is wrong | No user has this email, or the password does not match.             | none                                                                           |
| `internal`               | 500    | Internal server error      | Unexpected server error. Safe to retry.                             | none                                                                           |

`invalid-credentials` is the same answer, with the same `detail`, whether the email is
unknown or the password is wrong, so the endpoint does not tell which emails have an
account. The server also takes about the same time for both: it checks a password hash
even when the email is unknown.

### Order of checks

When several errors apply, the first one in this order wins:

1. `unsupported-media-type`, then JSON syntax (`validation-failed`).
2. `validation-failed` (body rules)
3. `invalid-credentials`
4. `200`

## Not in this contract

Logging out and revoking a token, changing or resetting a password, creating accounts
(in PA#3 the test accounts of `PA3.md` come from a seed command), a limit on failed
logins, and cookies for a web interface (an open point in `docs/RECONSIDERATION.md`).
