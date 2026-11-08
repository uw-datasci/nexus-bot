import {
  ChannelType,
  ComponentType,
  deferred,
  deferredUpdate,
  type APIChatInputApplicationCommandInteraction,
  type APIInteractionResponseCallbackData,
  type APIMessage,
  type APIMessageComponentInteraction,
  type APIModalSubmitInteraction,
} from "@nexus-bot/discord";
import type { CreateDraftResult } from "../../admin-api";
import type { HandlerContext, HandlerResult } from "../../types";
import {
  COMMAND_NAME,
  FIXED_NOTICE,
  buildCancelledCard,
  buildCreatedCard,
  buildFailureCard,
  buildPreviewCard,
  buildReviewModal,
  buildValidationError,
  draftIdFrom,
  ephemeral,
  ephemeralMessage,
  updateMessage,
  validationErrorMessage,
} from "./cards";
import { ExtractionError } from "./extract";
import { formatTorontoTime, parseTorontoTime } from "./time";
import {
  EVENT_CATEGORIES,
  type DraftSubmission,
  type EventCategory,
  type EventDraft,
} from "./types";

/**
 * /event-create, ported from uwdsc-website-v3's discord-bot/eventBot.service.ts with behaviour
 * unchanged. One difference in how it's done, not in what execs see: the event is created through
 * the admin internal API, a cross-app HTTP call that may not fit Discord's 3-second window, so the
 * modal submit acknowledges first and creates the event in the background.
 */

/**
 * Each run is one paid LLM call, so cap how often it can be triggered: per exec (bounds a
 * spamming or compromised account) and per thread (bounds double-runs on the same thread).
 * The hard spend ceiling is the Claude Console workspace limit on ANTHROPIC_API_KEY.
 */
export const RUNS_PER_EXEC = 5;
export const EXEC_WINDOW_S = 60 * 60;
export const THREAD_COOLDOWN_S = 60;

const ROUTE = "discord:event-bot";
const THREAD_CHANNEL_TYPES: ReadonlySet<number> = new Set([
  ChannelType.AnnouncementThread,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
]);
const CATEGORIES: ReadonlySet<string> = new Set<string>(EVENT_CATEGORIES);

type DraftLookup = { draft: EventDraft } | { rejection: string };

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Collect `custom_id → value` from a modal submit (action rows or label components). */
export function readModalValues(components: unknown[] = []): Record<string, string> {
  const values: Record<string, string> = {};
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const c = node as {
      custom_id?: unknown;
      value?: unknown;
      components?: unknown[];
      component?: unknown;
    };
    if (typeof c.custom_id === "string" && typeof c.value === "string")
      values[c.custom_id] = c.value;
    c.components?.forEach(visit);
    if (c.component) visit(c.component);
  };
  components.forEach(visit);
  return values;
}

/** Modal prefill: the last submitted values win over the LLM's extraction. */
export function prefillValues(draft: EventDraft): Partial<DraftSubmission> {
  return {
    name: draft.submitted_name ?? draft.name ?? undefined,
    location: draft.submitted_location ?? draft.location ?? undefined,
    start: draft.submitted_start ?? formatTorontoTime(draft.start_time) ?? undefined,
    end: draft.submitted_end ?? formatTorontoTime(draft.end_time) ?? undefined,
    description: draft.submitted_description ?? draft.description ?? undefined,
  };
}

const statusOf = (error: unknown) => (error as { status?: unknown })?.status;

/** A short, safe explanation for the failure card (details go to Raft, not Discord). */
function describeFailure(error: unknown): string {
  if (error instanceof ExtractionError) return error.message;
  if (statusOf(error) === 403 || statusOf(error) === 404) {
    return "I can't read this thread. Make sure I have View Channel and Read Message History here (and, for a private thread, that I've been added to it).";
  }
  return "Something went wrong while reading the thread. The error has been logged for the dev team.";
}

/**
 * Background work runs after the reply, where nothing above can catch it: report failures to
 * Raft ourselves and, where possible, show the failure in Discord.
 */
async function runInBackground(
  ctx: HandlerContext,
  step: string,
  context: Record<string, unknown>,
  work: () => Promise<void>,
  onFailure?: (error: unknown) => Promise<void>
): Promise<void> {
  try {
    await work();
  } catch (error) {
    await ctx.reportError(
      error,
      {
        route: ROUTE,
        step,
        ...context,
        ...(error instanceof ExtractionError && error.detail ? { detail: error.detail } : {}),
      },
      error instanceof ExtractionError ? error.severity : "error"
    );
    if (!onFailure) return;
    try {
      await onFailure(error);
    } catch (followUpError) {
      console.error(`[event-create] Failed to show the ${step} failure in Discord:`, followUpError);
    }
  }
}

