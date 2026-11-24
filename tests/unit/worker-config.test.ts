// The judge worker's settings (docs/ARCHITECTURE.md, section 2.4). A wrong value stops the
// worker at start, naming the variable, rather than judging with a lease nobody chose.
import { describe, expect, it } from "vitest";
import { DEFAULT_DB_PATH } from "../../src/db/connection.ts";
import { readWorkerConfig } from "../../src/worker-config.ts";

describe("readWorkerConfig", () => {
  it("uses the defaults of ARCHITECTURE 2.4 when nothing is set", () => {
    expect(readWorkerConfig({}, "worker-host-42")).toEqual({
      dbPath: DEFAULT_DB_PATH,
      queue: { workerId: "worker-host-42", leaseSeconds: 60, maxAttempts: 3 },
    });
  });

  it("reads every variable", () => {
    expect(
      readWorkerConfig(
        {
          DB_PATH: "/data/leetkob.db",
          WORKER_ID: "worker-1",
          LEASE_SECONDS: "90",
          MAX_ATTEMPTS: "5",
        },
        "unused",
      ),
    ).toEqual({
      dbPath: "/data/leetkob.db",
      queue: { workerId: "worker-1", leaseSeconds: 90, maxAttempts: 5 },
    });
  });

  it("treats an empty variable as unset, as .env.example leaves them", () => {
    expect(
      readWorkerConfig(
        { DB_PATH: "", WORKER_ID: "", LEASE_SECONDS: "", MAX_ATTEMPTS: "" },
        "worker-host-42",
      ),
    ).toEqual(readWorkerConfig({}, "worker-host-42"));
  });

  for (const name of ["LEASE_SECONDS", "MAX_ATTEMPTS"]) {
    for (const value of ["0", "-1", "1.5", "abc", "10s"]) {
      it(`refuses ${name}=${value}, naming the variable`, () => {
        expect(() => readWorkerConfig({ [name]: value }, "w")).toThrow(name);
      });
    }
  }

  it("refuses a WORKER_ID longer than 64 characters", () => {
    expect(() => readWorkerConfig({ WORKER_ID: "w".repeat(65) }, "w")).toThrow(
      "WORKER_ID",
    );
  });
});
