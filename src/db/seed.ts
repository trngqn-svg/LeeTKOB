import type { DatabaseSync } from "node:sqlite";
import { hashPassword } from "../password.ts";

// The test accounts of PA3.md: one admin, two TAs in two different classes, and two
// students in the first TA's class. They hold no real data. No lab: the rubric's
// walk-through creates the lab through the API.
export const SEED_CLASSES = [
  { id: "class-a", name: "Class A" },
  { id: "class-b", name: "Class B" },
];

export const SEED_USERS = [
  {
    id: "u-admin",
    email: "admin@leetkob.example",
    name: "Admin",
    role: "admin",
    classId: null,
  },
  {
    id: "u-ta-1",
    email: "ta1@leetkob.example",
    name: "TA One",
    role: "ta",
    classId: "class-a",
  },
  {
    id: "u-ta-2",
    email: "ta2@leetkob.example",
    name: "TA Two",
    role: "ta",
    classId: "class-b",
  },
  {
    id: "u-st-1",
    email: "student1@leetkob.example",
    name: "Student One",
    role: "student",
    classId: "class-a",
  },
  {
    id: "u-st-2",
    email: "student2@leetkob.example",
    name: "Student Two",
    role: "student",
    classId: "class-a",
  },
] as const;

/**
 * Creates the classes and accounts, all with `password`. Running it again creates no
 * duplicate and sets every account's password to the new one.
 */
export function seedAccounts(db: DatabaseSync, password: string): void {
  const addClass = db.prepare(
    "INSERT INTO classes (id, name) VALUES (?, ?) ON CONFLICT (id) DO NOTHING",
  );
  const addUser = db.prepare(`
    INSERT INTO users (id, email, display_name, role, password_hash) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET password_hash = excluded.password_hash`);
  const addMember = db.prepare(
    "INSERT INTO class_members (class_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
  );

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const c of SEED_CLASSES) addClass.run(c.id, c.name);
    for (const u of SEED_USERS) {
      addUser.run(u.id, u.email, u.name, u.role, hashPassword(password));
      if (u.classId) addMember.run(u.classId, u.id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
