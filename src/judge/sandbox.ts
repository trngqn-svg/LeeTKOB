// The sandbox (task Q6; docs/ARCHITECTURE.md section 5, brief section 5). It compiles and
// runs one submission in two short-lived Docker containers of the image built from
// docker/sandbox/:
//
// 1. A compile container gets the source on standard input and answers with the binary
//    on standard output, or with the compiler's message. Compiling happens inside the
//    sandbox too, with its own limits (10 s, FAQ-05).
// 2. A run container gets the binary the same way, then runs each test with docker exec,
//    with the lab's CPU and memory limits, until a test fails.
//
// Both have no network, no host mount, no Docker socket, no environment variable of the
// worker, a non-root user, no capabilities, a read-only root with a tmpfs at /work, and
// limits on memory (swap included) and processes. Files never cross from the host:
// everything goes through standard input and output. The nine attacks in tests/sandbox/
// prove each of these. Only a failure of Docker itself throws (RunInSandbox).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  RunInSandbox,
  SandboxLimits,
  SandboxOutcome,
  TestCase,
  TestResult,
} from "./types.ts";

export const SANDBOX_LABEL = "leetkob.sandbox";
export const DEFAULT_IMAGE = "leetkob-sandbox";
const USER = "10001:10001";
const COMPILE_TIME_MS = 10_000; // FAQ-05
const COMPILE_MEMORY_MB = 512; // g++ needs more than the smallest lab limit (64 MB)
const COMPILE_PIDS = 32; // g++ starts cc1plus, as, collect2 and ld
const RUN_PIDS = 16; // FAQ-05
const MAX_OUTPUT_BYTES = 1024 * 1024; // FAQ-05
const MAX_BINARY_BYTES = 32 * 1024 * 1024;
const MAX_COMPILER_MESSAGE_BYTES = 16 * 1024;
const MAX_DOCKER_ERROR_BYTES = 16 * 1024;
// A docker command that is not a student's run (start, copy, clean up) must end by then.
const DOCKER_COMMAND_MS = 30_000;
// Exit codes of a process killed by a signal: 128 + the signal's number.
const SIGKILL_EXIT = 128 + 9;
const SIGXCPU_EXIT = 128 + 24;

/** The flags every sandbox container gets, whatever it runs. */
function containerFlags(name: string, memoryMb: number, pids: number) {
  return [
    "--name",
    name,
    "--label",
    `${SANDBOX_LABEL}=1`,
    "--network",
    "none",
    "--user",
    USER,
    "--read-only",
    "--tmpfs",
    "/work:rw,exec,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=0700",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=0700",
    "--memory",
    `${memoryMb}m`,
    // Equal to --memory: no swap, so a process cannot get around the limit.
    "--memory-swap",
    `${memoryMb}m`,
    "--pids-limit",
    String(pids),
    "--cpus",
    "1",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--ulimit",
    "core=0",
    "--ulimit",
    "nofile=64:64",
  ];
}

export const compileFlags = (name: string) =>
  containerFlags(name, COMPILE_MEMORY_MB, COMPILE_PIDS);

export const runFlags = (name: string, limits: SandboxLimits) =>
  containerFlags(name, limits.memoryLimitMb, RUN_PIDS);

const tokens = (text: string) => text.split(/\s+/).filter((t) => t !== "");

/** Token by token, whitespace ignored (ARCHITECTURE section 5, step 3). */
export function sameOutput(actual: string, expected: string): boolean {
  const a = tokens(actual);
  const e = tokens(expected);
  return a.length === e.length && a.every((token, i) => token === e[i]);
}

/** How one run of a test ended, as the runner saw it. */
export interface RunEnd {
  exitCode: number;
  /** The kernel killed a process of the container for memory during this run. */
  oomKilled: boolean;
  /** The wall-clock limit ran out and the runner killed the container. */
  timedOut: boolean;
  /** The output passed 1 MiB and the runner killed the container. */
  outputTooLarge: boolean;
}

/** "ran" means the program ended by itself with 0: its output decides. */
export function testResultOf(
  end: RunEnd,
): Exclude<TestResult["result"], "passed" | "wrong_answer"> | "ran" {
  if (end.timedOut) return "time_limit";
  if (end.outputTooLarge) return "runtime_error";
  if (end.oomKilled) return "memory_limit";
  if (end.exitCode === 0) return "ran";
  // `ulimit -t` sends SIGXCPU at the CPU limit, then SIGKILL; neither is a memory kill.
  if (end.exitCode === SIGXCPU_EXIT || end.exitCode === SIGKILL_EXIT) {
    return "time_limit";
  }
  return "runtime_error";
}

