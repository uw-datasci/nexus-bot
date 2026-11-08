import {
  InteractionResponseType,
  MessageFlags,
  type APIInteractionResponse,
  type APIInteractionResponseCallbackData,
  type APIModalInteractionResponseCallbackData,
} from "discord-api-types/v10";

/**
 * Interaction response builders. Replies never ping anyone unless the caller sets
 * `allowed_mentions` itself: bot output often quotes user text.
 */

type MessageInput = string | APIInteractionResponseCallbackData;

function messageData(
  message: MessageInput,
  ephemeral: boolean
): APIInteractionResponseCallbackData {
  const data: APIInteractionResponseCallbackData =
    typeof message === "string" ? { content: message } : { ...message };
  data.allowed_mentions ??= { parse: [] };
  if (ephemeral) data.flags = (data.flags ?? 0) | MessageFlags.Ephemeral;
  return data;
}

export const pong = (): APIInteractionResponse => ({ type: InteractionResponseType.Pong });

export function reply(message: MessageInput, { ephemeral = false } = {}): APIInteractionResponse {
  return {
    type: InteractionResponseType.ChannelMessageWithSource,
    data: messageData(message, ephemeral),
  };
}

/** Shorthand for an ephemeral text reply: errors, denials, "only X can do this". */
export const ephemeral = (message: MessageInput): APIInteractionResponse =>
  reply(message, { ephemeral: true });

/** "Thinking…" now, the real reply later from `background` (edit the original response). */
export function deferred({ ephemeral = false } = {}): APIInteractionResponse {
  return {
    type: InteractionResponseType.DeferredChannelMessageWithSource,
    ...(ephemeral ? { data: { flags: MessageFlags.Ephemeral } } : {}),
  };
}

/** For a component: acknowledge now and edit the message it's on later. */
export const deferredUpdate = (): APIInteractionResponse => ({
  type: InteractionResponseType.DeferredMessageUpdate,
});

/** For a component: replace the message it's on. */
export function updateMessage(message: MessageInput): APIInteractionResponse {
  return { type: InteractionResponseType.UpdateMessage, data: messageData(message, false) };
}

export function modal(data: APIModalInteractionResponseCallbackData): APIInteractionResponse {
  return { type: InteractionResponseType.Modal, data };
}
