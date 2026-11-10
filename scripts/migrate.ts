/**
 * Migrations for the bot's `discord` schema (packages/db/migrations).
 *
 *   pnpm migrate          apply pending migrations
 *   pnpm migrate:status   list applied and pending
 *
 * DATABASE_URL must be a direct or session-pooler connection: DDL doesn't belong on the
 * transaction pooler. In CI it comes from Infisical (.github/workflows/migrate-db.yml).
 */
import { createDb } from "@nexus-bot/db";
import { migrate, migrationStatus } from "@nexus-bot/db/migrate";
import { loadEnv, requireEnv } from "./lib/env";

loadEnv();
const { DATABASE_URL } = requireEnv("DATABASE_URL");
const command = process.argv[2] ?? "up";
const db = createDb(DATABASE_URL);

try {
  if (command === "up") {
    const applied = await migrate(db, { log: (message) => console.log(message) });
    console.log(applied.length ? `Applied ${applied.length} migration(s).` : "Already up to date.");
  } else if (command === "status") {
    const { applied, pending } = await migrationStatus(db);
    for (const name of applied) console.log(`  applied  ${name}`);
    for (const name of pending) console.log(`  pending  ${name}`);
  } else {
    console.error(`Unknown command "${command}". Use "up" or "status".`);
    process.exitCode = 1;
  }
} finally {
  await db.end();
}
