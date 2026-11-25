// The nine sandbox minimums (brief section 5, PA#3 rubric criterion 2). Each attack in
// tests/sandbox/attacks/ goes through the real sandbox, src/judge/sandbox.ts (task Q6),
// and must fail the way its header says. The sandbox compiles inside the container too.
//
// These tests need Docker and the sandbox image, so they run only with SANDBOX_TESTS=1,
// which the CI job "sandbox" sets. Without it they are reported as skipped, never as
// passed. With it, a missing Docker fails them.
//
// What these tests ask of the sandbox, besides RunInSandbox in src/judge/types.ts:
// - the module exports `runInSandbox`, and runs the image named by SANDBOX_IMAGE,
//   built from docker/sandbox/ (the CI job "sandbox" builds it first);
// - every container it starts carries the label "leetkob.sandbox", so the tests can
//   check that none is left after a run.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type {
  RunInSandbox,
  SandboxLimits,
  SandboxOutcome,
  TestCase,
} from "../../src/judge/types.ts";

const ENABLED = process.env.SANDBOX_TESTS === "1";
// The defaults of a lab (FAQ-05): 1 s of CPU per test, so a wall-clock limit of 3 s.
const LIMITS: SandboxLimits = { timeLimitMs: 1000, memoryLimitMb: 256 };
const WALL_MS = 3 * LIMITS.timeLimitMs;
const LABEL = "leetkob.sandbox";
// Not a real key. The worker holds the real one in its environment, so the test puts
// this one there: a sandbox that passes the worker's environment on is caught by attack 9.
const FAKE_KEY = "attack-test-not-a-real-key";
// Compiling (up to 10 s, FAQ-05), the run and the clean-up, with room for a slow runner.
const TIMEOUT_MS = 60_000;

const source = (file: string) =>
  readFileSync(new URL(`./attacks/${file}`, import.meta.url), "utf8");

const oneTest = (expectedOutput: string): TestCase[] => [
  { position: 1, input: "", expectedOutput },
];

/** The ids of every container, running or stopped, that the sandbox started. */
function sandboxContainers(): string[] {
  const out = execFileSync(
    "docker",
    ["ps", "--all", "--quiet", "--filter", `label=${LABEL}`],
    { encoding: "utf8" },
  );
  return out.split("\n").filter((id) => id !== "");
}

/** Runs one attack and measures how long the whole run took, compile included. */
async function attack(
  file: string,
  expectedOutput: string,
): Promise<{ outcome: SandboxOutcome; elapsedMs: number }> {
  const started = Date.now();
  const outcome = await runInSandbox(
    source(file),
    oneTest(expectedOutput),
    LIMITS,
  );
  return { outcome, elapsedMs: Date.now() - started };
}

let runInSandbox: RunInSandbox;
const previousKey = process.env.LLM_API_KEY;

describe.skipIf(!ENABLED)("the sandbox stops the nine attacks", () => {
  beforeAll(async () => {
    process.env.LLM_API_KEY = FAKE_KEY;
    ({ runInSandbox } = await import("../../src/judge/sandbox.ts"));
    // A container left by an earlier run would make the clean-up checks meaningless.
    expect(sandboxContainers()).toEqual([]);
  });

  afterAll(() => {
    if (previousKey === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = previousKey;
  });

  // Every run, whatever it did, leaves no container behind.
  afterEach(() => {
    expect(sandboxContainers()).toEqual([]);
  });

  it(
    "1. no network: DNS, TCP and UDP all fail",
    async () => {
      const { outcome } = await attack("01-network.cpp", "network: blocked\n");
      expect(outcome).toMatchObject({ result: "accepted" });
    },
    TIMEOUT_MS,
  );

  it(
    "2. a CPU time limit: a busy loop ends as time_limit before the wall-clock kill",
    async () => {
      const { outcome } = await attack("02-cpu-time.cpp", "never printed\n");
      expect(outcome).toMatchObject({
        result: "time_limit",
        tests: [{ position: 1, result: "time_limit" }],
      });
      if (outcome.result === "compile_error") return;
      expect(outcome.tests[0]?.timeMs).toBeLessThan(WALL_MS);
    },
    TIMEOUT_MS,
  );

  it(
    "3. a wall-clock limit: a sleeping process and its detached child are killed with the container",
    async () => {
      const { outcome, elapsedMs } = await attack(
        "03-wall-clock.cpp",
        "never printed\n",
      );
      expect(outcome).toMatchObject({
        result: "time_limit",
        tests: [{ position: 1, result: "time_limit" }],
      });
      // It used no CPU, so only the wall-clock limit can have ended it.
      expect(elapsedMs).toBeGreaterThanOrEqual(WALL_MS);
      // afterEach then checks that no container, and so no child, is left.
    },
    TIMEOUT_MS,
  );

  it(
    "4. a memory limit, swap included: 1 GiB written and read back ends as memory_limit",
    async () => {
      const { outcome } = await attack("04-memory.cpp", "never printed\n");
      expect(outcome).toMatchObject({
        result: "memory_limit",
        tests: [{ position: 1, result: "memory_limit" }],
      });
    },
    TIMEOUT_MS,
  );

  it(
    "5. a process limit: a fork bomb is refused before 200 children",
    async () => {
      const { outcome } = await attack(
        "05-processes.cpp",
        "processes: limited\n",
      );
      expect(outcome).toMatchObject({ result: "accepted" });
    },
    TIMEOUT_MS,
  );

  it(
    "6. an output size limit: 64 MiB of output is cut and ends as runtime_error, quickly",
    async () => {
      const { outcome } = await attack("06-output.cpp", "never printed\n");
      expect(outcome).toMatchObject({
        result: "runtime_error",
        tests: [{ position: 1, result: "runtime_error" }],
      });
      if (outcome.result === "compile_error") return;
      // Cut at 1 MiB, not read to the end and not left to the wall-clock kill.
      expect(outcome.tests[0]?.timeMs).toBeLessThan(WALL_MS);
    },
    TIMEOUT_MS,
  );

  it(
    "7. a non-root user: not root, cannot become root, cannot write to /etc",
    async () => {
      const { outcome } = await attack("07-non-root.cpp", "user: not root\n");
      expect(outcome).toMatchObject({ result: "accepted" });
    },
    TIMEOUT_MS,
  );

  it(
    "8. no host mounts and no Docker socket",
    async () => {
      const { outcome } = await attack(
        "08-mounts-docker-socket.cpp",
        "docker socket: absent; host mounts: none\n",
      );
      expect(outcome).toMatchObject({ result: "accepted" });
    },
    TIMEOUT_MS,
  );

  it(
    "9. no secrets: not in the environment, the files, or what the compiler can include",
    async () => {
      expect(process.env.LLM_API_KEY).toBe(FAKE_KEY);
      const { outcome } = await attack("09-secrets.cpp", "secrets: none\n");
      expect(outcome).toMatchObject({ result: "accepted" });
    },
    TIMEOUT_MS,
  );
});
