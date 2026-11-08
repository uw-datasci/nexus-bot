import {
  ComponentType,
  InteractionResponseType,
  TextInputStyle,
  deferred,
  deferredUpdate,
  type APIActionRowComponent,
  type APIComponentInMessageActionRow,
  type APIInteractionResponse,
  type APIMessageComponentInteraction,
  type APIModalSubmitInteraction,
} from "@nexus-bot/discord";
import type { FeedbackApp } from "../../settings";
import type { HandlerContext, HandlerResult } from "../../types";
import { readModal, runInBackground, type InteractionChannel } from "../shared/discord";
import { appsFor } from "./access";
import { customId, ephemeral, ephemeralMessage } from "./cards";
import { displayName } from "./handlers";
import { neutralize, quote } from "./issue";

/**
 * The buttons on the feedback workflows' Discord updates (nexus-workflows feedback-notify.yml),
 * as the organizers' way back into GitHub. Their custom_ids are a contract with that workflow:
 *
 *   fb:good:<owner/repo>:<pr>:<issue>    Looks good        a PR comment
 *   fb:again:<owner/repo>:<pr>:<issue>   Still not right   @claude or the dev on an open PR;
 *                                                          after merge, reopen + `retriage`
 *   fb:answer:<owner/repo>:<issue>       Answer            an issue comment + `retriage`
 *
 * Anyone allowed to send feedback for the repo's app (its `feedback_apps` role sets) may use them.
 */

/** Still not right and Answer each start a paid agent run, so they have their own limit. */
export const REPLIES_PER_USER = 10;
export const REPLY_WINDOW_S = 60 * 60;
export const REPLY_FEATURE = "feedback-reply";
/** Triage runs again when it's added (nexus-workflows removes it). */
export const RETRIAGE_LABEL = "retriage";
/** Ends every comment the bot posts for someone in Discord. */
export const DISCORD_MARKER = "<!-- nexus-feedback-discord -->";

const ROUTE = "discord:feedback";
const REPO = /^[\w.-]+\/[\w.-]+$/;
const NUMBER = /^[1-9]\d{0,9}$/;

export interface UpdateRef {
  repo: string;
  pr: number | null;
  issue: number;
}

/** `<owner/repo>:<pr>:<issue>` (or `<owner/repo>:<issue>` without a PR), or null. */
export function parseUpdateRef(id: string, withPr: boolean): UpdateRef | null {
  const parts = id.split(":");
  if (parts.length !== (withPr ? 3 : 2)) return null;
  const [repo = "", ...numbers] = parts;
  if (!REPO.test(repo) || !numbers.every((n) => NUMBER.test(n))) return null;
  return withPr
    ? { repo, pr: Number(numbers[0]), issue: Number(numbers[1]) }
    : { repo, pr: null, issue: Number(numbers[0]) };
}

type Interaction = APIMessageComponentInteraction | APIModalSubmitInteraction;
type Found = { ref: UpdateRef; app: FeedbackApp; userId: string; name: string };

/** The ref in the custom_id, and whether this member may act for its app here. */
function lookup(interaction: Interaction, ctx: HandlerContext, withPr: boolean): Found | string {
  const ref = parseUpdateRef(interaction.data.custom_id.split(":").slice(2).join(":"), withPr);
  if (!ref) return "Unknown action.";
  const app = Object.values(ctx.settings.feedbackApps).find(
    (a) => a.repo.toLowerCase() === ref.repo.toLowerCase()
  );
  if (!app) return `${ref.repo} doesn't take feedback from this server.`;
  const member = interaction.member!;
  const channel = interaction.channel as InteractionChannel | undefined;
  if (appsFor(member.roles, channel, { feedbackApps: { [app.name]: app } }).length === 0) {
    return `Only people who can send feedback for ${app.name} can use this.`;
  }
  return { ref, app, userId: member.user.id, name: displayName(member) };
}

async function replyLimit(ctx: HandlerContext, userId: string, channelId: string) {
  const { byUser } = await ctx.services.usage.recentRuns({
    feature: REPLY_FEATURE,
    userId,
    channelId,
    userWindowSeconds: REPLY_WINDOW_S,
    channelWindowSeconds: 0,
  });
  return byUser >= REPLIES_PER_USER
    ? `You've sent ${REPLIES_PER_USER} replies in the last hour. Try again later.`
    : null;
}

const channelId = (interaction: Interaction) =>
  interaction.channel?.id ?? interaction.channel_id ?? "";

