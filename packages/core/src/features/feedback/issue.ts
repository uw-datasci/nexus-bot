import type { NewIssue } from "../../github-app";
import type { FeedbackApp } from "../../settings";
import type { FeedbackDraft, FeedbackItem } from "./types";

/**
 * The GitHub issue for one feedback item. The repo may be public, and the text was written by
 * people in Discord, so it's made inert: no GitHub @-mentions, and nothing that could pass for
 * the hidden block the workflows read.
 */

export const MARKER = "nexus-feedback";

const ENVIRONMENT_LABELS = {
  prod: "Production",
  staging: "Staging (on `dev`, not in production yet)",
} as const;

/** Text from Discord, made safe to put in an issue body. */
export function neutralize(text: string): string {
  return (
    text
      // `@name` would notify a GitHub user (or team); a zero-width space breaks the mention.
      .replaceAll(/@(?=[\w-])/g, "@​")
      // Users can't write HTML comments, so they can't fake the hidden block.
      .replaceAll("<!--", "&lt;!--")
      .replaceAll("-->", "--&gt;")
  );
}

/** Discord text as a Markdown quote, made inert. */
export const quote = (text: string) =>
  neutralize(text)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

/** Lets the feedback workflows post back to Discord without database access. */
export function hiddenBlock(
  draft: Pick<FeedbackDraft, "guild_id" | "channel_id" | "message_id">,
  userId: string
) {
  const data = {
    guild: draft.guild_id,
    channel: draft.channel_id,
    message: draft.message_id,
    user: userId,
  };
  return `<!-- ${MARKER} ${JSON.stringify(data)} -->`;
}

export function issueLabels(item: FeedbackItem): string[] {
  return [
    "feedback",
    `feedback:${item.type}`,
    ...(item.environment ? [`env:${item.environment}`] : []),
  ];
}

export function buildIssue(
  item: FeedbackItem,
  draft: FeedbackDraft,
  app: FeedbackApp,
  submitter: { id: string; name: string }
): NewIssue {
  const cardLink = draft.message_id
    ? `https://discord.com/channels/${draft.guild_id}/${draft.channel_id}/${draft.message_id}`
    : null;
  const environment = item.environment
    ? item.environment === "prod"
      ? `${ENVIRONMENT_LABELS.prod} (${app.productionUrl.replace(/^https:\/\//, "")})`
      : ENVIRONMENT_LABELS.staging
    : "Not set";

  const sections = [
    quote(item.verbatim),
    `**Summary:** ${neutralize(item.restatement)}`,
    `**Page:** ${item.page ? neutralize(item.page) : "Not given"}`,
    `**Environment:** ${environment}`,
  ];
  if (item.screenshots.length > 0) {
    sections.push(
      `**Screenshots**\n\n${item.screenshots.map((url, i) => `![screenshot ${i + 1}](${url})`).join("\n")}`
    );
  }
  const discord = [
    ...item.sources.map((link, i) => `[message ${i + 1}](${link})`),
    ...(cardLink ? [`[feedback card](${cardLink})`] : []),
  ];
  if (discord.length > 0) sections.push(`**From Discord:** ${discord.join(" · ")}`);
  sections.push(`Submitted by **${neutralize(submitter.name)}** in Discord with \`/feedback\`.`);
  sections.push(hiddenBlock(draft, submitter.id));

  return {
    title: neutralize(item.title).slice(0, 256),
    body: sections.join("\n\n"),
    labels: issueLabels(item),
  };
}
