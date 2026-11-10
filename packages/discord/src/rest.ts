import { API } from "@discordjs/core/http-only";
import { REST } from "@discordjs/rest";
import type { APIInteractionResponseCallbackData } from "discord-api-types/v10";

export type { API } from "@discordjs/core/http-only";

/**
 * The Discord REST client. Without a token it can still use interaction-token routes (replies and
 * their edits), which is all an HTTP-interactions bot needs for the first 15 minutes.
 */
export function createDiscordApi(botToken?: string): API {
  const rest = new REST({ version: "10" });
  if (botToken) rest.setToken(botToken);
  return new API(rest);
}

/** Interaction tokens work for 15 minutes; a minute's margin keeps an edit from racing it. */
export const INTERACTION_TOKEN_TTL_MS = 15 * 60 * 1000;
const TOKEN_MARGIN_MS = 60 * 1000;
const DISCORD_EPOCH = 1_420_070_400_000n;

/** When a snowflake (e.g. an interaction ID) was created, in milliseconds since the epoch. */
export function snowflakeTime(id: string): number {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

export interface InteractionMessageRef {
  applicationId: string;
  interactionId: string;
  interactionToken: string;
  channelId: string;
  /** The message to edit. Omit for the original response (only possible while the token works). */
  messageId?: string;
}

/**
 * Edit a message an interaction produced. While the interaction token is fresh this uses the
 * webhook route (no bot token needed). After 15 minutes the token is dead, so it falls back to the
 * bot token, which can edit the bot's own messages at any time.
 */
export async function editInteractionMessage(
  api: API,
  ref: InteractionMessageRef,
  body: Omit<APIInteractionResponseCallbackData, "flags" | "tts">,
  now = Date.now()
): Promise<void> {
  const age = now - snowflakeTime(ref.interactionId);
  if (age < INTERACTION_TOKEN_TTL_MS - TOKEN_MARGIN_MS) {
    await api.interactions.editReply(
      ref.applicationId,
      ref.interactionToken,
      body,
      ref.messageId ?? "@original"
    );
    return;
  }
  if (!ref.messageId) {
    throw new Error(
      "The interaction token has expired, and editing with the bot token needs the message ID"
    );
  }
  await api.channels.editMessage(ref.channelId, ref.messageId, body);
}
