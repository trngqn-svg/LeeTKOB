import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "ta" | "student";
}

// Exactly "Bearer <token>": one space, and no space inside the token.
const BEARER = /^Bearer ([^\s]+)$/;

/**
 * The user behind `Authorization: Bearer <token>`, or null. A missing or malformed
 * header, an unknown token and an expired one all give null, so every endpoint answers
 * them the same way: unauthenticated (docs/contract/auth-login.md, "Using the token").
 */
export function authenticate(
  db: DatabaseSync,
  authorization: string | undefined,
  now: Date,
): AuthUser | null {
  const token = authorization?.match(BEARER)?.[1];
  if (!token) return null;
  // ISO 8601 UTC text compares in time order; the token is refused only after expires_at.
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.display_name, u.role
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at >= ?`,
    )
    .get(
      createHash("sha256").update(token).digest("hex"),
      now.toISOString(),
    ) as
    | {
        id: string;
        email: string;
        display_name: string;
        role: AuthUser["role"];
      }
    | undefined;
  return row
    ? {
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        role: row.role,
      }
    : null;
}

/** True when the user belongs to the class. The admin belongs to none. */
export function isMember(
  db: DatabaseSync,
  userId: string,
  classId: string,
): boolean {
  return (
    db
      .prepare("SELECT 1 FROM class_members WHERE user_id = ? AND class_id = ?")
      .get(userId, classId) !== undefined
  );
}
