import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db, Queryable } from "./connection";

/**
 * Migrations for the bot-owned `discord` schema: plain .sql files in packages/db/migrations,
 * applied in name order and recorded in discord.schema_migrations (the bot's own table, never
 * the website's). Up only: to undo something, add a new migration.
 *
 * Everything runs in one transaction under an advisory lock, so two runners can't interleave and
 * a failing file leaves nothing half-applied.
 */

export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../migrations"
);
const FILE_NAME = /^(\d{4}_[a-z0-9_]+)\.sql$/;
const LOCK_KEY = "nexus-bot:discord-migrations";

export interface Migration {
  name: string;
  sql: string;
}

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  const files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  return files.map((file) => {
    const match = FILE_NAME.exec(file);
    if (!match) throw new Error(`Migration ${file} must be named like 0002_add_event_drafts.sql`);
    return { name: match[1]!, sql: fs.readFileSync(path.join(dir, file), "utf8") };
  });
}

async function ensureHistory(sql: Queryable): Promise<void> {
  // The nexus_bot role can't CREATE on the database, and CREATE SCHEMA IF NOT EXISTS still checks
  // that privilege, so only create the schema when it's actually missing (local and test DBs).
  const [schema] = await sql`SELECT 1 FROM pg_namespace WHERE nspname = 'discord'`;
  if (!schema) await sql`CREATE SCHEMA discord`;
  await sql`
    CREATE TABLE IF NOT EXISTS discord.schema_migrations (
      name       text        PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
}

async function appliedNames(sql: Queryable): Promise<Set<string>> {
  const rows = await sql<{ name: string }[]>`SELECT name FROM discord.schema_migrations`;
  return new Set(rows.map((row) => row.name));
}

/** Apply every pending migration. Returns the names applied (empty when up to date). */
export async function migrate(
  db: Db,
  { migrations = loadMigrations(), log = (_: string) => {} } = {}
): Promise<string[]> {
  return db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${LOCK_KEY}))`;
    await ensureHistory(tx);
    const applied = await appliedNames(tx);
    const pending = migrations.filter((m) => !applied.has(m.name));
    for (const migration of pending) {
      log(`Applying ${migration.name}`);
      await tx.unsafe(migration.sql);
      await tx`INSERT INTO discord.schema_migrations (name) VALUES (${migration.name})`;
    }
    return pending.map((m) => m.name);
  });
}

export async function migrationStatus(
  db: Db,
  migrations = loadMigrations()
): Promise<{ applied: string[]; pending: string[] }> {
  const [table] = await db`SELECT to_regclass('discord.schema_migrations') AS name`;
  const applied = table?.name ? await appliedNames(db) : new Set<string>();
  return {
    applied: migrations.filter((m) => applied.has(m.name)).map((m) => m.name),
    pending: migrations.filter((m) => !applied.has(m.name)).map((m) => m.name),
  };
}
