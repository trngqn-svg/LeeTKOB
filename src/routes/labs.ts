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

  const findLab = db.prepare(`
    SELECT l.id, l.class_id, l.title, l.statement_md, l.status, l.deadline,
           p.published_at, l.time_limit_ms, l.memory_limit_mb, l.created_by, l.created_at,
           (SELECT COUNT(*) FROM lab_tests t WHERE t.lab_id = l.id) AS test_count
      FROM labs l LEFT JOIN publications p ON p.lab_id = l.id
     WHERE l.id = ?`);
  const findConstraints = db.prepare(
    "SELECT code, text, kind, banned_names, deduction FROM lab_constraints WHERE lab_id = ? ORDER BY id",
  );
  const findTests = db.prepare(
    "SELECT position, input, expected_output FROM lab_tests WHERE lab_id = ? ORDER BY position",
  );

  app.get<{ Params: { labId: string }; Querystring: Record<string, unknown> }>(
    "/labs/:labId",
    (request, reply) => {
      const { labId } = request.params;
      const instance = `/labs/${labId}`;

      const user = authenticate(db, request.headers.authorization, now());
      if (!user) {
        return sendProblem(
          reply,
          "unauthenticated",
          instance,
          "Send a valid Bearer token.",
        );
      }
      if (user.role === "admin") {
        return sendProblem(
          reply,
          "role-not-allowed",
          instance,
          "An admin has no access to labs.",
          {
            requiredRole: ["ta", "student"],
          },
        );
      }

      // Fastify turns a repeated parameter into an array, so "tests" twice is not "tests".
      const query = request.query;
      const wrong =
        Object.keys(query).find((k) => k !== "include") ??
        (query.include !== undefined && query.include !== "tests"
          ? "include"
          : undefined);
      if (wrong) {
        return sendProblem(
          reply,
          "invalid-query",
          instance,
          `The parameter ${wrong} is not allowed here.`,
          {
            parameter: wrong,
          },
        );
      }

      const lab = findLab.get(labId) as LabRow | undefined;
      // Same answer for "no such lab" and "not your class": ids of other classes must not leak.
      if (!lab || !isMember(db, user.id, lab.class_id)) {
        return sendProblem(
          reply,
          "lab-not-found",
          instance,
          "No lab with this id is in your classes.",
        );
      }
      const withTests = query.include === "tests";
      if (withTests && user.role !== "ta") {
        return sendProblem(
          reply,
          "role-not-allowed",
          instance,
          "Only a TA may read the tests (FAQ-02).",
          {
            requiredRole: "ta",
          },
        );
      }

      const constraints = (
        findConstraints.all(labId) as unknown as ConstraintRow[]
      ).map((c) => ({
        code: c.code,
        text: c.text,
        kind: c.kind,
        bannedNames: JSON.parse(c.banned_names) as string[],
        deduction: c.deduction,
      }));
      const tests = withTests
        ? (findTests.all(labId) as unknown as TestRow[]).map((t) => ({
            position: t.position,
            input: t.input,
            expectedOutput: t.expected_output,
          }))
        : undefined;

      return reply.header("cache-control", "private, no-store").send({
        id: lab.id,
        classId: lab.class_id,
        title: lab.title,
        statementMd: lab.statement_md,
        status: lab.status,
        deadline: lab.deadline,
        publishedAt: lab.published_at,
        timeLimitMs: lab.time_limit_ms,
        memoryLimitMb: lab.memory_limit_mb,
        constraints,
        createdBy: lab.created_by,
        createdAt: lab.created_at,
        testCount: lab.test_count,
        ...(tests ? { tests } : {}),
      });
    },
  );
}

interface LabRow {
  id: string;
  class_id: string;
  title: string;
  statement_md: string;
  status: string;
  deadline: string | null;
  published_at: string | null;
  time_limit_ms: number;
  memory_limit_mb: number;
  created_by: string;
  created_at: string;
  test_count: number;
}

interface ConstraintRow {
  code: string;
  text: string;
  kind: string;
  banned_names: string;
  deduction: number;
}

interface TestRow {
  position: number;
  input: string;
  expected_output: string;
}
