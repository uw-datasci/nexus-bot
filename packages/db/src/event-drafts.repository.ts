import type { eventCreate } from "@nexus-bot/core";
import type { Db } from "./connection";

type EventDraft = eventCreate.EventDraft;

/**
 * discord.event_drafts, one row per /event-create run. Ported from the website's
 * EventDraftRepository. Every mutation a user can trigger is guarded by `status = 'pending'`, so a
 * stale or double click can't revive a finished draft.
 */
export class EventDraftRepository implements eventCreate.EventDraftStore {
  constructor(private readonly sql: Db) {}

  async startRun(data: {
    initiator_discord_id: string;
    guild_id: string;
    channel_id: string;
  }): Promise<EventDraft> {
    const [draft] = await this.sql<EventDraft[]>`
      INSERT INTO discord.event_drafts (initiator_discord_id, guild_id, channel_id)
      VALUES (${data.initiator_discord_id}, ${data.guild_id}, ${data.channel_id})
      RETURNING *`;
    if (!draft) throw new Error("Failed to insert event draft");
    return draft;
  }

  async setExtracted(id: string, data: eventCreate.ExtractedEvent): Promise<EventDraft> {
    const [draft] = await this.sql<EventDraft[]>`
      UPDATE discord.event_drafts
      SET name = ${data.name},
          location = ${data.location},
          description = ${data.description},
          start_time = ${data.start_time},
          end_time = ${data.end_time},
          category = ${data.category},
          expires_at = now() + interval '1 hour'
      WHERE id = ${id}
      RETURNING *`;
    if (!draft) throw new Error(`Event draft ${id} not found`);
    return draft;
  }

  async countRecentRuns(
    initiatorId: string,
    channelId: string,
    initiatorWindowS: number,
    channelWindowS: number
  ): Promise<eventCreate.RecentRunCounts> {
    const [row] = await this.sql<eventCreate.RecentRunCounts[]>`
      SELECT
        count(*) FILTER (
          WHERE initiator_discord_id = ${initiatorId}
            AND created_at > now() - make_interval(secs => ${initiatorWindowS})
        )::int AS by_initiator,
        count(*) FILTER (
          WHERE channel_id = ${channelId}
            AND created_at > now() - make_interval(secs => ${channelWindowS})
        )::int AS by_channel
      FROM discord.event_drafts
      WHERE initiator_discord_id = ${initiatorId} OR channel_id = ${channelId}`;
    return row ?? { by_initiator: 0, by_channel: 0 };
  }

  async getById(id: string): Promise<EventDraft | null> {
    const [draft] = await this.sql<
      EventDraft[]
    >`SELECT * FROM discord.event_drafts WHERE id = ${id} LIMIT 1`;
    return draft ?? null;
  }

  async setCardMessage(id: string, channelId: string, messageId: string): Promise<void> {
    await this.sql`
      UPDATE discord.event_drafts SET channel_id = ${channelId}, message_id = ${messageId} WHERE id = ${id}`;
  }

  async updateCategory(
    id: string,
    category: eventCreate.EventCategory
  ): Promise<EventDraft | null> {
    const [draft] = await this.sql<EventDraft[]>`
      UPDATE discord.event_drafts SET category = ${category}
      WHERE id = ${id} AND status = 'pending'
      RETURNING *`;
    return draft ?? null;
  }

  async saveSubmission(id: string, values: eventCreate.DraftSubmission): Promise<void> {
    await this.sql`
      UPDATE discord.event_drafts
      SET submitted_name = ${values.name},
          submitted_location = ${values.location},
          submitted_start = ${values.start},
          submitted_end = ${values.end},
          submitted_description = ${values.description}
      WHERE id = ${id} AND status = 'pending'`;
  }

  async claimForCreation(id: string): Promise<EventDraft | null> {
    const [draft] = await this.sql<EventDraft[]>`
      UPDATE discord.event_drafts SET status = 'created'
      WHERE id = ${id} AND status = 'pending' AND expires_at > now()
      RETURNING *`;
    return draft ?? null;
  }

  async releaseClaim(id: string): Promise<void> {
    await this.sql`
      UPDATE discord.event_drafts SET status = 'pending'
      WHERE id = ${id} AND status = 'created' AND created_event_id IS NULL`;
  }

  async setCreatedEvent(id: string, eventId: string): Promise<void> {
    await this.sql`UPDATE discord.event_drafts SET created_event_id = ${eventId} WHERE id = ${id}`;
  }

  async cancel(id: string): Promise<EventDraft | null> {
    const [draft] = await this.sql<EventDraft[]>`
      UPDATE discord.event_drafts SET status = 'cancelled'
      WHERE id = ${id} AND status = 'pending'
      RETURNING *`;
    return draft ?? null;
  }
}
