import type { APIMessage } from "@nexus-bot/discord";

export const EVENT_CATEGORIES = ["workshop", "social", "academic"] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export type DraftStatus = "pending" | "created" | "cancelled";

/** What the LLM pulled out of the thread (null = nothing to go on). Times are UTC ISO strings. */
export interface ExtractedEvent {
  name: string | null;
  location: string | null;
  start_time: string | null;
  end_time: string | null;
  category: EventCategory | null;
  description: string | null;
}

/** Raw strings from the last review-modal submit (times as "YYYY-MM-DD HH:mm", Toronto). */
export interface DraftSubmission {
  name: string;
  location: string;
  start: string;
  end: string;
  description: string;
}

/** A row of discord.event_drafts: one per /event-create run. */
export interface EventDraft {
  id: string;
  initiator_discord_id: string;
  guild_id: string;
  channel_id: string;
  /** The public card, once the deferred reply has been edited into it. */
  message_id: string | null;
  status: DraftStatus;
  name: string | null;
  location: string | null;
  description: string | null;
  start_time: Date | null;
  end_time: Date | null;
  category: EventCategory | null;
  submitted_name: string | null;
  submitted_location: string | null;
  submitted_start: string | null;
  submitted_end: string | null;
  submitted_description: string | null;
  created_event_id: string | null;
  created_at: Date;
  expires_at: Date;
}

export interface RecentRunCounts {
  by_initiator: number;
  by_channel: number;
}

/**
 * Where drafts live (discord.event_drafts; packages/db implements it). Every mutation a user can
 * trigger is guarded by `status = 'pending'`, so a stale or double click can't revive a draft.
 */
export interface EventDraftStore {
  /** Inserted before the LLM call, so the rate limit counts every run, failed ones included. */
  startRun(data: {
    initiator_discord_id: string;
    guild_id: string;
    channel_id: string;
  }): Promise<EventDraft>;
  /** Store the extraction and restart the 1-hour expiry from when the card appears. */
  setExtracted(id: string, data: ExtractedEvent): Promise<EventDraft>;
  countRecentRuns(
    initiatorId: string,
    channelId: string,
    initiatorWindowS: number,
    channelWindowS: number
  ): Promise<RecentRunCounts>;
  getById(id: string): Promise<EventDraft | null>;
  setCardMessage(id: string, channelId: string, messageId: string): Promise<void>;
  updateCategory(id: string, category: EventCategory): Promise<EventDraft | null>;
  saveSubmission(id: string, values: DraftSubmission): Promise<void>;
  /** Atomic pending → created (and unexpired): only one concurrent submit can win. */
  claimForCreation(id: string): Promise<EventDraft | null>;
  /** Undo a claim when creating the event failed, so the exec can retry. */
  releaseClaim(id: string): Promise<void>;
  setCreatedEvent(id: string, eventId: string): Promise<void>;
  cancel(id: string): Promise<EventDraft | null>;
}

export type EventExtractor = (
  messages: APIMessage[],
  options: { starterId: string | null; excludeAuthorId: string; now?: Date }
) => Promise<ExtractedEvent>;
