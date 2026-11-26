// Pins the SHA-256 hashes of the lecturer's dev set (docs/DECISIONS.md, decision 16,
// and docs/ARCHITECTURE.md, section 8). Any edit to eval.mjs or labels.jsonl turns CI red.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sha256 = (relPath: string) =>
  createHash("sha256")
    .update(readFileSync(new URL(relPath, import.meta.url)))
    .digest("hex");

describe("leetkob-eval integrity pin (decision 16)", () => {
  it("matches the published eval.mjs SHA-256", () => {
    expect(sha256("../../leetkob-eval/eval.mjs")).toBe(
      "c836edd8713521bbbd3c9c8299b5f0893cdbac0efab2209d6ae4397234516aa7",
    );
  });

  it("matches the published labels.jsonl SHA-256", () => {
    expect(sha256("../../leetkob-eval/labels.jsonl")).toBe(
      "262cda7b0ef5612e192cd6197e1df31a4e8af52c8da0ccceeb75f2b1e56ca47f",
    );
  });
});
