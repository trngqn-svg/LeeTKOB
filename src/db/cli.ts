// npm run db:migrate: applies the pending migrations to the file at DB_PATH.
// npm run db:seed:    migrates, then creates the test accounts of PA3.md with SEED_PASSWORD.
import { DEFAULT_DB_PATH, openDatabase } from "./connection.ts";
import { migrate } from "./migrate.ts";
import { SEED_USERS, seedAccounts } from "./seed.ts";

// Only for a developer's own machine. The deployment sets SEED_PASSWORD.
const DEV_PASSWORD = "leetkob-dev-only";

const path = process.env.DB_PATH || DEFAULT_DB_PATH;
const command = process.argv[2];

if (command !== "migrate" && command !== "seed") {
  console.error("usage: tsx src/db/cli.ts migrate|seed");
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
  if (command === "seed") {
    const password = process.env.SEED_PASSWORD;
    if (!password) {
      console.warn(
        `SEED_PASSWORD is not set: using the development password "${DEV_PASSWORD}". Never do this on the deployment.`,
      );
    }
    seedAccounts(db, password || DEV_PASSWORD);
    console.log(`${path}: seeded ${SEED_USERS.map((u) => u.email).join(", ")}`);
  }
} finally {
  db.close();
}
