import type { feedback } from "@nexus-bot/core";
import type { Db } from "./connection";

export interface UsageRun {
  guildId: string;
  userId: string;
  feature: string;
  channelId?: string | null;
}

/** discord.usage: one row per feature run, for rate limits. Never holds message content. */
export class UsageRepository implements feedback.UsageStore {
  constructor(private readonly sql: Db) {}

  async record({ guildId, userId, feature, channelId = null }: UsageRun): Promise<void> {
    await this.sql`
      INSERT INTO discord.usage (guild_id, user_id, feature, channel_id)
      VALUES (${guildId}, ${userId}, ${feature}, ${channelId})`;
  }

  /**
   * Runs of `feature` in the last `windowSeconds`, by this user and (separately) in this channel.
   * E.g. /event-create: 5 per exec per hour, 1 per thread per minute.
   */
  async recentRuns({
    feature,
    userId,
    channelId,
    userWindowSeconds,
    channelWindowSeconds,
  }: {
    feature: string;
    userId: string;
    channelId: string;
    userWindowSeconds: number;
    channelWindowSeconds: number;
  }): Promise<{ byUser: number; byChannel: number }> {
    const [row] = await this.sql<{ by_user: number; by_channel: number }[]>`
      SELECT
        count(*) FILTER (WHERE user_id = ${userId} AND created_at > now() - make_interval(secs => ${userWindowSeconds}))::int AS by_user,
        count(*) FILTER (WHERE channel_id = ${channelId} AND created_at > now() - make_interval(secs => ${channelWindowSeconds}))::int AS by_channel
      FROM discord.usage
      WHERE feature = ${feature}
        AND (user_id = ${userId} OR channel_id = ${channelId})
        AND created_at > now() - make_interval(secs => ${Math.max(userWindowSeconds, channelWindowSeconds)})`;
    return { byUser: row?.by_user ?? 0, byChannel: row?.by_channel ?? 0 };
  }
}
