import { buildApp } from "./app.ts";
import { createStore } from "./store.ts";

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

const app = buildApp(store);
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
await app.listen({ port, host });
console.log(`LeeTKOB listening on http://${host}:${port}`);