function textModal(
  id: string,
  title: string,
  label: string,
  placeholder: string
): APIInteractionResponse {
  return {
    type: InteractionResponseType.Modal,
    data: {
      custom_id: id,
      title,
      components: [
        {
          type: ComponentType.Label,
          label,
          description:
            "It's posted on GitHub with your name, where the developers (and Claude) see it.",
          component: {
            type: ComponentType.TextInput,
            custom_id: "text",
            style: TextInputStyle.Paragraph,
            required: true,
            max_length: 2000,
            placeholder,
          },
        },
      ],
    },
  };
}

/**
 * Acknowledge privately, then do the GitHub work and say what happened. Failures are reported
 * and shown as a short ephemeral message.
 */
function privately(
  interaction: Interaction,
  ctx: HandlerContext,
  step: string,
  found: Found,
  work: () => Promise<string>
): HandlerResult {
  const edit = (content: string) =>
    ctx.discord.interactions.editReply(ctx.applicationId, interaction.token, {
      content,
      allowed_mentions: { parse: [] },
    });
  return {
    response: deferred({ ephemeral: true }),
    background: () =>
      runInBackground(
        ctx,
        ROUTE,
        step,
        { repo: found.ref.repo, issue: found.ref.issue, pr: found.ref.pr },
        async () => void (await edit(await work())),
        async () =>
          void (await edit(
            `Couldn't reach GitHub for ${found.ref.repo}. The error has been logged for the dev team.`
          ))
      ),
  };
}

// ─── Looks good ──────────────────────────────────────────────────────────────

type Row = APIActionRowComponent<APIComponentInMessageActionRow>;

/** The update without its Looks good / Still not right buttons (the preview link stays). */
function withoutReplyButtons(rows: Row[] = []): Row[] {
  return rows
    .map((row) => ({
      ...row,
      components: row.components.filter(
        (c) =>
          !(
            c.type === ComponentType.Button &&
            "custom_id" in c &&
            /^fb:(good|again):/.test(c.custom_id)
          )
      ),
    }))
    .filter((row) => row.components.length > 0);
}

export async function handleLooksGood(
  interaction: APIMessageComponentInteraction,
  ctx: HandlerContext
): Promise<HandlerResult> {
  const found = lookup(interaction, ctx, true);
  if (typeof found === "string") return { response: ephemeral(found) };
  const { ref, name } = found;
  const message = interaction.message;

  return {
    response: deferredUpdate(),
    background: () =>
      runInBackground(
        ctx,
        ROUTE,
        "looks-good",
        { repo: ref.repo, pr: ref.pr },
        async () => {
          await ctx.services.github.comment(
            ref.repo,
            ref.pr!,
            `👍 **Looks good** to **${neutralize(name)}**, who checked the preview from Discord.\n\n${DISCORD_MARKER}`
          );
          await ctx.discord.interactions.editReply(ctx.applicationId, interaction.token, {
            content: `${message.content}\n👍 <@${found.userId}> says it looks good.`,
            components: withoutReplyButtons(message.components as Row[] | undefined),
            allowed_mentions: { parse: [] },
          });
        },
        async () => {
          await ctx.discord.interactions.followUp(
            ctx.applicationId,
            interaction.token,
            ephemeralMessage(
              `Couldn't reach GitHub for ${ref.repo}. The error has been logged for the dev team.`
            )
          );
        }
      ),
  };
}

// ─── Still not right ─────────────────────────────────────────────────────────

export async function handleStillNotRight(
  interaction: APIMessageComponentInteraction,
  ctx: HandlerContext
): Promise<HandlerResult> {
  const found = lookup(interaction, ctx, true);
  if (typeof found === "string") return { response: ephemeral(found) };
  const limited = await replyLimit(ctx, found.userId, channelId(interaction));
  if (limited) return { response: ephemeral(limited) };
  const { ref } = found;
  return {
    response: textModal(
      customId("againtext", `${ref.repo}:${ref.pr}:${ref.issue}`),
      "Still not right",
      "What's still not right?",
      "e.g. The button is still white on mobile"
    ),
  };
}

