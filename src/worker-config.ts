// The judge worker's settings (docs/ARCHITECTURE.md, section 2.4).
import { DEFAULT_DB_PATH } from "./db/connection.ts";
import type { QueueOptions } from "./db/queue.ts";

export interface WorkerConfig {
  dbPath: string;
  queue: QueueOptions;
}

type Env = Record<string, string | undefined>;

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(
      `${name} must be a whole number of at least 1, not "${raw}".`,
    );
  }
  return Number(raw);
}

/** Throws, naming the variable, when a value is wrong: the worker must not start then. */
export function readWorkerConfig(env: Env, fallbackId: string): WorkerConfig {
  const workerId = env.WORKER_ID || fallbackId;
  if (workerId.length > 64) {
    throw new Error("WORKER_ID must be at most 64 characters.");
  }
  return {
    dbPath: env.DB_PATH || DEFAULT_DB_PATH,
    queue: {
      workerId,
      leaseSeconds: positiveInt(env, "LEASE_SECONDS", 60),
      maxAttempts: positiveInt(env, "MAX_ATTEMPTS", 3),
    },
  };
}
