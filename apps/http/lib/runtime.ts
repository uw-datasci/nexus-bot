import { RaftClient } from "@uw-datasci/raft";
import { put } from "@vercel/blob";
import {
  createAdminApi,
  createGitHubApp,
  createScreenshotStore,
  eventCreate,
  feedback,
  parseGuildSettings,
  registry,
  type BlobPut,
  type DispatchDeps,
} from "@nexus-bot/core";
import {
  EventDraftRepository,
  FeedbackDraftRepository,
  SettingsRepository,
  UsageRepository,
  createDb,
} from "@nexus-bot/db";
import { createDiscordApi } from "@nexus-bot/discord";

const REQUIRED = [
  "DISCORD_PUBLIC_KEY",
  "DISCORD_APPLICATION_ID",
  "DISCORD_BOT_TOKEN",
  "DATABASE_URL",
  "ADMIN_INTERNAL_URL",
  "NEXUS_BOT_INTERNAL_TOKEN",
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
  const db = createDb(env.DATABASE_URL, { pooled: true });
  const settings = new SettingsRepository(db);

  // Vercel Blob, for feedback screenshots. A public store: GitHub and the triage workflow load them.
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  const blobPut: BlobPut | undefined = blobToken
    ? (path, bytes, contentType) =>
        put(path, Buffer.from(bytes), {
          access: "public",
          contentType,
          addRandomSuffix: true,
          token: blobToken,
        })
    : undefined;

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
      reportError: (error, context, severity) =>
        RaftClient.getInstance().reportError(
          error instanceof Error ? error : new Error(String(error)),
          context,
          severity
        ),
      services: {
        eventDrafts: new EventDraftRepository(db),
        adminApi: createAdminApi({
          baseUrl: env.ADMIN_INTERNAL_URL,
          token: env.NEXUS_BOT_INTERNAL_TOKEN,
          // Only to call a preview deployment behind Vercel Deployment Protection.
          bypassToken: process.env.ADMIN_BYPASS_TOKEN || undefined,
        }),
        // A missing key fails each run with a clear card instead of failing every interaction.
        extractEvent: eventCreate.createClaudeExtractor({ apiKey: process.env.ANTHROPIC_API_KEY }),
        usage: new UsageRepository(db),
        // /feedback's keys are optional too: missing ones fail feedback runs with a clear message.
        feedbackDrafts: new FeedbackDraftRepository(db),
        github: createGitHubApp({
          appId: process.env.FEEDBACK_APP_ID,
          privateKey: process.env.FEEDBACK_APP_PRIVATE_KEY,
        }),
        screenshots: createScreenshotStore({ put: blobPut }),
        extractFeedback: feedback.createFeedbackExtractor({
          apiKey: process.env.FEEDBACK_ANTHROPIC_API_KEY,
        }),
      },
    },
  };
  return runtime;
}
