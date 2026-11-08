/**
 * Load config/guilds.yaml into discord.settings. Safe to re-run: keys are upserted, unchanged
 * values aren't touched, and keys missing from the file are left alone (remove those by hand).
 *
 *   pnpm seed-settings              write
 *   pnpm seed-settings --dry-run    validate and print, no database needed
 */
import { SettingsRepository, createDb } from "@nexus-bot/db";
import { hasFlag, loadEnv, requireEnv } from "./lib/env";
import { readGuildsConfig } from "./lib/guilds-config";

loadEnv();
const guilds = readGuildsConfig();

if (hasFlag("--dry-run")) {
  for (const guild of guilds) {
    console.log(
      `${guild.name} (${guild.id}, ${guild.parsed.kind}): ${Object.keys(guild.settings).join(", ")}`
    );
  }
  process.exit(0);
}

const { DATABASE_URL } = requireEnv("DATABASE_URL");
const db = createDb(DATABASE_URL);
try {
  const settings = new SettingsRepository(db);
  for (const guild of guilds) {
    const { changed } = await settings.upsertMany(guild.id, guild.settings);
    console.log(
      `${guild.name} (${guild.id}): ${changed.length ? `updated ${changed.join(", ")}` : "no changes"}`
    );
  }
} finally {
  await db.end();
}
