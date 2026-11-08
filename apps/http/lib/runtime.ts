import { RaftClient } from "@uw-datasci/raft";
import { parseGuildSettings, registry, type DispatchDeps } from "@nexus-bot/core";
import { SettingsRepository, createDb } from "@nexus-bot/db";
import { createDiscordApi } from "@nexus-bot/discord";

const REQUIRED = [
  "DISCORD_PUBLIC_KEY",
  "DISCORD_APPLICATION_ID",
  "DISCORD_BOT_TOKEN",
  "DATABASE_URL",
] as const;

interface Runtime {
  publicKey: string;
  dispatch: DispatchDeps;
}

let runtime: Runtime | null = null;

/** Built once per function instance and reused across requests (Fluid Compute keeps it warm). */
export function getRuntime(): Runtime {
  if (runtime) return runtime;

  const missing = REQUIRED.filter((name) => !process.env[name]);
  if (missing.length > 0) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  const env = Object.fromEntries(REQUIRED.map((name) => [name, process.env[name]!])) as Record<
    (typeof REQUIRED)[number],
    string
  >;

  // The Supabase transaction pooler: Vercel functions come and go, so no long-lived connections.
  const settings = new SettingsRepository(createDb(env.DATABASE_URL, { pooled: true }));

  runtime = {
    publicKey: env.DISCORD_PUBLIC_KEY,
    dispatch: {
      registry,
      discord: createDiscordApi(env.DISCORD_BOT_TOKEN),
      applicationId: env.DISCORD_APPLICATION_ID,
      loadSettings: async (guildId) => {
        const raw = await settings.forGuild(guildId);
        // Invalid rows throw a SettingsError, which surfaces as a 500 reported to Raft.
        return raw ? parseGuildSettings(guildId, raw) : null;
      },
      reportError: (error, context) =>
        RaftClient.getInstance().reportError(
          error instanceof Error ? error : new Error(String(error)),
          context
        ),
    },
  };
  return runtime;
}
