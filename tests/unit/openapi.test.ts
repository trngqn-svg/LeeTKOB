// Verifies the hand-written OpenAPI spec and Swagger UI page against the
// contracts in docs/contract/ (docs/SWAGGER-PLAN.md, section 5).
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const CONTRACTS_DIR = resolve(ROOT, "docs/contract");
const SWAGGER_DIR = resolve(ROOT, "docs/swagger");

interface OpenApiSpec {
  openapi: string;
  paths: Record<
    string,
    Record<
      string,
      {
        responses?: Record<string, unknown>;
      }
    >
  >;
}

const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
]);

function readContracts() {
  const files = readdirSync(CONTRACTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();
  return files.map((file) => {
    const md = readFileSync(resolve(CONTRACTS_DIR, file), "utf8");
    const reqMatch = /^```\s*\n(GET|POST|PUT|PATCH|DELETE)\s+(\S+)/m.exec(md);
    if (!reqMatch) {
      throw new Error(`No request line found in ${file}`);
    }
    const method = reqMatch[1]!.toLowerCase();
    const path = reqMatch[2]!.split("?")[0]!;

    const statuses = new Set<string>();
    for (const m of md.matchAll(/^###\s+`(\d{3})\b/gm)) {
      statuses.add(m[1]!);
    }
    for (const m of md.matchAll(/^\|\s*`[a-z-]+`\s*\|\s*(\d{3})\s*\|/gm)) {
      statuses.add(m[1]!);
    }

    return { file, method, path, statuses: [...statuses].sort() };
  });
}

describe("Swagger / OpenAPI spec (docs/SWAGGER-PLAN.md)", () => {
  const spec = JSON.parse(
    readFileSync(resolve(SWAGGER_DIR, "openapi.json"), "utf8"),
  ) as OpenApiSpec;
  const contracts = readContracts();

  it("uses OpenAPI 3.0.x", () => {
    expect(spec.openapi).toMatch(/^3\.0\./);
  });

  it("lists every contracted operation and only GET /health extra", () => {
    const expectedOps = new Set<string>(["GET /health"]);
    for (const c of contracts) {
      expectedOps.add(`${c.method.toUpperCase()} ${c.path}`);
    }

    const actualOps = new Set<string>();
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const method of Object.keys(methods)) {
        if (HTTP_METHODS.has(method.toLowerCase())) {
          actualOps.add(`${method.toUpperCase()} ${path}`);
        }
      }
    }

    expect(actualOps).toEqual(expectedOps);
  });

  it("includes every response status from each contract", () => {
    for (const c of contracts) {
      const op = spec.paths[c.path]?.[c.method];
      expect(op, `${c.file}: ${c.method.toUpperCase()} ${c.path}`).toBeDefined();
      const specStatuses = Object.keys(op?.responses ?? {});
      for (const status of c.statuses) {
        expect(
          specStatuses,
          `${c.file} missing status ${status}`,
        ).toContain(status);
      }
    }
  });

  it("serves index.html with no inline scripts and SRI integrity on external assets", () => {
    const html = readFileSync(resolve(SWAGGER_DIR, "index.html"), "utf8");

    const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scriptTags.length).toBeGreaterThan(0);
    for (const [, attrs = "", body = ""] of scriptTags) {
      expect(attrs, "every <script> must have src").toMatch(/\bsrc\s*=/i);
      expect(body.trim(), "no inline <script> body allowed").toBe("");
      const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? "";
      if (/^(https?:)?\/\//i.test(src)) {
        expect(attrs, `external script ${src} needs integrity`).toMatch(
          /\bintegrity\s*=\s*["']sha(?:256|384|512)-[^"']+["']/i,
        );
      }
    }

    const linkTags = [...html.matchAll(/<link\b([^>]*)>/gi)];
    for (const [, attrs = ""] of linkTags) {
      const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? "";
      if (/^(https?:)?\/\//i.test(href)) {
        expect(attrs, `external link ${href} needs integrity`).toMatch(
          /\bintegrity\s*=\s*["']sha(?:256|384|512)-[^"']+["']/i,
        );
      }
    }
  });
});
