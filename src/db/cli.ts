// npm run db:migrate: applies the pending migrations to the file at DB_PATH.
import { DEFAULT_DB_PATH, openDatabase } from "./connection.ts";
import { migrate } from "./migrate.ts";

const path = process.env.DB_PATH || DEFAULT_DB_PATH;
const command = process.argv[2];

if (command !== "migrate") {
  console.error("usage: tsx src/db/cli.ts migrate");
  process.exit(2);
}

const db = openDatabase(path);
try {
  const applied = migrate(db);
  console.log(
    applied.length
      ? `${path}: applied ${applied.join(", ")}`
      : `${path}: already up to date`,
  );
} finally {
  db.close();
}
