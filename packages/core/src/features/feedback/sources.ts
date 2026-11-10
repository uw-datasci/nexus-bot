import type { APIAttachment, APIMessage } from "@nexus-bot/discord";
import { DateTime } from "luxon";
import { isImageType } from "../../screenshots";
import type { HandlerContext } from "../../types";
import { getStarterMessage, type InteractionChannel } from "../shared/discord";
import { TIMEZONE, sanitizeContent, sanitizeName } from "../shared/sanitize";
import type { EntryMode } from "./types";

/** Channel mode: messages since the last feedback card, but no further back than this. */
export const CHANNEL_WINDOW_MS = 30 * 60 * 1000;
export const CHANNEL_MAX_MESSAGES = 25;
/** The modal's File Upload allows 10; the same cap covers screenshots found in messages. */
export const MAX_IMAGES = 10;

const MAX_MESSAGE_CHARS = 1_500;
const MAX_TRANSCRIPT_CHARS = 24_000;

export const messageLink = (guildId: string, message: Pick<APIMessage, "id" | "channel_id">) =>
  `https://discord.com/channels/${guildId}/${message.channel_id}/${message.id}`;

/** Newest first, as Discord returns them, is not what a transcript wants. */
const chronological = (messages: APIMessage[]) =>
  [...messages].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));

/** People's messages only: never the bot's own cards, nor other bots. */
const fromPeople = (messages: APIMessage[]) => messages.filter((m) => !m.author.bot);

const unique = (messages: APIMessage[]) => [...new Map(messages.map((m) => [m.id, m])).values()];

/** The messages a run reads, chronological, and which one is the thread's starter. */
export interface Gathered {
  messages: APIMessage[];
  starterId: string | null;
}

export async function threadMessages(
  ctx: HandlerContext,
  thread: InteractionChannel
): Promise<Gathered> {
  const [messages, starter] = await Promise.all([
    ctx.discord.channels.getMessages(thread.id, { limit: 100 }),
    getStarterMessage(ctx, thread.id, thread.parent_id ?? null),
  ]);
  return {
    messages: chronological(fromPeople(unique(starter ? [...messages, starter] : messages))),
    starterId: starter?.id ?? null,
  };
}

/** Recent messages in a channel: after the bot's last feedback card, within 30 minutes, max 25. */
export async function channelMessages(
  ctx: HandlerContext,
  channelId: string,
  lastCardId: string | null
): Promise<Gathered> {
  const recent = await ctx.discord.channels.getMessages(channelId, {
    limit: CHANNEL_MAX_MESSAGES,
  });
  const since = ctx.now() - CHANNEL_WINDOW_MS;
  const messages = recent.filter(
    (m) => (!lastCardId || BigInt(m.id) > BigInt(lastCardId)) && Date.parse(m.timestamp) >= since
  );
  return { messages: chronological(fromPeople(messages)), starterId: null };
}

/** One message (it comes first), the replies to it, and its thread if it started one. */
export async function messageAndReplies(
  ctx: HandlerContext,
  target: APIMessage
): Promise<Gathered> {
  const [after, thread] = await Promise.all([
    ctx.discord.channels.getMessages(target.channel_id, { after: target.id, limit: 100 }),
    target.thread
      ? ctx.discord.channels.getMessages(target.thread.id, { limit: 100 })
      : Promise.resolve([]),
  ]);
  const replies = after.filter((m) => m.message_reference?.message_id === target.id);
  const rest = chronological(fromPeople(unique([...replies, ...thread]))).filter(
    (m) => m.id !== target.id
  );
  return { messages: [target, ...rest], starterId: target.id };
}

// ─── Images ──────────────────────────────────────────────────────────────────

export interface ImageRef {
  url: string;
  size: number;
  /** 1-based transcript number of the message it's on; null when uploaded to /feedback. */
  message: number | null;
}

const isImage = (a: APIAttachment) => isImageType(a.content_type);

/**
 * The images a run looks at, numbered from 1: uploads first, then images on the transcript's
 * messages, newest first, up to MAX_IMAGES in all.
 */
export function pickImages(uploads: APIAttachment[], kept: APIMessage[]): ImageRef[] {
  const picked: ImageRef[] = uploads
    .filter(isImage)
    .map((a) => ({ url: a.url, size: a.size, message: null }));
  for (let i = kept.length - 1; i >= 0 && picked.length < MAX_IMAGES; i--) {
    for (const attachment of kept[i]!.attachments ?? []) {
      if (picked.length >= MAX_IMAGES) break;
      if (isImage(attachment))
        picked.push({ url: attachment.url, size: attachment.size, message: i + 1 });
    }
  }
  return picked.slice(0, MAX_IMAGES);
}

// ─── Transcript ──────────────────────────────────────────────────────────────

function line(message: APIMessage, number: number, imageNumbers: number[]): string | null {
  const content = sanitizeContent(message.content ?? "");
  const images = imageNumbers.map((n) => ` [image ${n}]`).join("");
  if (!content && !images) return null;
  const author = sanitizeName(message.author.global_name ?? message.author.username);
  const at = DateTime.fromISO(message.timestamp, { zone: TIMEZONE }).toFormat(
    "yyyy-MM-dd HH:mm cccc"
  );
  const body =
    content.length > MAX_MESSAGE_CHARS ? `${content.slice(0, MAX_MESSAGE_CHARS)}…` : content;
  return `[m${number}] [${at}] ${author}: ${body || "(no text)"}${images}`;
}

/**
 * The messages the transcript shows, in order: the returned list's i-th message is [m(i+1)]. Caps
 * the transcript at MAX_TRANSCRIPT_CHARS. The starter message (the
 * thread's pitch, or the right-clicked message) is always kept; the rest are kept newest first,
 * so the latest feedback survives a long thread. Messages with no text or image are skipped.
 */
export function keepForTranscript(gathered: Gathered): APIMessage[] {
  const withContent = gathered.messages.filter(
    (m) => sanitizeContent(m.content ?? "") || (m.attachments ?? []).some(isImage)
  );
  const starter = withContent.find((m) => m.id === gathered.starterId) ?? null;
  // Draft lines without numbers, to measure them.
  const length = (m: APIMessage) => (line(m, 99, []) ?? "").length + 1;

  let budget = MAX_TRANSCRIPT_CHARS - (starter ? length(starter) : 0);
  const keep = new Set<string>(starter ? [starter.id] : []);
  for (const message of [...withContent].reverse()) {
    if (message === starter) continue;
    const size = length(message);
    if (size > budget) continue;
    budget -= size;
    keep.add(message.id);
  }
  return withContent.filter((m) => keep.has(m.id));
}

/** The transcript's text: `[mN] [time] name: text [image K]`, once the images are numbered. */
export function renderTranscript(kept: APIMessage[], images: ImageRef[]): string {
  return kept
    .map((message, i) => {
      const numbers = images.flatMap((img, n) => (img.message === i + 1 ? [n + 1] : []));
      return line(message, i + 1, numbers);
    })
    .filter(Boolean)
    .join("\n");
}

/** What each mode reads, for logs and the card's "from …" line. */
export const MODE_LABELS: Record<EntryMode, string> = {
  prompt: "your /feedback text",
  thread: "this thread",
  channel: "recent messages here",
  message: "this message and its replies",
};
