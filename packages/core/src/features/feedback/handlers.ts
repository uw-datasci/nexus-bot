import { randomUUID } from "node:crypto";
import {
  ComponentType,
  deferred,
  deferredUpdate,
  type APIAttachment,
  type APIChatInputApplicationCommandInteraction,
  type APIInteractionResponseCallbackData,
  type APIMessage,
  type APIMessageApplicationCommandInteraction,
  type APIMessageComponentInteraction,
  type APIModalSubmitInteraction,
} from "@nexus-bot/discord";
import { GitHubError } from "../../github-app";
import { IMAGE_TYPES, MAX_MODEL_IMAGE_BYTES, type DownloadedImage } from "../../screenshots";
import type { FeedbackApp } from "../../settings";
import type { HandlerContext, HandlerResult, Severity } from "../../types";
import {
  THREAD_CHANNEL_TYPES,
  getMessageOrNull,
  readModal,
  runInBackground,
  statusOf,
  type InteractionChannel,
} from "../shared/discord";
import { appsFor } from "./access";
import {
  CARD_POSTED,
  NOTHING_FOUND,
  buildCancelledCard,
  buildCreatedCard,
  buildIntakeModal,
  buildItemModal,
  buildMessageModal,
  buildPreviewCard,
  ephemeral,
  ephemeralMessage,
  parseDraftRef,
  updateMessage,
} from "./cards";
import { FeedbackExtractionError } from "./extract";
import { buildIssue } from "./issue";
import { buildItems, createBlocker, toFile } from "./items";
import {
  channelMessages,
  keepForTranscript,
  messageAndReplies,
  messageLink,
  pickImages,
  renderTranscript,
  threadMessages,
  type Gathered,
} from "./sources";
import {
  ENVIRONMENTS,
  FEEDBACK_TYPES,
  type EntryMode,
  type Environment,
  type ExtractionImage,
  type FeedbackDraft,
  type FeedbackItem,
  type FeedbackType,
} from "./types";

/**
 * Each run is one paid Haiku call: 10 per user per hour, counted in discord.usage. The hard spend
 * ceiling is the Claude Console workspace limit on FEEDBACK_ANTHROPIC_API_KEY.
 */
export const RUNS_PER_USER = 10;
export const RUN_WINDOW_S = 60 * 60;
export const USAGE_FEATURE = "feedback";

const ROUTE = "discord:feedback";
const NOT_ALLOWED =
  "You can't send feedback here. It needs one of an app's feedback roles (and, for some apps, one of its channels).";

type Member = NonNullable<APIModalSubmitInteraction["member"]>;
const displayName = (member: Member) =>
  member.nick ?? member.user.global_name ?? member.user.username;

const channelOf = (interaction: { channel?: unknown; channel_id?: string }) =>
  (interaction.channel as InteractionChannel | undefined) ??
  (interaction.channel_id ? { id: interaction.channel_id, type: -1 } : undefined);

async function rateLimitMessage(
  ctx: HandlerContext,
  userId: string,
  channelId: string
): Promise<string | null> {
  const { byUser } = await ctx.services.usage.recentRuns({
    feature: USAGE_FEATURE,
    userId,
    channelId,
    userWindowSeconds: RUN_WINDOW_S,
    channelWindowSeconds: 0,
  });
  return byUser >= RUNS_PER_USER
    ? `You've sent feedback ${RUNS_PER_USER} times in the last hour. Try again later.`
    : null;
}

const asEnvironment = (value: string | undefined): Environment | null =>
  ENVIRONMENTS.includes(value as Environment) ? (value as Environment) : null;

/** The app a run is for: the modal's choice, or the only one the member is allowed. */
function pickApp(apps: FeedbackApp[], chosen: string | undefined): FeedbackApp | null {
  if (chosen) return apps.find((app) => app.name === chosen) ?? null;
  return apps.length === 1 ? apps[0]! : null;
}

