import type { APIMessage } from "@nexus-bot/discord";
import type { FeedbackApp } from "../../settings";
import type { FeedbackDraft, FeedbackItem } from "./types";

/** Shared test data for the feedback tests. */

export const GUILD = "100000000000000001";
export const CXC_TEAM = "200000000000000010";
export const VP = "200000000000000011";
export const DESIGN = "200000000000000012";
export const CHANNEL = "300000000000000001";
export const THREAD = "300000000000000002";
export const RUNNER = "400000000000000001";
export const APP_ID = "500000000000000001";

export const CXC: FeedbackApp = {
  name: "cxc",
  repo: "uw-datasci/cxc",
  productionUrl: "https://cxc.uwdatascience.ca",
  roleSets: [[CXC_TEAM], [VP, DESIGN]],
  channels: [],
};

export const item = (overrides: Partial<FeedbackItem> = {}): FeedbackItem => ({
  title: "Fix the apply button",
  type: "bug",
  page: "https://cxc.uwdatascience.ca/apply",
  verbatim: "the apply button does nothing on mobile",
  restatement: "Make the apply button work on mobile.",
  sources: ["https://discord.com/channels/1/2/3"],
  screenshots: [],
  environment: "prod",
  dropped: false,
  issue: null,
  ...overrides,
});

export const draft = (overrides: Partial<FeedbackDraft> = {}): FeedbackDraft => ({
  id: "00000000-0000-4000-8000-000000000001",
  guild_id: GUILD,
  channel_id: THREAD,
  runner_discord_id: RUNNER,
  app: "cxc",
  mode: "thread",
  items: [item()],
  sources: ["https://discord.com/channels/1/2/3"],
  public_repo: true,
  status: "pending",
  message_id: "600000000000000001",
  created_at: new Date("2026-11-08T17:00:00Z"),
  expires_at: new Date("2026-11-08T18:00:00Z"),
  ...overrides,
});

let seq = 0;
/** A message; ids increase with each call so order is chronological. */
export function message(
  content: string,
  overrides: Partial<APIMessage> & { at?: string; name?: string; bot?: boolean } = {}
): APIMessage {
  seq++;
  const { at, name, bot, ...rest } = overrides;
  return {
    id: String(700000000000000000n + BigInt(seq)),
    channel_id: THREAD,
    content,
    timestamp: at ?? new Date(Date.parse("2026-11-08T16:00:00Z") + seq * 60_000).toISOString(),
    author: { id: bot ? APP_ID : "800000000000000001", username: name ?? "organizer", bot },
    attachments: [],
    ...rest,
  } as APIMessage;
}

export const image = (url: string, size = 1000) => ({
  id: url,
  filename: "shot.png",
  url,
  proxy_url: url,
  size,
  content_type: "image/png",
});