/** A single message, or null if it doesn't exist (or isn't visible to the bot). */
async function getMessageOrNull(
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
async function getStarterMessage(ctx: HandlerContext, threadId: string, parentId: string | null) {
  const inThread = await getMessageOrNull(ctx, threadId, threadId);
  if (inThread || !parentId) return inThread;
  return getMessageOrNull(ctx, parentId, threadId);
}

// ─── /event-create ───────────────────────────────────────────────────────────

export async function handleCommand(
  interaction: APIChatInputApplicationCommandInteraction,
  ctx: HandlerContext
): Promise<HandlerResult> {
  const drafts = ctx.services.eventDrafts;
  const userId = interaction.member!.user.id;
  const channel = interaction.channel as
    { id: string; type: number; parent_id?: string | null } | undefined;
  if (!channel || !THREAD_CHANNEL_TYPES.has(channel.type)) {
    return {
      response: ephemeral(
        `Run \`/${COMMAND_NAME}\` inside the thread where the event is being planned.`
      ),
    };
  }

  const counts = await drafts.countRecentRuns(userId, channel.id, EXEC_WINDOW_S, THREAD_COOLDOWN_S);
  if (counts.by_channel > 0) {
    return {
      response: ephemeral(
        `\`/${COMMAND_NAME}\` was just run in this thread. Wait a minute before running it again.`
      ),
    };
  }
  if (counts.by_initiator >= RUNS_PER_EXEC) {
    return {
      response: ephemeral(
        `You've run \`/${COMMAND_NAME}\` ${RUNS_PER_EXEC} times in the last hour. Try again later.`
      ),
    };
  }

  const run = await drafts.startRun({
    initiator_discord_id: userId,
    guild_id: interaction.guild_id ?? "",
    channel_id: channel.id,
  });

  return {
    // Public "Bot is thinking..." placeholder; edited into the preview card in the background.
    response: deferred(),
    background: () =>
      runInBackground(
        ctx,
        "extract",
        { guildId: interaction.guild_id, channelId: channel.id, draftId: run.id },
        async () => {
          const [messages, starter] = await Promise.all([
            ctx.discord.channels.getMessages(channel.id, { limit: 100 }),
            getStarterMessage(ctx, channel.id, channel.parent_id ?? null),
          ]);
          if (starter && !messages.some((m) => m.id === starter.id)) messages.push(starter);

          const extracted = await ctx.services.extractEvent(messages, {
            starterId: channel.id,
            // A bot user's id is its application id: skip the bot's own messages.
            excludeAuthorId: ctx.applicationId,
          });
          const draft = await drafts.setExtracted(run.id, extracted);
          const card = await ctx.discord.interactions.editReply(
            ctx.applicationId,
            interaction.token,
            buildPreviewCard(draft)
          );
          await drafts.setCardMessage(draft.id, card.channel_id, card.id);
        },
        async (error) => {
          await ctx.discord.interactions.editReply(
            ctx.applicationId,
            interaction.token,
            buildFailureCard(describeFailure(error))
          );
          await drafts.cancel(run.id);
        }
      ),
  };
}

// ─── Buttons, select, modal ──────────────────────────────────────────────────

/** Initiator-only, pending, unexpired, or an ephemeral explanation of why not. */
async function loadActionableDraft(
  ctx: HandlerContext,
  customId: string,
  userId: string
): Promise<DraftLookup> {
  const draftId = draftIdFrom(customId);
  if (!draftId) return { rejection: "Unknown action." };
  const draft = await ctx.services.eventDrafts.getById(draftId);
  if (!draft) return { rejection: "This draft no longer exists." };
  if (draft.initiator_discord_id !== userId) {
    return { rejection: `Only <@${draft.initiator_discord_id}> can edit this event.` };
  }
  if (draft.status !== "pending") return { rejection: "This draft is no longer active." };
  if (draft.expires_at.getTime() <= ctx.now()) {
    return { rejection: `This draft expired, run \`/${COMMAND_NAME}\` again.` };
  }
  return { draft };
}

type ComponentHandler = (
  interaction: APIMessageComponentInteraction,
  ctx: HandlerContext
) => Promise<HandlerResult>;

/** Wrap a component handler with the draft lookup every control needs. */
function withDraft(
  handle: (
    interaction: APIMessageComponentInteraction,
    ctx: HandlerContext,
    draft: EventDraft,
    userId: string
  ) => Promise<HandlerResult>
): ComponentHandler {
  return async (interaction, ctx) => {
    const userId = interaction.member!.user.id;
    const lookup = await loadActionableDraft(ctx, interaction.data.custom_id, userId);
    if ("rejection" in lookup) return { response: ephemeral(lookup.rejection) };
    return handle(interaction, ctx, lookup.draft, userId);
  };
}

export const handleCategory = withDraft(async (interaction, ctx, draft) => {
  const value =
    interaction.data.component_type === ComponentType.StringSelect
      ? interaction.data.values[0]
      : undefined;
  if (!value || !CATEGORIES.has(value)) return { response: ephemeral("Unknown category.") };

  const updated = await ctx.services.eventDrafts.updateCategory(draft.id, value as EventCategory);
  if (!updated) return { response: ephemeral("This draft is no longer active.") };
  return { response: updateMessage(buildPreviewCard(updated)) };
});

/** [Review & confirm] and [Fix]: instant, no LLM call, just the stored values. */
export const handleReview = withDraft(async (_interaction, _ctx, draft) => ({
  response: buildReviewModal(draft.id, prefillValues(draft)),
}));

export const handleCancel = withDraft(async (_interaction, ctx, draft, userId) => {
  const cancelled = await ctx.services.eventDrafts.cancel(draft.id);
  if (!cancelled) return { response: ephemeral("This draft is no longer active.") };
  return { response: updateMessage(buildCancelledCard(userId)) };
});

export async function handleModalSubmit(
  interaction: APIModalSubmitInteraction,
  ctx: HandlerContext
): Promise<HandlerResult> {
  const drafts = ctx.services.eventDrafts;
  const userId = interaction.member!.user.id;
  const lookup = await loadActionableDraft(ctx, interaction.data.custom_id, userId);
  if ("rejection" in lookup) return { response: ephemeral(lookup.rejection) };
  const { draft } = lookup;

  const values = readModalValues(interaction.data.components);
  const submission: DraftSubmission = {
    name: values.name ?? "",
    location: values.location ?? "",
    start: values.start ?? "",
    end: values.end ?? "",
    description: values.description ?? "",
  };
  // Stored first, so [Fix] reopens the modal with exactly what was typed.
  await drafts.saveSubmission(draft.id, submission);

  const invalid = (message: string) => ({ response: buildValidationError(draft.id, message) });

  if (!draft.category) return invalid("Pick a category from the menu on the event card first.");
  const start = parseTorontoTime(submission.start, "Start");
  if ("error" in start) return invalid(start.error);
  const end = parseTorontoTime(submission.end, "End");
  if ("error" in end) return invalid(end.error);
  const category = draft.category;

  // Atomic pending → created: a double submit loses here and can't create a second event.
  const claimed = await drafts.claimForCreation(draft.id);
  if (!claimed) {
    return { response: ephemeral("This draft was already submitted, cancelled, or has expired.") };
  }

  // Submitted from the card's own [Review & confirm] (the card is the interaction's message), or
  // via [Fix] on an ephemeral validation error.
  const fromCard = Boolean(interaction.message?.id && interaction.message.id === draft.message_id);
  const followUp = (data: APIInteractionResponseCallbackData) =>
    ctx.discord.interactions.followUp(ctx.applicationId, interaction.token, data);

  return {
    // Acknowledge now: creating the event is a call to the admin app.
    response: deferredUpdate(),
    background: () =>
      runInBackground(
        ctx,
        "create",
        { draftId: draft.id },
        async () => {
          let result: CreateDraftResult;
          try {
            result = await ctx.services.adminApi.createDraftEvent(
              {
                name: submission.name,
                location: submission.location,
                description: submission.description,
                start_time: start.iso,
                end_time: end.iso,
                category,
                image_url: null,
                resources: [],
              },
              { discordId: userId }
            );
          } catch (error) {
            await drafts.releaseClaim(draft.id);
            throw error;
          }

          if (!result.ok) {
            await drafts.releaseClaim(draft.id);
            // The admin form's own validation message, with [Fix] to reopen the modal.
            await followUp(
              result.status === 400
                ? validationErrorMessage(draft.id, result.message)
                : ephemeralMessage(`Couldn't create the event: ${result.message}.`)
            );
            return;
          }

          await drafts.setCreatedEvent(draft.id, result.event.id);
          const createdCard = buildCreatedCard(result.event, userId);
          if (fromCard) {
            await ctx.discord.interactions.editReply(
              ctx.applicationId,
              interaction.token,
              createdCard
            );
            return;
          }
          // Close out the ephemeral [Fix] message, and edit the public card with the bot token
          // (the original interaction token may be past its 15-minute lifetime).
          await ctx.discord.interactions.editReply(
            ctx.applicationId,
            interaction.token,
            FIXED_NOTICE
          );
          if (draft.message_id)
            await ctx.discord.channels.editMessage(draft.channel_id, draft.message_id, createdCard);
        },
        async () => {
          await followUp(
            ephemeralMessage(
              "Couldn't create the event. The error has been logged for the dev team."
            )
          );
        }
      ),
  };
}
