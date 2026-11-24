import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { hashPassword, verifyPassword } from "../password.ts";
import { sendProblem } from "../problems.ts";
import { escapePointer, type FieldError } from "./publish.ts";

const INSTANCE = "/auth/login";
const TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;
const INVALID = "The email or the password is wrong.";

// Checked when the email is unknown, so that answer takes about as long as a wrong
// password and does not tell which emails have an account (contract, "Errors").
const DUMMY_HASH = hashPassword("no account has this password");

export function validateLoginBody(body: unknown): FieldError[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return [{ pointer: "", message: "Body must be a JSON object." }];
  }
  const fields = body as Record<string, unknown>;
  const errors: FieldError[] = Object.keys(fields)
    .filter((k) => k !== "email" && k !== "password")
    .map((k) => ({
      pointer: `/${escapePointer(k)}`,
      message: "Unknown field.",
    }));
  const { email, password } = fields;
  if (
    typeof email !== "string" ||
    email.length < 3 ||
    email.length > 254 ||
    !email.includes("@")
  ) {
    errors.push({
      pointer: "/email",
      message: "Required: 3 to 254 characters, with an @.",
    });
  }
  if (
    typeof password !== "string" ||
    password.length < 1 ||
    password.length > 128
  ) {
    errors.push({
      pointer: "/password",
      message: "Required: 1 to 128 characters.",
    });
  }
  return errors;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: string;
  password_hash: string;
}

export function registerLogin(
  app: FastifyInstance,
  db: DatabaseSync,
  now: () => Date,
) {
  // users.email is COLLATE NOCASE, so "=" ignores the case of the email.
  const findUser = db.prepare(
    "SELECT id, email, display_name, role, password_hash FROM users WHERE email = ?",
  );
  const addSession = db.prepare(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
  );

  app.post("/auth/login", (request, reply) => {
    const errors = validateLoginBody(request.body);
    if (errors.length > 0) {
      return sendProblem(
        reply,
        "validation-failed",
        INSTANCE,
        "The body breaks the rules of the contract.",
        { errors },
      );
    }
    const { email, password } = request.body as {
      email: string;
      password: string;
    };

    const user = findUser.get(email) as UserRow | undefined;
    const ok = verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) {
      return sendProblem(reply, "invalid-credentials", INSTANCE, INVALID);
    }

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(
      now().getTime() + TOKEN_LIFETIME_MS,
    ).toISOString();
    // Only the SHA-256 is stored, so a copy of the database signs nobody in.
    addSession.run(
      createHash("sha256").update(token).digest("hex"),
      user.id,
      expiresAt,
    );

    return reply.header("cache-control", "no-store").send({
      token,
      tokenType: "Bearer",
      expiresAt,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        role: user.role,
      },
    });
  });
}