// ---------------------------------------------------------------------------
// Running docker

interface DockerResult {
  code: number;
  stdout: Buffer;
  stderr: string;
  /** stdout passed maxStdout: the rest was not read. */
  overflow: boolean;
}

interface DockerOptions {
  input?: Buffer | string;
  maxStdout: number;
  /** Called once when stdout passes maxStdout. */
  onOverflow?: () => void;
}

/** Runs the docker CLI. Rejects only when the CLI cannot be started at all. */
function docker(args: string[], options: DockerOptions): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let outBytes = 0;
    let overflow = false;
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      if (overflow) return;
      if (outBytes + chunk.length > options.maxStdout) {
        overflow = true;
        out.push(chunk.subarray(0, options.maxStdout - outBytes));
        outBytes = options.maxStdout;
        options.onOverflow?.();
        return;
      }
      out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_DOCKER_ERROR_BYTES) stderr += chunk.toString();
    });
    // A program that never reads its input closes the pipe early: not an error.
    child.stdin.on("error", () => {});
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out),
        stderr: stderr.slice(0, MAX_DOCKER_ERROR_BYTES),
        overflow,
      });
    });
    child.stdin.end(options.input ?? "");
  });
}

/** A docker command that is not a student's run: it must succeed, quickly. */
async function dockerOrThrow(
  args: string[],
  options: DockerOptions = { maxStdout: 64 * 1024 },
): Promise<DockerResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`docker ${args[0]} took over ${DOCKER_COMMAND_MS} ms`),
        ),
      DOCKER_COMMAND_MS,
    );
  });
  try {
    const result = await Promise.race([docker(args, options), timeout]);
    if (result.code !== 0) {
      throw new Error(
        `docker ${args[0]} failed with ${result.code}: ${result.stderr.trim()}`,
      );
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/** Kills and removes a container; a container that is already gone is fine. */
async function removeContainer(name: string): Promise<void> {
  await docker(["rm", "--force", "--volumes", name], { maxStdout: 1024 });
}

/** Kills the container without waiting: used from timers and stream handlers. */
function killContainer(name: string): void {
  void docker(["kill", name], { maxStdout: 1024 }).catch(() => {});
}

const imageName = () => process.env.SANDBOX_IMAGE || DEFAULT_IMAGE;
const containerName = () => `leetkob-sb-${randomUUID()}`;

// ---------------------------------------------------------------------------
// Compiling

// Exit code of the compile script when g++ refused the source.
const COMPILER_REFUSED = 3;
const COMPILE_SCRIPT = [
  "cat > /work/main.cpp",
  `g++ -std=c++17 -O2 -pipe -o /work/main /work/main.cpp 2> /work/compiler.txt || { head -c ${MAX_COMPILER_MESSAGE_BYTES} /work/compiler.txt; exit ${COMPILER_REFUSED}; }`,
  "cat /work/main",
].join(" && ");

type Compiled =
  { ok: true; binary: Buffer } | { ok: false; compilerMessage: string };

async function compile(sourceCode: string): Promise<Compiled> {
  const name = containerName();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killContainer(name);
  }, COMPILE_TIME_MS);
  try {
    const result = await docker(
      [
        "run",
        "--interactive",
        ...compileFlags(name),
        imageName(),
        "sh",
        "-c",
        COMPILE_SCRIPT,
      ],
      {
        input: sourceCode,
        maxStdout: MAX_BINARY_BYTES,
        onOverflow: () => killContainer(name),
      },
    );
    if (timedOut) {
      return {
        ok: false,
        compilerMessage: `Compiling took longer than ${COMPILE_TIME_MS / 1000} s.`,
      };
    }
    if (result.code === COMPILER_REFUSED) {
      return { ok: false, compilerMessage: result.stdout.toString("utf8") };
    }
    if (result.overflow) {
      return {
        ok: false,
        compilerMessage: "The compiled program is too large.",
      };
    }
    if (result.code === SIGKILL_EXIT) {
      return {
        ok: false,
        compilerMessage: `Compiling used more than ${COMPILE_MEMORY_MB} MB.`,
      };
    }
    if (result.code !== 0) {
      // 125, 126 and 127 are Docker's own failures: the image or the daemon.
      throw new Error(
        `compile container failed with ${result.code}: ${result.stderr.trim()}`,
      );
    }
    return { ok: true, binary: result.stdout };
  } finally {
    clearTimeout(timer);
    await removeContainer(name);
  }
}

