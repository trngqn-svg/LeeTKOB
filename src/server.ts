import { buildApp } from "./app.ts";
import { DEFAULT_DB_PATH, openDatabase } from "./db/connection.ts";
import { createStore } from "./store.ts";

// The schema and the accounts come from `npm run db:seed`, run before the server.
const db = openDatabase(process.env.DB_PATH || DEFAULT_DB_PATH);

// The store only carries the clock now: every route reads the database.
const app = buildApp(createStore({ users: [], labs: [] }), db);
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
await app.listen({ port, host });
console.log(`LeeTKOB listening on http://${host}:${port}`);
