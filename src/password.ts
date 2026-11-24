import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 32;

/** "scrypt$<salt>$<hash>", base64url. The password itself is never stored. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

/** Compares in constant time. A stored value it cannot read never matches. */
export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  if (expected.length !== KEY_LENGTH) return false;
  const actual = scryptSync(
    password,
    Buffer.from(salt, "base64url"),
    KEY_LENGTH,
  );
  return timingSafeEqual(actual, expected);
}