/** A short, safe explanation for Discord; the details go to Raft. */
function describeFailure(error: unknown, app: FeedbackApp): string {
  if (error instanceof FeedbackExtractionError)
    return `Couldn't read the feedback: ${error.message}`;
  if (error instanceof GitHubError) {
    return `Couldn't reach GitHub for ${app.repo}. The error has been logged for the dev team.`;
  }
  if (statusOf(error) === 403 || statusOf(error) === 404) {
    return "I can't read the messages here. Make sure I have View Channel and Read Message History (and, for a private thread, that I've been added to it).";
  }
  return "Something went wrong. The error has been logged for the dev team.";
}

// ─── /feedback and Send as feedback ──────────────────────────────────────────

export async function handleCommand(
  interaction: APIChatInputApplicationCommandInteraction,
  ctx: HandlerContext
): Promise<HandlerResult> {
  const member = interaction.member!;
  const channel = channelOf(interaction);
  const apps = appsFor(member.roles, channel, ctx.settings);
  if (apps.length === 0) return { response: ephemeral(NOT_ALLOWED) };
  const limited = await rateLimitMessage(ctx, member.user.id, channel?.id ?? "");
  if (limited) return { response: ephemeral(limited) };
  return { response: buildIntakeModal(apps) };
}

export async function handleMessageCommand(
  interaction: APIMessageApplicationCommandInteraction,
  ctx: HandlerContext
): Promise<HandlerResult> {
  const member = interaction.member!;
  const channel = channelOf(interaction);
  const apps = appsFor(member.roles, channel, ctx.settings);
  if (apps.length === 0 || !channel) return { response: ephemeral(NOT_ALLOWED) };
  const limited = await rateLimitMessage(ctx, member.user.id, channel.id);
  if (limited) return { response: ephemeral(limited) };

  const target = interaction.data.resolved.messages[interaction.data.target_id];
  if (!target) return { response: ephemeral("I can't see that message.") };
  if (apps.length > 1) return { response: buildMessageModal(target.id, apps) };
  return startRun(interaction, ctx, {
    app: apps[0]!,
    mode: "message",
    channel,
    target,
    text: null,
    page: null,
    environment: null,
    uploads: [],
  });
}

/** /feedback's modal: prompt mode if anything was typed or attached, else the thread or channel. */
export async function handleIntakeSubmit(
  interaction: APIModalSubmitInteraction,
  ctx: HandlerContext
): Promise<HandlerResult> {
  const member = interaction.member!;
  const channel = channelOf(interaction);
  const input = readModal(interaction.data);
  const app = pickApp(appsFor(member.roles, channel, ctx.settings), input.selects.app?.[0]);
  if (!app || !channel) return { response: ephemeral(NOT_ALLOWED) };
  const limited = await rateLimitMessage(ctx, member.user.id, channel.id);
  if (limited) return { response: ephemeral(limited) };

  const text = input.text.text?.trim() || null;
  const uploads = input.files.screenshots ?? [];
  const mode: EntryMode =
    text || uploads.length > 0
      ? "prompt"
      : THREAD_CHANNEL_TYPES.has(channel.type)
        ? "thread"
        : "channel";
  return startRun(interaction, ctx, {
    app,
    mode,
    channel,
    text,
    page: input.text.page?.trim() || null,
    environment: asEnvironment(input.selects.environment?.[0]),
    uploads,
  });
}

