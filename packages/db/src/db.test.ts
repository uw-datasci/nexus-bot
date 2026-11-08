import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "./connection";
import { loadMigrations, migrate, migrationStatus } from "./migrate";
import { SettingsRepository } from "./settings.repository";
import { UsageRepository } from "./usage.repository";

/**
 * Against a real Postgres: TEST_DATABASE_URL must point at a throwaway database, because these
 * tests drop the `discord` schema. Without it they're skipped (CI always sets it).
 */
const url = process.env.TEST_DATABASE_URL;
const ALL = ["0001_discord_schema", "0002_event_drafts", "0003_feedback_drafts"];

describe("loadMigrations", () => {
  it("reads the repo's migrations in order", () => {
    expect(loadMigrations().map((m) => m.name)).toEqual(ALL);
  });

  it("rejects badly named files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nb-mig-"));
    fs.writeFileSync(path.join(dir, "add-things.sql"), "");
    expect(() => loadMigrations(dir)).toThrow(/named like/);
  });
});

describe.skipIf(!url)("database", () => {
  let db: Db;

  beforeEach(async () => {
    db ??= createDb(url!);
    await db`DROP SCHEMA IF EXISTS discord CASCADE`;
  });

  afterAll(async () => {
    await db?.end();
  });

  it("creates the schema and tables, records them in its own table, and re-runs as a no-op", async () => {
    expect(await migrate(db)).toEqual(ALL);
    expect(await migrate(db)).toEqual([]);

    const tables = await db<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'discord' ORDER BY table_name`;
    expect(tables.map((t) => t.table_name)).toEqual([
      "event_drafts",
      "feedback_drafts",
      "schema_migrations",
      "settings",
      "usage",
    ]);
    expect(await migrationStatus(db)).toEqual({ applied: ALL, pending: [] });
    // Nothing in public: the website's migrations table is never touched.
    const [publicTable] = await db`SELECT to_regclass('public.schema_migrations') AS name`;
    expect(publicTable?.name).toBeNull();
  });

  it("reports pending migrations before the first run", async () => {
    expect(await migrationStatus(db)).toEqual({ applied: [], pending: ALL });
  });

  it("rolls back everything when a migration fails", async () => {
    const migrations = [
      ...loadMigrations(),
      { name: "0002_broken", sql: "CREATE TABLE discord.ok (id int); SELECT nope;" },
    ];
    await expect(migrate(db, { migrations })).rejects.toThrow();
    const [schema] = await db`SELECT 1 FROM pg_namespace WHERE nspname = 'discord'`;
    expect(schema).toBeUndefined();
  });

  it("stores settings per guild, and upserting the same values twice changes nothing", async () => {
    await migrate(db);
    const settings = new SettingsRepository(db);
    expect(await settings.forGuild("1")).toBeNull();

    const seed = { kind: "exec", require_linked_accounts: false, role_ids: { exec: ["2"] } };
    expect((await settings.upsertMany("1", seed)).changed.sort()).toEqual([
      "kind",
      "require_linked_accounts",
      "role_ids",
    ]);
    expect((await settings.upsertMany("1", seed)).changed).toEqual([]);
    expect((await settings.upsertMany("1", { role_ids: { exec: ["3"] } })).changed).toEqual([
      "role_ids",
    ]);

    expect(await settings.forGuild("1")).toEqual({ ...seed, role_ids: { exec: ["3"] } });
    expect(await settings.guildIds()).toEqual(["1"]);
  });

  it("counts recent runs by user and by channel", async () => {
    await migrate(db);
    const usage = new UsageRepository(db);
    await usage.record({ guildId: "g", userId: "u1", feature: "evt", channelId: "c1" });
    await usage.record({ guildId: "g", userId: "u1", feature: "evt", channelId: "c2" });
    await usage.record({ guildId: "g", userId: "u2", feature: "evt", channelId: "c1" });
    await usage.record({ guildId: "g", userId: "u1", feature: "other", channelId: "c1" });
    await db`UPDATE discord.usage SET created_at = now() - interval '2 hours' WHERE channel_id = 'c2'`;

    const counts = (userId: string, channelId: string) =>
      usage.recentRuns({
        feature: "evt",
        userId,
        channelId,
        userWindowSeconds: 3600,
        channelWindowSeconds: 60,
      });
    expect(await counts("u1", "c1")).toEqual({ byUser: 1, byChannel: 2 });
    expect(await counts("u3", "c9")).toEqual({ byUser: 0, byChannel: 0 });
  });
});
