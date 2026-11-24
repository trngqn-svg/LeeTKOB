import { buildApp } from "./app.ts";
import { DEFAULT_DB_PATH, openDatabase } from "./db/connection.ts";
import { createStore } from "./store.ts";

// The schema and the accounts come from `npm run db:seed`, run before the server.
const db = openDatabase(process.env.DB_PATH || DEFAULT_DB_PATH);

// Demo data only, so the endpoint can be tried by hand; tokens here are not secrets.
const store = createStore({
  users: [
    { id: "u-ta-1", role: "ta", token: "demo-ta", classIds: ["c-cpp-1"] },
    {
      id: "u-st-1",
      role: "student",
      token: "demo-student",
      classIds: ["c-cpp-1"],
    },
  ],
  labs: [
    {
      id: "lab-sort",
      classId: "c-cpp-1",
      pendingReviews: 0,
      judgedSubmissions: 80,
      publication: null,
    },
    {
      id: "lab-graph",
      classId: "c-cpp-1",
      pendingReviews: 3,
      judgedSubmissions: 78,
      publication: null,
    },
  ],
});

const app = buildApp(store, db);
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
await app.listen({ port, host });
console.log(`LeeTKOB listening on http://${host}:${port}`);
