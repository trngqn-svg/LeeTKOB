import type { Constraint } from "./types.ts";

// The rule of the dev set and of the held-out set (leetkob-eval/README.md): a text that
// starts with one of these is a ban list, and every banned name is written in backticks.
const BAN_LIST_STARTS = ["Do not use", "Do not call"];
const BACKTICKED = /`([^`]*)`/g;

/**
 * Reads one constraint as the TA wrote it. Used by the API when a lab is created and
 * by the checker on constraints.json, so both read a constraint the same way. It
 * depends on the text alone: no problem is named, so it works on problems it has never
 * seen. A ban list with no name is returned as it is; the caller refuses it.
 */
export function readConstraint(input: {
  code: string;
  text: string;
  deduction: number;
}): Constraint {
  const text = input.text.trim();
  const isBanList = BAN_LIST_STARTS.some((start) => text.startsWith(start));
  const bannedNames = isBanList
    ? [
        ...new Set(
          [...text.matchAll(BACKTICKED)]
            .map((match) => match[1] ?? "")
            .filter((name) => name !== ""),
        ),
      ]
    : [];
  return {
    code: input.code,
    text,
    kind: isBanList ? "ban_list" : "semantic",
    bannedNames,
    deduction: input.deduction,
  };
}
