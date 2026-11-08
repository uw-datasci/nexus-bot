-- /feedback drafts: one row per run that found something to file. The card's controls edit
-- `items` until Create files one GitHub issue per kept item. Rate limits use discord.usage.

CREATE TABLE discord.feedback_drafts (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id           text        NOT NULL,
  -- Where the card is (the channel or thread /feedback was run in).
  channel_id         text        NOT NULL,
  runner_discord_id  text        NOT NULL,
  -- A key of the guild's `feedback_apps` setting, e.g. 'cxc'.
  app                text        NOT NULL,
  mode               text        NOT NULL CHECK (mode IN ('prompt', 'thread', 'channel', 'message')),
  -- FeedbackItem[] (packages/core/src/features/feedback/types.ts). Each item's `issue` is set as
  -- soon as it's filed, so a retried Create never files it twice.
  items              jsonb       NOT NULL DEFAULT '[]',
  -- Jump links to the messages the run read.
  sources            jsonb       NOT NULL DEFAULT '[]',
  public_repo        boolean     NOT NULL DEFAULT true,
  status             text        NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'creating', 'created', 'cancelled')),
  -- The public card, once posted. The workflows find it through the issue's hidden block.
  message_id         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL DEFAULT now() + interval '1 hour'
);

-- Channel mode reads the messages after the newest card in the channel.
CREATE INDEX feedback_drafts_channel_idx ON discord.feedback_drafts (channel_id, created_at DESC)
  WHERE message_id IS NOT NULL;

COMMENT ON TABLE discord.feedback_drafts IS
  'One row per /feedback run that found something: the preview card''s items until they are filed as GitHub issues.';

ALTER TABLE discord.feedback_drafts ENABLE ROW LEVEL SECURITY;
