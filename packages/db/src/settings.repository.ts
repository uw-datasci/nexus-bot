import type postgres from "postgres";
import type { Db } from "./connection";

/**
 * discord.settings: one row per (guild, key), value as jsonb. What the keys mean lives in
 * packages/core (settings.ts); this only stores them.
 */
export class SettingsRepository {
  constructor(private readonly sql: Db) {}

  /** All of a guild's settings, or null if the guild has none (it isn't set up). */
  async forGuild(guildId: string): Promise<Record<string, unknown> | null> {
    const rows = await this.sql<{ key: string; value: unknown }[]>`
      SELECT key, value FROM discord.settings WHERE guild_id = ${guildId}`;
    if (rows.length === 0) return null;
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  /** Insert or update these keys. Keys not listed are left alone, so re-running a seed is safe. */
  async upsertMany(
    guildId: string,
    entries: Record<string, unknown>
  ): Promise<{ changed: string[] }> {
    const changed: string[] = [];
    await this.sql.begin(async (tx) => {
      for (const [key, value] of Object.entries(entries)) {
        const rows = await tx`
          INSERT INTO discord.settings (guild_id, key, value)
          VALUES (${guildId}, ${key}, ${tx.json(value as postgres.JSONValue)})
          ON CONFLICT (guild_id, key) DO UPDATE
            SET value = excluded.value, updated_at = now()
            WHERE discord.settings.value IS DISTINCT FROM excluded.value
          RETURNING key`;
        if (rows.length > 0) changed.push(key);
      }
    });
    return { changed };
  }

  async guildIds(): Promise<string[]> {
    const rows = await this.sql<
      { guild_id: string }[]
    >`SELECT DISTINCT guild_id FROM discord.settings ORDER BY guild_id`;
    return rows.map((row) => row.guild_id);
  }
}
