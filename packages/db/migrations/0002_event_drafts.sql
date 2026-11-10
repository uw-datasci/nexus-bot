-- /event-create drafts: one row per run. Same shape as the website's events.discord_event_drafts,
-- which this replaces, but with nothing from the `events` schema (the bot's role can't see it):
-- status and category are text with CHECKs, and created_event_id has no foreign key.
-- Starts empty: drafts expire after an hour, so there's nothing worth copying over.

CREATE TABLE discord.event_drafts (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  initiator_discord_id  text        NOT NULL,
  guild_id              text        NOT NULL,
  channel_id            text        NOT NULL,
  -- Set once the deferred response has been edited into the preview card. Stored so the card
  -- can be edited with the bot token after the 15-minute interaction token has expired.
  message_id            text,
  status                text        NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'created', 'cancelled')),

  -- Values extracted by the LLM (NULL = not clearly stated in the thread).
  name                  text,
  location              text,
  description           text,
  start_time            timestamptz,
  end_time              timestamptz,
  category              text CHECK (category IN ('workshop', 'social', 'academic')),

  -- Raw values from the last modal submit, so [Fix] can reopen the modal prefilled with them.
  submitted_name        text,
  submitted_location    text,
  submitted_start       text,
  submitted_end         text,
  submitted_description text,

  -- events.events.id on the website, once created. No foreign key: it's another schema's table.
  created_event_id      uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL DEFAULT now() + interval '1 hour'
);

-- The rate limits: runs per exec in the last hour, and per thread in the last minute.
CREATE INDEX event_drafts_initiator_idx ON discord.event_drafts (initiator_discord_id, created_at DESC);
CREATE INDEX event_drafts_channel_idx ON discord.event_drafts (channel_id, created_at DESC);

ALTER TABLE discord.event_drafts ENABLE ROW LEVEL SECURITY;