/** Send as feedback's modal, for someone allowed for more than one app. */
export async function handleMessageSubmit(
  interaction: APIModalSubmitInteraction,
  ctx: HandlerContext,
  messageId: string
): Promise<HandlerResult> {
  const member = interaction.member!;
  const channel = channelOf(interaction);
  const input = readModal(interaction.data);
  const app = pickApp(appsFor(member.roles, channel, ctx.settings), input.selects.app?.[0]);
  if (!app || !channel) return { response: ephemeral(NOT_ALLOWED) };
  if (!/^\d{17,20}$/.test(messageId)) return { response: ephemeral("Unknown message.") };
  const limited = await rateLimitMessage(ctx, member.user.id, channel.id);
  if (limited) return { response: ephemeral(limited) };
  return startRun(interaction, ctx, {
    app,
    mode: "message",
    channel,
    targetId: messageId,
    text: null,
    page: null,
    environment: asEnvironment(input.selects.environment?.[0]),
    uploads: [],
  });
}

// ─── The run ─────────────────────────────────────────────────────────────────

interface RunParams {
  app: FeedbackApp;
  mode: EntryMode;
  channel: InteractionChannel;
  text: string | null;
  page: string | null;
  environment: Environment | null;
  uploads: APIAttachment[];
  /** Send as feedback: the message, or its ID when it has to be fetched. */
  target?: APIMessage;
  targetId?: string;
}

type RunInteraction = { token: string; guild_id?: string; member?: Member };

/** Count the run, acknowledge privately, and do the slow work in the background. */
async function startRun(
  interaction: RunInteraction,
  ctx: HandlerContext,
  params: RunParams
): Promise<HandlerResult> {
  const userId = interaction.member!.user.id;
  const guildId = interaction.guild_id ?? ctx.settings.guildId;
  await ctx.services.usage.record({
    guildId,
    userId,
    feature: USAGE_FEATURE,
    channelId: params.channel.id,
  });
  const editReply = (data: APIInteractionResponseCallbackData) =>
    ctx.discord.interactions.editReply(ctx.applicationId, interaction.token, {
      content: data.content ?? "",
      embeds: data.embeds ?? [],
      components: data.components ?? [],
      allowed_mentions: { parse: [] },
    });

  return {
    // Private "thinking…": if there's nothing to file, only the runner sees the hint.
    response: deferred({ ephemeral: true }),
    background: () =>
      runInBackground(
        ctx,
        ROUTE,
        "intake",
        { guildId, channelId: params.channel.id, app: params.app.name, mode: params.mode },
        () => intake(interaction.token, ctx, { ...params, guildId, userId }, editReply),
        async (error) =>
          void (await editReply(ephemeralMessage(describeFailure(error, params.app))))
      ),
  };
}

async function gather(ctx: HandlerContext, params: RunParams): Promise<Gathered | null> {
  const { channel } = params;
  const inThread = THREAD_CHANNEL_TYPES.has(channel.type);
  switch (params.mode) {
    case "prompt":
      return inThread ? threadMessages(ctx, channel) : { messages: [], starterId: null };
    case "thread":
      return threadMessages(ctx, channel);
    case "channel":
      return channelMessages(
        ctx,
        channel.id,
        await ctx.services.feedbackDrafts.lastCardMessageId(channel.id)
      );
    case "message": {
      const target = params.target ?? (await getMessageOrNull(ctx, channel.id, params.targetId!));
      return target ? messageAndReplies(ctx, target) : null;
    }
  }
}

