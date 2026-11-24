// npm run worker: the judge worker process, next to the API (ARCHITECTURE section 2.3).
// It shares the SQLite file at DB_PATH with the API and is the only process that reaches
// Docker. It stops after the job in hand on SIGTERM (docker stop) or SIGINT (Ctrl+C).
import { hostname } from "node:os";
import { openDatabase } from "./db/connection.ts";
import type { RunInSandbox } from "./judge/types.ts";
import { readWorkerConfig } from "./worker-config.ts";
import { startWorker, type JudgeConstraints } from "./worker.ts";

// shortcut: the real sandbox (Q6, src/judge/sandbox.ts) and pipeline (L7,
// src/judge/pipeline.ts) are not merged yet. Set these two from their imports when they are.
const runInSandbox: RunInSandbox | null = null;
const judgeConstraints: JudgeConstraints | null = null;

const config = readWorkerConfig(
  process.env,
  `worker-${hostname()}-${process.pid}`,
);

// A fake would turn every submission into "failed" after MAX_ATTEMPTS: refuse to start.
if (!runInSandbox || !judgeConstraints) {
  console.error(
    "The worker is not wired yet: it needs the sandbox (Q6) and the pipeline (L7). See src/worker-main.ts.",
  );
  process.exit(1);
}

const db = openDatabase(config.dbPath);
const worker = startWorker(
  {
    db,
    queue: config.queue,
    now: () => new Date(),
    runInSandbox,
    judgeConstraints,
    // Each pass is drawn for the TA's sample with a 10 percent chance (brief section 3).
    samplePass: () => Math.random() < 0.1,
  },
  { pollMs: 1000 },
);
console.log(
  `worker ${config.queue.workerId} started on ${config.dbPath} (lease ${config.queue.leaseSeconds} s, ${config.queue.maxAttempts} attempts)`,
);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(
    `worker ${config.queue.workerId}: ${signal}, finishing the job in hand`,
  );
  await worker.stop();
  db.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
