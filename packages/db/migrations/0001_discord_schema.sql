-- The bot-owned `discord` schema: settings and usage. Other tables arrive with their features.
-- The runner creates the schema itself (only if it's missing) and records each file in
-- discord.schema_migrations, so the bot never touches the website's migrations table.

CREATE TABLE discord.settings (
  guild_id   text        NOT NULL,
  key        text        NOT NULL,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, key)
);

COMMENT ON TABLE discord.settings IS
  'Per-guild bot settings (channel IDs, role IDs, flags). Seeded from config/guilds.yaml by scripts/seed-settings.ts.';

-- One row per feature run, for rate limits. No message content.
CREATE TABLE discord.usage (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guild_id   text        NOT NULL,
  user_id    text        NOT NULL,
  feature    text        NOT NULL,
  channel_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX usage_feature_user_idx ON discord.usage (feature, user_id, created_at DESC);
CREATE INDEX usage_feature_channel_idx ON discord.usage (feature, channel_id, created_at DESC)
  WHERE channel_id IS NOT NULL;

COMMENT ON TABLE discord.usage IS 'Per-user, per-feature run log for rate limits. No message content.';

-- Supabase hygiene: nothing outside the owning role (nexus_bot) reads these tables.
ALTER TABLE discord.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE discord.usage ENABLE ROW LEVEL SECURITY;
