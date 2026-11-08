/**
 * Register slash commands per guild, from the same registry the dispatcher uses. Each guild's
 * command list is bulk-overwritten, so it's safe to re-run and removed commands disappear.
 * Guild commands update instantly (global ones can take an hour), and the bot has none.
 *
 *   pnpm register-commands              register
 *   pnpm register-commands --dry-run    print what would be registered
 */
import { registry } from "@nexus-bot/core";
import { ApplicationCommandType, createDiscordApi } from "@nexus-bot/discord";
import { hasFlag, loadEnv, requireEnv } from "./lib/env";
import { readGuildsConfig, registrationPlan } from "./lib/guilds-config";

/** `/ping` for slash commands, `"Send as feedback" (message)` for right-click ones. */
const show = (c: { name: string; type?: ApplicationCommandType }) =>
  c.type === ApplicationCommandType.Message ? `"${c.name}" (message)` : `/${c.name}`;

loadEnv();
const plan = registrationPlan(readGuildsConfig(), registry);

if (hasFlag("--dry-run")) {
  for (const { guild, commands } of plan) {
    console.log(
      `${guild.name} (${guild.id}, ${guild.parsed.kind}): ${commands.map(show).join(" ") || "(none)"}`
    );
  }
  process.exit(0);
}

const { DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN } = requireEnv(
  "DISCORD_APPLICATION_ID",
  "DISCORD_BOT_TOKEN"
);
const api = createDiscordApi(DISCORD_BOT_TOKEN);

for (const { guild, commands } of plan) {
  const registered = await api.applicationCommands.bulkOverwriteGuildCommands(
    DISCORD_APPLICATION_ID,
    guild.id,
    commands
  );
  console.log(`${guild.name} (${guild.id}): ${registered.map(show).join(" ") || "(none)"}`);
}
