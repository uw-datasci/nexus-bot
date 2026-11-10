import type { Strictness } from "../../github-app";
import type { ImageMediaType } from "../../screenshots";

export const FEEDBACK_TYPES = ["bug", "change", "nit"] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

/** Production: seen on the live site. Staging: shown from `dev`, not in production yet. */
export const ENVIRONMENTS = ["prod", "staging"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/**
 * prompt: the runner typed the feedback (or attached screenshots) into /feedback.
 * thread: /feedback submitted empty in a thread, so the whole thread.
 * channel: /feedback submitted empty in a channel, so the recent messages there.
 * message: right-click → Apps → Send as feedback on one message.
 */
export const ENTRY_MODES = ["prompt", "thread", "channel", "message"] as const;
export type EntryMode = (typeof ENTRY_MODES)[number];

/** One future GitHub issue, as stored in discord.feedback_drafts.items. */
export interface FeedbackItem {
  title: string;
  type: FeedbackType;
  page: string | null;
  /** The organizer's own words, quoted in the issue. */
  verbatim: string;
  /** One line saying what should change. */
  restatement: string;
  /** Jump links to the Discord messages it came from. */
  sources: string[];
  /** Blob URLs of its screenshots. */
  screenshots: string[];
  environment: Environment | null;
  /** Left out with the card's "Leave items out" menu. */
  dropped: boolean;
  /** Set as soon as its issue exists, so a retried Create never files it twice. */
  issue: { number: number; url: string } | null;
}

export type FeedbackDraftStatus = "pending" | "creating" | "created" | "cancelled";

/** A row of discord.feedback_drafts: one per run that found something to file. */
export interface FeedbackDraft {
  id: string;
  guild_id: string;
  /** Where the card is. */
  channel_id: string;
  runner_discord_id: string;
  app: string;
  mode: EntryMode;
  items: FeedbackItem[];
  /** Jump links to every message the run read (empty in prompt mode outside a thread). */
  sources: string[];
  /** Whether the repo was public when the card was made (the card warns about it). */
  public_repo: boolean;
  status: FeedbackDraftStatus;
  message_id: string | null;
  created_at: Date;
  expires_at: Date;
}

export interface NewFeedbackDraft {
  guild_id: string;
  channel_id: string;
  runner_discord_id: string;
  app: string;
  mode: EntryMode;
  items: FeedbackItem[];
  sources: string[];
  public_repo: boolean;
}

/**
 * Where drafts live (packages/db implements it). Mutations a user can trigger are guarded by
 * status, so a stale or double click can't revive or re-file a draft.
 */
export interface FeedbackDraftStore {
  create(data: NewFeedbackDraft): Promise<FeedbackDraft>;
  getById(id: string): Promise<FeedbackDraft | null>;
  setCardMessage(id: string, messageId: string): Promise<void>;
  /** The newest card in this channel: channel mode reads only the messages after it. */
  lastCardMessageId(channelId: string): Promise<string | null>;
  /** Replace the items of a pending draft. */
  updateItems(id: string, items: FeedbackItem[]): Promise<FeedbackDraft | null>;
  /** Atomic pending → creating (and unexpired): only one Create click can win. */
  claimForCreating(id: string): Promise<FeedbackDraft | null>;
  setItemIssue(id: string, index: number, issue: { number: number; url: string }): Promise<void>;
  /** creating → pending, after a Create that didn't finish. */
  releaseClaim(id: string): Promise<FeedbackDraft | null>;
  markCreated(id: string): Promise<FeedbackDraft | null>;
  cancel(id: string): Promise<FeedbackDraft | null>;
}

/** discord.usage, for the rate limit (packages/db's UsageRepository). */
export interface UsageStore {
  record(run: {
    guildId: string;
    userId: string;
    feature: string;
    channelId?: string | null;
  }): Promise<void>;
  recentRuns(query: {
    feature: string;
    userId: string;
    channelId: string;
    userWindowSeconds: number;
    channelWindowSeconds: number;
  }): Promise<{ byUser: number; byChannel: number }>;
}

/** An image the model sees, numbered as in the transcript (`[image 2]`). */
export interface ExtractionImage {
  index: number;
  mediaType: ImageMediaType;
  /** base64 */
  data: string;
  /** e.g. "attached to /feedback" or "in m3" */
  label: string;
}

export interface FeedbackExtractionInput {
  app: string;
  mode: EntryMode;
  /** What the runner typed into /feedback (prompt mode). */
  runnerText: string | null;
  /** The modal's Page or URL. */
  page: string | null;
  /** `[mN] …` lines. In prompt mode this is the thread, as background only. */
  transcript: string;
  messageCount: number;
  images: ExtractionImage[];
  /** Images in the transcript that weren't sent (too large), so the model knows they exist. */
  imageCount: number;
  now?: Date;
}

/** One item as the model returned it, before the bot fills in links and screenshots. */
export interface ExtractedItem {
  title: string;
  type: FeedbackType | "question";
  page: string | null;
  verbatim: string;
  restatement: string;
  /** [mN] numbers */
  messages: number[];
  /** image numbers */
  screenshots: number[];
}

export type FeedbackExtractor = (input: FeedbackExtractionInput) => Promise<ExtractedItem[]>;

export type { Strictness };
