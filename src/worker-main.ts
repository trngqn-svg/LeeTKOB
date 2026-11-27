// npm run worker: the judge worker process, next to the API (ARCHITECTURE section 2.3).
// It shares the SQLite file at DB_PATH with the API and is the only process that reaches
// Docker. It stops after the job in hand on SIGTERM (docker stop) or SIGINT (Ctrl+C).
import { hostname } from "node:os";
import { openDatabase } from "./db/connection.ts";
import { createPipelineFromEnv } from "./judge/pipeline.ts";
import { runInSandbox } from "./judge/sandbox.ts";
import { readWorkerConfig } from "./worker-config.ts";
import { startWorker } from "./worker.ts";

const config = readWorkerConfig(
  process.env,
  `worker-${hostname()}-${process.pid}`,
);
const judgeConstraints = createPipelineFromEnv(process.env);

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
