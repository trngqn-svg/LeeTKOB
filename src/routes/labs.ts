import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { authenticate, isMember } from "../auth.ts";
import { readConstraint } from "../judge/constraints.ts";
import type { Constraint } from "../judge/types.ts";
import { sendProblem } from "../problems.ts";
import { escapePointer, type FieldError } from "./publish.ts";

export const CREATE_LAB_BODY_LIMIT = 8 * 1024 * 1024;
const MIB = 1024 * 1024;
// ISO 8601 with a time zone: "Z" or "+07:00". Without one, the time would be ambiguous.
const ISO_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

interface NewLab {
  title: string;
  statementMd: string;
  deadline: string | null;
  timeLimitMs: number;
  memoryLimitMb: number;
  tests: { input: string; expectedOutput: string }[];
  constraints: Constraint[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isIntIn = (v: unknown, min: number, max: number): v is number =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

function unknownFields(
  fields: Record<string, unknown>,
  allowed: string[],
  at: string,
): FieldError[] {
  return Object.keys(fields)
    .filter((k) => !allowed.includes(k))
    .map((k) => ({
      pointer: `${at}/${escapePointer(k)}`,
      message: "Unknown field.",
    }));
}

/** The body rules of docs/contract/create-lab.md, all errors at once. */
export function validateCreateLab(
  body: unknown,
  now: Date,
): { errors: FieldError[]; lab?: NewLab } {
  if (!isObject(body)) {
    return {
      errors: [{ pointer: "", message: "Body must be a JSON object." }],
    };
  }
  const errors = unknownFields(
    body,
    [
      "title",
      "statementMd",
      "deadline",
      "timeLimitMs",
      "memoryLimitMb",
      "tests",
      "constraints",
    ],
    "",
  );
  const err = (pointer: string, message: string) =>
    errors.push({ pointer, message });

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (title.length < 1 || title.length > 200) {
    err("/title", "Required: 1 to 200 characters after trimming.");
  }

  const { statementMd } = body;
  if (
    typeof statementMd !== "string" ||
    statementMd.length < 1 ||
    statementMd.length > 100_000
  ) {
    err("/statementMd", "Required: 1 to 100 000 characters.");
  }

  let deadline: string | null = null;
  if (body.deadline !== undefined && body.deadline !== null) {
    const time =
      typeof body.deadline === "string" && ISO_WITH_ZONE.test(body.deadline)
        ? new Date(body.deadline).getTime()
        : NaN;
    if (Number.isNaN(time)) {
      err("/deadline", "ISO 8601 with a time zone, or null.");
    } else if (time <= now.getTime()) {
      err("/deadline", "Must be in the future.");
    } else {
      deadline = new Date(time).toISOString();
    }
  }

  const timeLimitMs = body.timeLimitMs ?? 1000;
  if (!isIntIn(timeLimitMs, 1000, 5000)) {
    err("/timeLimitMs", "An integer from 1000 to 5000 (FAQ-05).");
  }
  const memoryLimitMb = body.memoryLimitMb ?? 256;
  if (!isIntIn(memoryLimitMb, 64, 512)) {
    err("/memoryLimitMb", "An integer from 64 to 512 (FAQ-05).");
  }

  const tests: NewLab["tests"] = [];
  if (
    !Array.isArray(body.tests) ||
    body.tests.length < 1 ||
    body.tests.length > 50
  ) {
    err("/tests", "Required: 1 to 50 tests.");
  } else {
    body.tests.forEach((t: unknown, i: number) => {
      const at = `/tests/${i}`;
      if (!isObject(t)) return err(at, "Must be an object.");
      errors.push(...unknownFields(t, ["input", "expectedOutput"], at));
      const { input, expectedOutput } = t;
      if (typeof input !== "string" || bytes(input) > 2 * MIB) {
        err(`${at}/input`, "Required: at most 2 MiB in UTF-8.");
      }
      // The sandbox cuts output at 1 MiB (FAQ-05): a longer expected output could never match.
      if (typeof expectedOutput !== "string" || bytes(expectedOutput) > MIB) {
        err(`${at}/expectedOutput`, "Required: at most 1 MiB in UTF-8.");
      }
      if (typeof input === "string" && typeof expectedOutput === "string") {
        tests.push({ input, expectedOutput });
      }
    });
  }

  const constraints: Constraint[] = [];
  if (!Array.isArray(body.constraints) || body.constraints.length > 20) {
    err("/constraints", "Required: 0 to 20 constraints.");
  } else {
    body.constraints.forEach((c: unknown, i: number) => {
      const at = `/constraints/${i}`;
      if (!isObject(c)) return err(at, "Must be an object.");
      errors.push(...unknownFields(c, ["text", "deduction"], at));
      const text = typeof c.text === "string" ? c.text.trim() : "";
      if (text.length < 1 || text.length > 2000) {
        err(`${at}/text`, "Required: 1 to 2000 characters after trimming.");
      }
      if (!isIntIn(c.deduction, 0, 10)) {
        err(`${at}/deduction`, "Required: an integer from 0 to 10.");
      }
      const read = readConstraint({
        code: `C${i + 1}`,
        text,
        deduction: c.deduction as number,
      });
      if (read.kind === "ban_list" && read.bannedNames.length === 0) {
        err(`${at}/text`, "A ban list must name what it bans in backticks.");
      }
      constraints.push(read);
    });
  }

  if (errors.length > 0) return { errors };
  return {
    errors,
    lab: {
      title,
      statementMd: statementMd as string,
      deadline,
      timeLimitMs: timeLimitMs as number,
      memoryLimitMb: memoryLimitMb as number,
      tests,
      constraints,
    },
  };
}

export function registerLabs(
  app: FastifyInstance,
  db: DatabaseSync,
  now: () => Date,
) {
  const insertLab = db.prepare(`
    INSERT INTO labs (id, class_id, title, statement_md, deadline, time_limit_ms,
                      memory_limit_mb, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertTest = db.prepare(
    "INSERT INTO lab_tests (lab_id, position, input, expected_output) VALUES (?, ?, ?, ?)",
  );
  const insertConstraint = db.prepare(`
    INSERT INTO lab_constraints (lab_id, code, text, kind, banned_names, deduction)
    VALUES (?, ?, ?, ?, ?, ?)`);

  app.post<{ Params: { classId: string } }>(
    "/classes/:classId/labs",
    { bodyLimit: CREATE_LAB_BODY_LIMIT },
    (request, reply) => {
      const { classId } = request.params;
      const instance = `/classes/${classId}/labs`;
      const at = now();

      const user = authenticate(db, request.headers.authorization, at);
      if (!user) {
        return sendProblem(
          reply,
          "unauthenticated",
          instance,
          "Send a valid Bearer token.",
        );
      }
      if (user.role !== "ta") {
        return sendProblem(
          reply,
          "role-not-allowed",
          instance,
          `Role ${user.role} cannot create a lab.`,
          {
            requiredRole: "ta",
          },
        );
      }
      // Same answer for "no such class" and "not your class": ids of other classes must not leak.
      if (!isMember(db, user.id, classId)) {
        return sendProblem(
          reply,
          "class-not-found",
          instance,
          "No class with this id is yours.",
        );
      }

      const { errors, lab } = validateCreateLab(request.body, at);
      if (!lab) {
        return sendProblem(
          reply,
          "validation-failed",
          instance,
          "The body breaks the rules of the contract.",
          {
            errors,
          },
        );
      }

      const id = `lab-${randomUUID()}`;
      const createdAt = at.toISOString();
      db.exec("BEGIN IMMEDIATE");
      try {
        insertLab.run(
          id,
          classId,
          lab.title,
          lab.statementMd,
          lab.deadline,
          lab.timeLimitMs,
          lab.memoryLimitMb,
          user.id,
          createdAt,
        );
        lab.tests.forEach((t, i) =>
          insertTest.run(id, i + 1, t.input, t.expectedOutput),
        );
        for (const c of lab.constraints) {
          insertConstraint.run(
            id,
            c.code,
            c.text,
            c.kind,
            JSON.stringify(c.bannedNames),
            c.deduction,
          );
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      return reply.code(201).header("location", `/labs/${id}`).send({
        id,
        classId,
        title: lab.title,
        status: "open",
        deadline: lab.deadline,
        timeLimitMs: lab.timeLimitMs,
        memoryLimitMb: lab.memoryLimitMb,
        testCount: lab.tests.length,
        constraints: lab.constraints,
        createdBy: user.id,
        createdAt,
      });
    },
  );
}