async function intake(
  token: string,
  ctx: HandlerContext,
  params: RunParams & { guildId: string; userId: string },
  editReply: (data: APIInteractionResponseCallbackData) => Promise<unknown>
): Promise<void> {
  const { services } = ctx;
  const { app, mode } = params;

  const gathered = await gather(ctx, params);
  if (!gathered) {
    await editReply(ephemeralMessage("That message no longer exists."));
    return;
  }
  const kept = keepForTranscript(gathered);
  // In prompt mode the thread is background: its images aren't the feedback.
  const images = pickImages(params.uploads, mode === "prompt" ? [] : kept);
  if (!params.text && kept.length === 0 && images.length === 0) {
    await editReply(ephemeralMessage(NOTHING_FOUND));
    return;
  }

  const [downloads, strictness, publicRepo] = await Promise.all([
    Promise.allSettled(images.map((image) => services.screenshots.download(image.url))),
    services.github.strictness(app.repo),
    services.github.isPublic(app.repo),
  ]);
  const modelImages = downloads.flatMap((result, i): ExtractionImage[] => {
    if (result.status !== "fulfilled" || result.value.bytes.byteLength > MAX_MODEL_IMAGE_BYTES) {
      return [];
    }
    const message = images[i]!.message;
    return [
      {
        index: i + 1,
        mediaType: result.value.mediaType,
        data: Buffer.from(result.value.bytes).toString("base64"),
        label: message ? `in m${message}` : "attached to /feedback",
      },
    ];
  });

  const extracted = await services.extractFeedback({
    app: app.name,
    mode,
    runnerText: params.text,
    page: params.page,
    transcript: renderTranscript(kept, images),
    messageCount: kept.length,
    images: modelImages,
    imageCount: images.length,
  });
  const links = kept.map((message) => messageLink(params.guildId, message));
  const pending = buildItems(extracted, {
    messageLinks: links,
    strictness,
    productionUrl: app.productionUrl,
    environment: params.environment,
    page: params.page,
  });
  if (pending.length === 0) {
    await editReply(ephemeralMessage(NOTHING_FOUND));
    return;
  }

  const saved = await saveScreenshots(
    ctx,
    pending.flatMap((item) => item.screenshots),
    downloads
  );
  const items: FeedbackItem[] = pending.map((item) => ({
    ...item,
    screenshots: item.screenshots.flatMap((n) => (saved.has(n) ? [saved.get(n)!] : [])),
  }));

  const draft = await services.feedbackDrafts.create({
    guild_id: params.guildId,
    channel_id: params.channel.id,
    runner_discord_id: params.userId,
    app: app.name,
    mode,
    items,
    sources: mode === "prompt" ? [] : links,
    public_repo: publicRepo,
  });
  // The ephemeral reply has stopped "thinking" first, so the follow-up is a new public message.
  await editReply(CARD_POSTED);
  const card = await ctx.discord.interactions.followUp(
    ctx.applicationId,
    token,
    buildPreviewCard(draft, app)
  );
  await services.feedbackDrafts.setCardMessage(draft.id, card.id);
}

/** Copy the screenshots items use to Blob. A failed copy drops that screenshot and is reported. */
async function saveScreenshots(
  ctx: HandlerContext,
  used: number[],
  downloads: PromiseSettledResult<DownloadedImage>[]
): Promise<Map<number, string>> {
  const runId = randomUUID();
  const saved = new Map<number, string>();
  const failures: unknown[] = [];
  await Promise.all(
    [...new Set(used)].map(async (n) => {
      const download = downloads[n - 1];
      if (download?.status !== "fulfilled") return;
      try {
        const path = `feedback/${runId}/${n}.${IMAGE_TYPES[download.value.mediaType]}`;
        saved.set(n, await ctx.services.screenshots.save(path, download.value));
      } catch (error) {
        failures.push(error);
      }
    })
  );
  if (failures.length > 0) {
    const first = failures[0];
    await ctx.reportError(
      first,
      { route: ROUTE, step: "screenshots", failed: failures.length },
      (first as { severity?: Severity }).severity ?? "warning"
    );
  }
  return saved;
}

// ─── The card's controls ─────────────────────────────────────────────────────

type DraftLookup =
  { draft: FeedbackDraft; app: FeedbackApp; item: number | null } | { rejection: string };

