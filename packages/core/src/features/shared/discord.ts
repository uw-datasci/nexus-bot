import {
  ChannelType,
  ComponentType,
  type APIAttachment,
  type APIMessage,
  type APIModalSubmitInteraction,
} from "@nexus-bot/discord";
import type { HandlerContext, Severity } from "../../types";

/** Helpers every feature that reads channels or modals needs. */

export const THREAD_CHANNEL_TYPES: ReadonlySet<number> = new Set([
  ChannelType.AnnouncementThread,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
]);

/** The HTTP status on a Discord (or other) client error, if it has one. */
export const statusOf = (error: unknown) => (error as { status?: unknown })?.status;

/** The channel an interaction came from, as much of it as Discord sends. */
export type InteractionChannel = { id: string; type: number; parent_id?: string | null };

/** A single message, or null if it doesn't exist (or isn't visible to the bot). */
export async function getMessageOrNull(
  ctx: HandlerContext,
  channelId: string,
  messageId: string
): Promise<APIMessage | null> {
  try {
    return await ctx.discord.channels.getMessage(channelId, messageId);
  } catch (error) {
    if (statusOf(error) === 404 || statusOf(error) === 403) return null;
    throw error;
  }
}

/**
 * The message a thread was started from has the thread's id. For forum posts it lives in the
 * thread itself; for threads started from a channel message it lives in the parent.
 */
export async function getStarterMessage(
  ctx: HandlerContext,
  threadId: string,
  parentId: string | null
) {
  const inThread = await getMessageOrNull(ctx, threadId, threadId);
  if (inThread || !parentId) return inThread;
  return getMessageOrNull(ctx, parentId, threadId);
}

/** Collect `custom_id → value` for the text inputs of a modal submit. */
export function readModalValues(components: unknown[] = []): Record<string, string> {
  return readModal({ components } as never).text;
}

export interface ModalInput {
  /** Text inputs: custom_id → what was typed. */
  text: Record<string, string>;
  /** Selects: custom_id → the chosen values. */
  selects: Record<string, string[]>;
  /** File uploads: custom_id → the uploaded attachments. */
  files: Record<string, APIAttachment[]>;
}

/** Everything a modal submit carries, whether in action rows or labels. */
export function readModal(
  data: Pick<APIModalSubmitInteraction["data"], "components" | "resolved">
) {
  const input: ModalInput = { text: {}, selects: {}, files: {} };
  const attachments = data.resolved?.attachments ?? {};
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const c = node as {
      type?: unknown;
      custom_id?: unknown;
      value?: unknown;
      values?: unknown;
      components?: unknown[];
      component?: unknown;
    };
    if (typeof c.custom_id === "string") {
      if (typeof c.value === "string") input.text[c.custom_id] = c.value;
      if (Array.isArray(c.values)) {
        const values = c.values.filter((v): v is string => typeof v === "string");
        if (c.type === ComponentType.FileUpload) {
          input.files[c.custom_id] = values
            .map((id) => attachments[id])
            .filter((a): a is APIAttachment => Boolean(a));
        } else {
          input.selects[c.custom_id] = values;
        }
      }
    }
    c.components?.forEach(visit);
    if (c.component) visit(c.component);
  };
  (data.components ?? []).forEach(visit);
  return input;
}

/** An error that carries its own Raft severity and extra detail (e.g. an LLM failure). */
interface DetailedError {
  severity?: Severity;
  detail?: string;
}

/**
 * Background work runs after the reply, where the dispatcher can't show anything: report failures
 * to Raft here and, where possible, tell the user in Discord.
 */
export async function runInBackground(
  ctx: HandlerContext,
  route: string,
  step: string,
  context: Record<string, unknown>,
  work: () => Promise<void>,
  onFailure?: (error: unknown) => Promise<void>
): Promise<void> {
  try {
    await work();
  } catch (error) {
    const { severity, detail } = (error ?? {}) as DetailedError;
    await ctx.reportError(
      error,
      { route, step, ...context, ...(detail ? { detail } : {}) },
      severity ?? "error"
    );
    if (!onFailure) return;
    try {
      await onFailure(error);
    } catch (followUpError) {
      console.error(`[${route}] Failed to show the ${step} failure in Discord:`, followUpError);
    }
  }
}
