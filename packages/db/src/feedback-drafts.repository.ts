import type { feedback } from "@nexus-bot/core";
import type postgres from "postgres";
import type { Db } from "./connection";

type FeedbackDraft = feedback.FeedbackDraft;
const json = (sql: Db, value: unknown) => sql.json(value as postgres.JSONValue);

/**
 * discord.feedback_drafts, one row per /feedback run that found something to file. Mutations a
 * user can trigger are guarded by status, so a stale or double click can't revive a card or file
 * its issues twice.
 */
export class FeedbackDraftRepository implements feedback.FeedbackDraftStore {
  constructor(private readonly sql: Db) {}

  async create(data: feedback.NewFeedbackDraft): Promise<FeedbackDraft> {
    const [draft] = await this.sql<FeedbackDraft[]>`
      INSERT INTO discord.feedback_drafts
        (guild_id, channel_id, runner_discord_id, app, mode, items, sources, public_repo)
      VALUES (${data.guild_id}, ${data.channel_id}, ${data.runner_discord_id}, ${data.app},
              ${data.mode}, ${json(this.sql, data.items)}, ${json(this.sql, data.sources)},
              ${data.public_repo})
      RETURNING *`;
    if (!draft) throw new Error("Failed to insert feedback draft");
    return draft;
  }

  async getById(id: string): Promise<FeedbackDraft | null> {
    const [draft] = await this.sql<FeedbackDraft[]>`
      SELECT * FROM discord.feedback_drafts WHERE id = ${id} LIMIT 1`;
    return draft ?? null;
  }

  async setCardMessage(id: string, messageId: string): Promise<void> {
    await this.sql`UPDATE discord.feedback_drafts SET message_id = ${messageId} WHERE id = ${id}`;
  }

  async lastCardMessageId(channelId: string): Promise<string | null> {
    const [row] = await this.sql<{ message_id: string }[]>`
      SELECT message_id FROM discord.feedback_drafts
      WHERE channel_id = ${channelId} AND message_id IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1`;
    return row?.message_id ?? null;
  }

  async updateItems(id: string, items: feedback.FeedbackItem[]): Promise<FeedbackDraft | null> {
    const [draft] = await this.sql<FeedbackDraft[]>`
      UPDATE discord.feedback_drafts SET items = ${json(this.sql, items)}
      WHERE id = ${id} AND status = 'pending'
      RETURNING *`;
    return draft ?? null;
  }

  async claimForCreating(id: string): Promise<FeedbackDraft | null> {
    const [draft] = await this.sql<FeedbackDraft[]>`
      UPDATE discord.feedback_drafts SET status = 'creating'
      WHERE id = ${id} AND status = 'pending' AND expires_at > now()
      RETURNING *`;
    return draft ?? null;
  }

  async setItemIssue(
    id: string,
    index: number,
    issue: { number: number; url: string }
  ): Promise<void> {
    await this.sql`
      UPDATE discord.feedback_drafts
      SET items = jsonb_set(items, ARRAY[${String(index)}::text, 'issue'], ${json(this.sql, issue)})
      WHERE id = ${id} AND jsonb_array_length(items) > ${index}`;
  }

  async releaseClaim(id: string): Promise<FeedbackDraft | null> {
    const [draft] = await this.sql<FeedbackDraft[]>`
      UPDATE discord.feedback_drafts SET status = 'pending'
      WHERE id = ${id} AND status = 'creating'
      RETURNING *`;
    return draft ?? null;
  }

  async markCreated(id: string): Promise<FeedbackDraft | null> {
    const [draft] = await this.sql<FeedbackDraft[]>`
      UPDATE discord.feedback_drafts SET status = 'created'
      WHERE id = ${id} AND status = 'creating'
      RETURNING *`;
    return draft ?? null;
  }

  async cancel(id: string): Promise<FeedbackDraft | null> {
    const [draft] = await this.sql<FeedbackDraft[]>`
      UPDATE discord.feedback_drafts SET status = 'cancelled'
      WHERE id = ${id} AND status = 'pending'
      RETURNING *`;
    return draft ?? null;
  }
}
