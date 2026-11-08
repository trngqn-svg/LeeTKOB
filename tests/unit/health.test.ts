import { expect, it } from "vitest";
import { buildApp } from "../../src/app.ts";
import { createStore } from "../../src/store.ts";

it("GET /health answers ok without auth", async () => {
  const app = buildApp(createStore({ users: [], labs: [] }));
  const res = await app.inject({ method: "GET", url: "/health" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ status: "ok" });
});
