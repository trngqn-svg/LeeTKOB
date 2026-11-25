// The parts of the sandbox that need no Docker (src/judge/sandbox.ts): the docker flags,
// the comparison of output, and how the way a run ended becomes a test result. The
// runs themselves are proven by the nine attacks in tests/sandbox/.
import { describe, expect, it } from "vitest";
import {
  compileFlags,
  runFlags,
  sameOutput,
  testResultOf,
} from "../../src/judge/sandbox.ts";

const NAME = "leetkob-sb-test";

describe("the docker flags of every sandbox container", () => {
  const all = {
    compile: compileFlags(NAME),
    run: runFlags(NAME, { timeLimitMs: 1000, memoryLimitMb: 256 }),
  };

  for (const [kind, flags] of Object.entries(all)) {
    const after = (flag: string) => flags[flags.indexOf(flag) + 1];

    it(`${kind}: no network, a non-root user, no capabilities, a read-only root`, () => {
      expect(after("--network")).toBe("none");
      expect(after("--user")).toBe("10001:10001");
      expect(after("--cap-drop")).toBe("ALL");
      expect(after("--security-opt")).toBe("no-new-privileges");
      expect(flags).toContain("--read-only");
    });

    it(`${kind}: the label the clean-up checks look for, and its own name`, () => {
      expect(after("--label")).toBe("leetkob.sandbox=1");
      expect(after("--name")).toBe(NAME);
    });

    it(`${kind}: memory with no swap, and a process limit`, () => {
      expect(after("--memory-swap")).toBe(after("--memory"));
      expect(Number(after("--pids-limit"))).toBeGreaterThan(0);
    });

    it(`${kind}: never a host mount, the Docker socket, a privilege or an environment variable`, () => {
      for (const forbidden of [
        "-v",
        "--volume",
        "--mount",
        "--privileged",
        "-e",
        "--env",
        "--env-file",
        "--cap-add",
      ]) {
        expect(flags).not.toContain(forbidden);
      }
      expect(flags.join(" ")).not.toContain("docker.sock");
    });
  }

  it("run: the lab's memory and 16 processes (FAQ-05)", () => {
    const flags = runFlags(NAME, { timeLimitMs: 2000, memoryLimitMb: 128 });
    expect(flags[flags.indexOf("--memory") + 1]).toBe("128m");
    expect(flags[flags.indexOf("--pids-limit") + 1]).toBe("16");
  });
});

describe("sameOutput: token by token, whitespace ignored", () => {
  it("accepts the same tokens with other spaces, tabs and line breaks", () => {
    expect(sameOutput("1 2 3\n", "1 2 3")).toBe(true);
    expect(sameOutput("1  2\t3\r\n\n", "1\n2\n3\n")).toBe(true);
    expect(sameOutput("", "\n")).toBe(true);
  });

  it("refuses a different, a missing or an extra token", () => {
    expect(sameOutput("1 2 4\n", "1 2 3\n")).toBe(false);
    expect(sameOutput("1 2\n", "1 2 3\n")).toBe(false);
    expect(sameOutput("1 2 3 4\n", "1 2 3\n")).toBe(false);
    expect(sameOutput("12 3\n", "1 23\n")).toBe(false);
  });
});

describe("testResultOf: how a run ended", () => {
  const ended = {
    exitCode: 0,
    oomKilled: false,
    timedOut: false,
    outputTooLarge: false,
  };

  it("a clean exit is left to the comparison of output", () => {
    expect(testResultOf(ended)).toBe("ran");
  });

  it("the wall-clock kill is time_limit, whatever else happened", () => {
    expect(
      testResultOf({
        ...ended,
        timedOut: true,
        exitCode: 137,
        oomKilled: true,
      }),
    ).toBe("time_limit");
  });

  it("output over 1 MiB is runtime_error (our mapping of FAQ-05)", () => {
    expect(
      testResultOf({ ...ended, outputTooLarge: true, exitCode: 137 }),
    ).toBe("runtime_error");
  });

  it("a kill by the memory limit is memory_limit", () => {
    expect(testResultOf({ ...ended, exitCode: 137, oomKilled: true })).toBe(
      "memory_limit",
    );
  });

  it("SIGXCPU, or SIGKILL without a memory kill, is the CPU limit: time_limit", () => {
    expect(testResultOf({ ...ended, exitCode: 152 })).toBe("time_limit");
    expect(testResultOf({ ...ended, exitCode: 137 })).toBe("time_limit");
  });

  it("any other non-zero exit is runtime_error", () => {
    expect(testResultOf({ ...ended, exitCode: 1 })).toBe("runtime_error");
    expect(testResultOf({ ...ended, exitCode: 139 })).toBe("runtime_error");
  });
});