/** Runner-only, pending, unexpired, for an app that still takes feedback. */
async function loadActionableDraft(
  ctx: HandlerContext,
  customId: string,
  userId: string
): Promise<DraftLookup> {
  const ref = parseDraftRef(customId.split(":").slice(2).join(":"));
  if (!ref) return { rejection: "Unknown action." };
  const draft = await ctx.services.feedbackDrafts.getById(ref.draftId);
  if (!draft) return { rejection: "This feedback card no longer exists." };
  if (draft.runner_discord_id !== userId) {
    return { rejection: `Only <@${draft.runner_discord_id}> can use this card.` };
  }
  if (draft.status === "creating") return { rejection: "The issues are being created." };
  if (draft.status !== "pending") return { rejection: "This feedback card is no longer active." };
  if (draft.expires_at.getTime() <= ctx.now()) {
    return { rejection: "This feedback card expired. Run `/feedback` again." };
  }
  const app = ctx.settings.feedbackApps[draft.app];
  if (!app) return { rejection: `${draft.app} no longer takes feedback from this server.` };
  if (ref.item !== null && !draft.items[ref.item]) return { rejection: "Unknown item." };
  return { draft, app, item: ref.item };
}

type Found = Extract<DraftLookup, { draft: FeedbackDraft }>;

function withDraft<I extends APIMessageComponentInteraction | APIModalSubmitInteraction>(
  handle: (
    interaction: I,
    ctx: HandlerContext,
    found: Found,
    userId: string
  ) => Promise<HandlerResult>
) {
  return async (interaction: I, ctx: HandlerContext): Promise<HandlerResult> => {
    const userId = interaction.member!.user.id;
    const lookup = await loadActionableDraft(ctx, interaction.data.custom_id, userId);
    if ("rejection" in lookup) return { response: ephemeral(lookup.rejection) };
    return handle(interaction, ctx, lookup, userId);
  };
}

/** Save new items and redraw the card (the interaction came from it). */
async function saveItems(
  ctx: HandlerContext,
  found: Found,
  items: FeedbackItem[]
): Promise<HandlerResult> {
  const updated = await ctx.services.feedbackDrafts.updateItems(found.draft.id, items);
  if (!updated) return { response: ephemeral("This feedback card is no longer active.") };
  return { response: updateMessage(buildPreviewCard(updated, found.app)) };
}

const selectValues = (interaction: APIMessageComponentInteraction) =>
  interaction.data.component_type === ComponentType.StringSelect ? interaction.data.values : [];

/** "Leave items out": the selection is the set of items not to file. */
export const handleDrop = withDraft<APIMessageComponentInteraction>(
  async (interaction, ctx, found) => {
    const dropped = new Set(selectValues(interaction));
    return saveItems(
      ctx,
      found,
      found.draft.items.map((item, i) =>
        item.issue ? item : { ...item, dropped: dropped.has(String(i)) }
      )
    );
  }
);

export const handleEnvironment = withDraft<APIMessageComponentInteraction>(
  async (interaction, ctx, found) => {
    const environment = asEnvironment(selectValues(interaction)[0]);
    if (!environment) return { response: ephemeral("Unknown environment.") };
    return saveItems(
      ctx,
      found,
      found.draft.items.map((item) => (item.issue ? item : { ...item, environment }))
    );
  }
);

export const handleEdit = withDraft<APIMessageComponentInteraction>(
  async (_interaction, _ctx, found) => {
    const index = found.item;
    const item = index === null ? undefined : found.draft.items[index];
    if (index === null || !item) return { response: ephemeral("Unknown item.") };
    if (item.issue)
      return {
        response: ephemeral(`Item ${index + 1} is already filed as #${item.issue.number}.`),
      };
    return { response: buildItemModal(found.draft.id, index, item) };
  }
);

export const handleItemSubmit = withDraft<APIModalSubmitInteraction>(
  async (interaction, ctx, found) => {
    const index = found.item;
    const item = index === null ? undefined : found.draft.items[index];
    if (index === null || !item || item.issue) return { response: ephemeral("Unknown item.") };
    const input = readModal(interaction.data);
    const type = input.selects.type?.[0];
    const title = input.text.title?.trim();
    const restatement = input.text.restatement?.trim();
    if (!title || !restatement) return { response: ephemeral("Title and summary can't be empty.") };
    const edited: FeedbackItem = {
      ...item,
      title,
      restatement,
      type: FEEDBACK_TYPES.includes(type as FeedbackType) ? (type as FeedbackType) : item.type,
      page: input.text.page?.trim() || null,
      environment: asEnvironment(input.selects.environment?.[0]) ?? item.environment,
    };
    return saveItems(
      ctx,
      found,
      found.draft.items.map((it, i) => (i === index ? edited : it))
    );
  }
);

