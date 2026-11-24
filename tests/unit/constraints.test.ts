// How a constraint's text is read (docs/contract/create-lab.md, "How the server reads a
// constraint", and leetkob-eval/README.md): a text that starts with "Do not use" or
// "Do not call" is a ban list, and its banned names are the names in backticks. The
// same function serves the API and the checker, so both read a constraint the same way.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readConstraint } from "../../src/judge/constraints.ts";

const read = (text: string) =>
  readConstraint({ code: "C1", text, deduction: 3 });

describe("readConstraint", () => {
  it("reads a ban list that starts with 'Do not call'", () => {
    expect(
      read("Do not call a library sort function: `std::sort`, `qsort`."),
    ).toEqual({
      code: "C1",
      text: "Do not call a library sort function: `std::sort`, `qsort`.",
      kind: "ban_list",
      bannedNames: ["std::sort", "qsort"],
      deduction: 3,
    });
  });

  it("reads a ban list that starts with 'Do not use', keywords included", () => {
    const c = read(
      "Do not use loop statements: `for`, `while`, `do`-`while`, range-based `for`, or `goto`.",
    );
    expect(c.kind).toBe("ban_list");
    expect(c.bannedNames).toEqual(["for", "while", "do", "goto"]);
  });

  it("keeps the names in order, once each, and skips empty backticks", () => {
    expect(read("Do not use `b`, `a`, `b`, ``, `a`.").bannedNames).toEqual([
      "b",
      "a",
    ]);
  });

  it("reads any other text as semantic, with no banned names even if it has backticks", () => {
    const c = read(
      "Store the numbers in memory you allocate yourself (`new[]`, or `malloc`/`realloc`).",
    );
    expect(c.kind).toBe("semantic");
    expect(c.bannedNames).toEqual([]);
  });

  it("matches the start as written: a lower-case 'do not use' is semantic", () => {
    expect(read("do not use `std::sort`.").kind).toBe("semantic");
    expect(read("Please do not use `std::sort`.").kind).toBe("semantic");
  });

  it("trims the text before reading it", () => {
    const c = read("  Do not use `std::gcd`.  \n");
    expect(c.text).toBe("Do not use `std::gcd`.");
    expect(c.kind).toBe("ban_list");
  });

  it("returns a ban list with no name as it is: the caller refuses it", () => {
    expect(read("Do not use any library helper.")).toMatchObject({
      kind: "ban_list",
      bannedNames: [],
    });
  });
});

// Every constraint of the published dev set, read with no per-problem setting: the
// held-out set has other problems, so this is the check that the rule is generic.
describe("readConstraint on every constraint of the dev set", () => {
  const root = new URL("../../leetkob-eval/problems/", import.meta.url);
  const BAN_LISTS = new Set([
    "binary-search/C1",
    "dynamic-array/C1",
    "gcd-euclid/C1",
    "reverse-recursive/C1",
    "reverse-recursive/C2",
    "reverse-words/C1",
    "sort-merge/C1",
  ]);

  const all = readdirSync(root).flatMap((problem) => {
    const list = JSON.parse(
      readFileSync(new URL(`${problem}/constraints.json`, root), "utf8"),
    ) as { id: string; text: string; deduction: number }[];
    return list.map((c) => ({ problem, ...c }));
  });

  it("finds the 13 constraints of the 6 problems", () => {
    expect(all).toHaveLength(13);
  });

  for (const c of all) {
    const id = `${c.problem}/${c.id}`;
    it(`${id} is ${BAN_LISTS.has(id) ? "a ban list with names" : "semantic"}`, () => {
      const got = readConstraint({
        code: c.id,
        text: c.text,
        deduction: c.deduction,
      });
      if (BAN_LISTS.has(id)) {
        expect(got.kind).toBe("ban_list");
        expect(got.bannedNames.length).toBeGreaterThan(0);
        for (const name of got.bannedNames)
          expect(c.text).toContain(`\`${name}\``);
      } else {
        expect(got.kind).toBe("semantic");
        expect(got.bannedNames).toEqual([]);
      }
      expect(got.deduction).toBe(c.deduction);
    });
  }
});