// ---------------------------------------------------------------------------
// Running the tests

/** The number of memory kills in the container so far, from its own cgroup. */
async function oomKills(name: string): Promise<number> {
  const { stdout } = await dockerOrThrow([
    "exec",
    name,
    "cat",
    "/sys/fs/cgroup/memory.events",
  ]);
  const match = /^oom_kill (\d+)$/m.exec(stdout.toString("utf8"));
  return match ? Number(match[1]) : 0;
}

async function runOne(
  name: string,
  test: TestCase,
  limits: SandboxLimits,
  oomBefore: number,
): Promise<{ result: TestResult; oomAfter: number }> {
  const cpuSeconds = Math.ceil(limits.timeLimitMs / 1000);
  const wallMs = 3 * limits.timeLimitMs;
  let timedOut = false;
  let outputTooLarge = false;
  const started = Date.now();
  const timer = setTimeout(() => {
    timedOut = true;
    killContainer(name);
  }, wallMs);

  let end: DockerResult;
  try {
    end = await docker(
      [
        "exec",
        "--interactive",
        name,
        "sh",
        "-c",
        // The student's stderr is dropped, so whatever reaches ours comes from Docker.
        `ulimit -t ${cpuSeconds}; exec /work/main 2>/dev/null`,
      ],
      {
        input: test.input,
        maxStdout: MAX_OUTPUT_BYTES,
        onOverflow: () => {
          outputTooLarge = true;
          killContainer(name);
        },
      },
    );
  } finally {
    clearTimeout(timer);
  }
  const timeMs = Date.now() - started;
  const containerAlive = !timedOut && !outputTooLarge;

  let oomAfter = oomBefore;
  if (containerAlive && end.code !== 0) {
    if (end.stderr.trim() !== "") {
      // The student's stderr goes to /dev/null, so this is Docker failing.
      throw new Error(
        `docker exec failed with ${end.code}: ${end.stderr.trim()}`,
      );
    }
    oomAfter = await oomKills(name);
  }

  const how = testResultOf({
    exitCode: end.code,
    oomKilled: oomAfter > oomBefore,
    timedOut,
    outputTooLarge,
  });
  const result: TestResult["result"] =
    how !== "ran"
      ? how
      : sameOutput(end.stdout.toString("utf8"), test.expectedOutput)
        ? "passed"
        : "wrong_answer";
  return { result: { position: test.position, result, timeMs }, oomAfter };
}

async function runTests(
  binary: Buffer,
  tests: TestCase[],
  limits: SandboxLimits,
): Promise<SandboxOutcome> {
  const name = containerName();
  try {
    await dockerOrThrow([
      "run",
      "--detach",
      ...runFlags(name, limits),
      imageName(),
    ]);
    await dockerOrThrow(
      [
        "exec",
        "--interactive",
        name,
        "sh",
        "-c",
        "cat > /work/main && chmod 700 /work/main",
      ],
      { input: binary, maxStdout: 1024 },
    );

    const results: TestResult[] = [];
    let oom = await oomKills(name);
    for (const test of [...tests].sort((a, b) => a.position - b.position)) {
      const run = await runOne(name, test, limits, oom);
      results.push(run.result);
      oom = run.oomAfter;
      if (run.result.result !== "passed") {
        return { result: run.result.result, tests: results };
      }
      // Kill anything the test left running, so the next test starts clean.
      // kill(-1) spares PID 1 and the caller.
      await dockerOrThrow([
        "exec",
        name,
        "sh",
        "-c",
        "kill -9 -1 2>/dev/null; true",
      ]);
    }
    return { result: "accepted", tests: results };
  } finally {
    await removeContainer(name);
  }
}

/** Compiles inside the sandbox, then runs the tests in order until one fails. */
export const runInSandbox: RunInSandbox = async (sourceCode, tests, limits) => {
  const compiled = await compile(sourceCode);
  if (!compiled.ok) {
    return {
      result: "compile_error",
      compilerMessage: compiled.compilerMessage,
    };
  }
  return runTests(compiled.binary, tests, limits);
};