export const handleCancel = withDraft<APIMessageComponentInteraction>(
  async (_interaction, ctx, found, userId) => {
    const cancelled = await ctx.services.feedbackDrafts.cancel(found.draft.id);
    if (!cancelled) return { response: ephemeral("This feedback card is no longer active.") };
    return { response: updateMessage(buildCancelledCard(cancelled, userId)) };
  }
);

/** File one issue per kept item, then turn the card into "Created #12, #13". */
export const handleCreate = withDraft<APIMessageComponentInteraction>(
  async (interaction, ctx, found, userId) => {
    const blocker = createBlocker(found.draft.items);
    if (blocker) return { response: ephemeral(blocker) };
    // Atomic pending → creating: a double click loses here and can't file twice.
    const claimed = await ctx.services.feedbackDrafts.claimForCreating(found.draft.id);
    if (!claimed) return { response: ephemeral("These issues are already being created.") };

    const { app } = found;
    const drafts = ctx.services.feedbackDrafts;
    const submitter = { id: userId, name: displayName(interaction.member!) };
    const editCard = (data: APIInteractionResponseCallbackData) =>
      ctx.discord.interactions.editReply(ctx.applicationId, interaction.token, data);
    const followUp = (content: string) =>
      ctx.discord.interactions.followUp(
        ctx.applicationId,
        interaction.token,
        ephemeralMessage(content)
      );

    return {
      response: deferredUpdate(),
      background: () =>
        runInBackground(
          ctx,
          ROUTE,
          "create",
          { draftId: claimed.id, app: app.name },
          async () => {
            let current = claimed;
            const failed: { index: number; error: unknown }[] = [];
            for (const { item, index } of toFile(current.items)) {
              try {
                const issue = await ctx.services.github.createIssue(
                  app.repo,
                  buildIssue(item, current, app, submitter)
                );
                // Stored straight away, so a retry after a later failure skips this one.
                await drafts.setItemIssue(current.id, index, issue);
                current = {
                  ...current,
                  items: current.items.map((it, i) => (i === index ? { ...it, issue } : it)),
                };
              } catch (error) {
                failed.push({ index, error });
              }
            }

            if (failed.length === 0) {
              await editCard(
                buildCreatedCard((await drafts.markCreated(current.id)) ?? current, app)
              );
              return;
            }
            const released = (await drafts.releaseClaim(current.id)) ?? current;
            await editCard(buildPreviewCard(released, app));
            const numbers = failed.map(({ index }) => index + 1).join(", ");
            await followUp(
              `Couldn't create the issue for item${failed.length > 1 ? "s" : ""} ${numbers}. Press **Create** again to retry; filed items won't be filed twice. The error has been logged for the dev team.`
            );
            const error = failed[0]!.error;
            await ctx.reportError(
              error,
              { route: ROUTE, step: "create", draftId: current.id, failed: failed.length },
              (error as { severity?: Severity }).severity ?? "error"
            );
          },
          async () => {
            await drafts.releaseClaim(claimed.id);
            await followUp(
              "Couldn't create the issues. The error has been logged for the dev team."
            );
          }
        ),
    };
  }
);

export async function routeMessageModal(
  interaction: APIModalSubmitInteraction,
  ctx: HandlerContext
): Promise<HandlerResult> {
  const messageId = interaction.data.custom_id.split(":")[2] ?? "";
  return handleMessageSubmit(interaction, ctx, messageId);
}