export async function handleStillNotRightSubmit(
  interaction: APIModalSubmitInteraction,
  ctx: HandlerContext
): Promise<HandlerResult> {
  const found = lookup(interaction, ctx, true);
  if (typeof found === "string") return { response: ephemeral(found) };
  const limited = await replyLimit(ctx, found.userId, channelId(interaction));
  if (limited) return { response: ephemeral(limited) };
  const text = readModal(interaction.data).text.text?.trim();
  if (!text) return { response: ephemeral("Say what's still not right.") };
  await ctx.services.usage.record({
    guildId: interaction.guild_id ?? ctx.settings.guildId,
    userId: found.userId,
    feature: REPLY_FEATURE,
    channelId: channelId(interaction),
  });

  const { ref, name } = found;
  const github = ctx.services.github;
  const from = `From **${neutralize(name)}** in Discord.\n\n${DISCORD_MARKER}`;

  return privately(interaction, ctx, "still-not-right", found, async () => {
    const [pull, issue] = await Promise.all([
      github.getPull(ref.repo, ref.pr!),
      github.getIssue(ref.repo, ref.issue),
    ]);

    if (pull.state === "open") {
      const intro = "An organizer checked the preview and says it's still not right:";
      if (issue.labels.includes("route:agent")) {
        // The @claude mention workflow picks this up and pushes a change to the PR.
        await github.comment(
          ref.repo,
          pull.number,
          `@claude ${intro}\n\n${quote(text)}\n\n${from}`
        );
        return `Sent to Claude on #${pull.number}. A new preview will show up here when it's ready.`;
      }
      const devs = issue.assignees.length
        ? issue.assignees
        : pull.author && !pull.authorIsBot
          ? [pull.author]
          : [];
      const mentions = devs.map((login) => `@${login} `).join("");
      await github.comment(
        ref.repo,
        pull.number,
        `${mentions}${intro}\n\n${quote(text)}\n\n${from}`
      );
      return devs.length
        ? `Sent to ${devs.join(", ")} on #${pull.number}.`
        : `Posted on #${pull.number} for the developers.`;
    }

    // Merged (or closed): the issue goes back to triage with the new information.
    await github.comment(
      ref.repo,
      ref.issue,
      `**Still not right** after #${pull.number}${pull.merged ? " was merged" : ""}:\n\n${quote(text)}\n\n${from}`
    );
    if (issue.state === "closed") await github.reopenIssue(ref.repo, ref.issue);
    await github.addLabels(ref.repo, ref.issue, [RETRIAGE_LABEL]);
    return issue.state === "closed"
      ? `Reopened #${ref.issue}. Triage will look at it again.`
      : `Triage will look at #${ref.issue} again.`;
  });
}

// ─── Answer ──────────────────────────────────────────────────────────────────

export async function handleAnswer(
  interaction: APIMessageComponentInteraction,
  ctx: HandlerContext
): Promise<HandlerResult> {
  const found = lookup(interaction, ctx, false);
  if (typeof found === "string") return { response: ephemeral(found) };
  const limited = await replyLimit(ctx, found.userId, channelId(interaction));
  if (limited) return { response: ephemeral(limited) };
  return {
    response: textModal(
      customId("answertext", `${found.ref.repo}:${found.ref.issue}`),
      `Answer #${found.ref.issue}`,
      "Your answer",
      "The more specific, the better: the page, what you expected, what happened"
    ),
  };
}

export async function handleAnswerSubmit(
  interaction: APIModalSubmitInteraction,
  ctx: HandlerContext
): Promise<HandlerResult> {
  const found = lookup(interaction, ctx, false);
  if (typeof found === "string") return { response: ephemeral(found) };
  const limited = await replyLimit(ctx, found.userId, channelId(interaction));
  if (limited) return { response: ephemeral(limited) };
  const text = readModal(interaction.data).text.text?.trim();
  if (!text) return { response: ephemeral("The answer can't be empty.") };
  await ctx.services.usage.record({
    guildId: interaction.guild_id ?? ctx.settings.guildId,
    userId: found.userId,
    feature: REPLY_FEATURE,
    channelId: channelId(interaction),
  });

  const { ref, name } = found;
  const github = ctx.services.github;
  return privately(interaction, ctx, "answer", found, async () => {
    const issue = await github.getIssue(ref.repo, ref.issue);
    if (issue.state === "closed") return `#${ref.issue} is closed, so there's nothing to answer.`;
    await github.comment(
      ref.repo,
      ref.issue,
      `**Answer from ${neutralize(name)}** in Discord:\n\n${quote(text)}\n\n${DISCORD_MARKER}`
    );
    await github.addLabels(ref.repo, ref.issue, [RETRIAGE_LABEL]);
    return `Thanks. Your answer is on #${ref.issue}, and triage will look at it again.`;
  });
}
