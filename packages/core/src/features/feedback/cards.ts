import {
  ButtonStyle,
  ComponentType,
  InteractionResponseType,
  MessageFlags,
  TextInputStyle,
  formatCustomId,
  type APIActionRowComponent,
  type APIComponentInMessageActionRow,
  type APIEmbed,
  type APIInteractionResponse,
  type APIInteractionResponseCallbackData,
  type APILabelComponent,
  type APISelectMenuOption,
} from "@nexus-bot/discord";
import type { FeedbackApp } from "../../settings";
import { createBlocker, toFile } from "./items";
import { MODE_LABELS } from "./sources";
import type { Environment, FeedbackDraft, FeedbackItem, FeedbackType } from "./types";

export const FEATURE = "fb";
export const COMMAND_NAME = "feedback";
export const MESSAGE_COMMAND_NAME = "Send as feedback";

type MessagePayload = APIInteractionResponseCallbackData;
type ActionRow = APIActionRowComponent<APIComponentInMessageActionRow>;

const NO_PINGS = { parse: [] };
const COLORS = { pending: 0x5865f2, dropped: 0x99aab5, created: 0x57f287, failed: 0xed4245 };
/** Discord's limit is 6000 characters across a message's embeds; leave room for the footer. */
const EMBED_BUDGET = 5_600;

export const TYPE_LABELS: Record<FeedbackType, string> = {
  bug: "🐛 Bug",
  change: "✨ Change",
  nit: "🔧 Nit",
};
export const ENVIRONMENT_OPTIONS: Record<Environment, { label: string; description: string }> = {
  prod: { label: "Production", description: "Seen on the live site" },
  staging: { label: "Staging", description: "Shown from dev, not in production yet" },
};

export const customId = (action: string, id = "") => formatCustomId(FEATURE, action, id);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `fb:<action>:<draftId>[:<item>]` → the draft ID and item number, or null. */
export function parseDraftRef(id: string): { draftId: string; item: number | null } | null {
  const [draftId = "", item] = id.split(":");
  if (!UUID_RE.test(draftId)) return null;
  if (item === undefined) return { draftId, item: null };
  const n = Number(item);
  return Number.isInteger(n) && n >= 0 ? { draftId, item: n } : null;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

const unix = (date: Date) => Math.floor(date.getTime() / 1000);

// ─── Cards ───────────────────────────────────────────────────────────────────

function itemEmbed(item: FeedbackItem, index: number, budget: number): APIEmbed {
  const state = item.issue ? `✅ #${item.issue.number}` : item.dropped ? "Left out" : null;
  const title = truncate(`${index + 1}. ${item.title}`, 100);
  const meta = [
    TYPE_LABELS[item.type],
    item.page ? `📄 ${truncate(item.page, 80)}` : null,
    item.environment
      ? `🌐 ${ENVIRONMENT_OPTIONS[item.environment].label}`
      : "🌐 ⚠️ pick an environment",
    item.screenshots.length ? `🖼️ ${item.screenshots.length}` : null,
    state,
  ]
    .filter(Boolean)
    .join(" · ");
  // What's left of the budget goes to the summary and the quote, half each at most.
  const room = Math.max(60, budget - title.length - meta.length - 10);
  const restatement = truncate(item.restatement, Math.floor(room / 2));
  const quoted = truncate(item.verbatim.replaceAll(/\s*\n\s*/g, " "), room - restatement.length);
  return {
    title: item.dropped && !item.issue ? `~~${title}~~` : title,
    ...(item.issue ? { url: item.issue.url } : {}),
    description: `${restatement}\n> ${quoted}\n${meta}`,
    color: item.issue ? COLORS.created : item.dropped ? COLORS.dropped : COLORS.pending,
  };
}

function itemEmbeds(items: FeedbackItem[]): APIEmbed[] {
  const budget = Math.min(1_500, Math.floor(EMBED_BUDGET / Math.max(1, items.length)));
  return items.map((item, index) => itemEmbed(item, index, budget));
}

function sourcesLine(draft: FeedbackDraft): string {
  if (draft.sources.length === 0) return `From ${MODE_LABELS[draft.mode]}.`;
  const shown = draft.sources.slice(0, 5).map((link, i) => `[${i + 1}](${link})`);
  const more = draft.sources.length > 5 ? ` +${draft.sources.length - 5} more` : "";
  const count = `${draft.sources.length} message${draft.sources.length === 1 ? "" : "s"}`;
  return `From ${MODE_LABELS[draft.mode]} (${count}: ${shown.join(" ")}${more}).`;
}

const options = (items: FeedbackItem[], selected: (item: FeedbackItem) => boolean) =>
  toSelectable(items).map(({ item, index }): APISelectMenuOption => ({
    label: truncate(`${index + 1}. ${item.title}`, 100),
    value: String(index),
    default: selected(item),
  }));

/** Items the controls can still change: not filed yet. */
const toSelectable = (items: FeedbackItem[]) =>
  items.flatMap((item, index) => (item.issue ? [] : [{ item, index }]));

/** The public preview card, while a draft is pending. */
export function buildPreviewCard(draft: FeedbackDraft, app: FeedbackApp): MessagePayload {
  const selectable = toSelectable(draft.items);
  const kept = toFile(draft.items);
  const environments = new Set(kept.map(({ item }) => item.environment));
  const sharedEnvironment = environments.size === 1 ? [...environments][0] : null;
  const filed = draft.items.filter((item) => item.issue);

  const components: ActionRow[] = [];
  if (selectable.length > 0) {
    components.push({
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.StringSelect,
          custom_id: customId("drop", draft.id),
          placeholder: "Leave items out (selected ones aren't filed)",
          min_values: 0,
          max_values: selectable.length,
          options: options(draft.items, (item) => item.dropped),
        },
      ],
    });
    components.push({
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.StringSelect,
          custom_id: customId("env", draft.id),
          placeholder: "Environment for every item",
          options: (Object.keys(ENVIRONMENT_OPTIONS) as Environment[]).map((value) => ({
            ...ENVIRONMENT_OPTIONS[value],
            value,
            default: value === sharedEnvironment,
          })),
        },
      ],
    });
    // Buttons, not a select: a dismissed modal would leave a select stuck on its choice.
    for (let i = 0; i < selectable.length; i += 5) {
      components.push({
        type: ComponentType.ActionRow,
        components: selectable.slice(i, i + 5).map(({ index }) => ({
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          label: `Edit ${index + 1}`,
          custom_id: customId("edit", `${draft.id}:${index}`),
        })),
      });
    }
  }
  components.push({
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: ButtonStyle.Success,
        label: kept.length === 1 ? "Create issue" : `Create ${kept.length} issues`,
        custom_id: customId("create", draft.id),
        disabled: createBlocker(draft.items) !== null,
      },
      {
        type: ComponentType.Button,
        style: ButtonStyle.Danger,
        label: "Cancel",
        custom_id: customId("cancel", draft.id),
      },
    ],
  });

  const lines = [
    `📝 **Feedback for ${app.name}** from <@${draft.runner_discord_id}>. ${sourcesLine(draft)}`,
    "Leave out what shouldn't be filed, pick an environment, then **Create**.",
  ];
  if (filed.length > 0) {
    lines.push(
      `Already filed: ${filed.map((i) => `[#${i.issue!.number}](${i.issue!.url})`).join(", ")}.`
    );
  }
  if (draft.public_repo) {
    lines.push(
      `⚠️ **${app.repo} is public**: these issues, quotes and screenshots will be visible to anyone.`
    );
  }
  lines.push(`Expires <t:${unix(draft.expires_at)}:R>.`);

  return {
    content: lines.join("\n"),
    embeds: itemEmbeds(draft.items).map((embed, i, all) =>
      i === all.length - 1
        ? {
            ...embed,
            footer: { text: "Only the person who ran /feedback can use these controls." },
          }
        : embed
    ),
    components,
    allowed_mentions: NO_PINGS,
  };
}

/** After Create: what was filed, with links, and no controls. */
export function buildCreatedCard(draft: FeedbackDraft, app: FeedbackApp): MessagePayload {
  const filed = draft.items.filter((item) => item.issue);
  const links = filed.map((item) => `[#${item.issue!.number}](${item.issue!.url})`).join(", ");
  return {
    content: `✅ Created ${links} on ${app.repo}, from <@${draft.runner_discord_id}>'s feedback. Triage will pick ${filed.length === 1 ? "it" : "them"} up.`,
    embeds: itemEmbeds(filed.length ? filed : draft.items),
    components: [],
    allowed_mentions: NO_PINGS,
  };
}

export function buildCancelledCard(draft: FeedbackDraft, userId: string): MessagePayload {
  const filed = draft.items.filter((item) => item.issue);
  const already = filed.length
    ? ` Already filed: ${filed.map((i) => `[#${i.issue!.number}](${i.issue!.url})`).join(", ")}.`
    : "";
  return {
    content: `❌ Feedback cancelled by <@${userId}>.${already}`,
    embeds: [],
    components: [],
    allowed_mentions: NO_PINGS,
  };
}

/** Shown in the ephemeral reply once the public card is up. */
export const CARD_POSTED: MessagePayload = {
  content: "Feedback card posted below. Only you can use its controls.",
  allowed_mentions: NO_PINGS,
};

export const NOTHING_FOUND =
  "Nothing to file. Type the feedback into `/feedback` (or attach a screenshot), or right-click the message → Apps → **Send as feedback**.";

// ─── Replies ─────────────────────────────────────────────────────────────────

export function ephemeralMessage(content: string): MessagePayload {
  return { content, components: [], flags: MessageFlags.Ephemeral, allowed_mentions: NO_PINGS };
}

export function ephemeral(content: string): APIInteractionResponse {
  return {
    type: InteractionResponseType.ChannelMessageWithSource,
    data: ephemeralMessage(content),
  };
}

export function updateMessage(data: MessagePayload): APIInteractionResponse {
  return { type: InteractionResponseType.UpdateMessage, data };
}

// ─── Modals ──────────────────────────────────────────────────────────────────

const label = (text: string, component: APILabelComponent["component"], description?: string) =>
  ({
    type: ComponentType.Label,
    label: text,
    ...(description ? { description } : {}),
    component,
  }) as APILabelComponent;

const environmentSelect = (selected: Environment | null = null, required = false) =>
  label(
    "Environment",
    {
      type: ComponentType.StringSelect,
      custom_id: "environment",
      placeholder: "Production or staging?",
      required,
      min_values: required ? 1 : 0,
      max_values: 1,
      options: (Object.keys(ENVIRONMENT_OPTIONS) as Environment[]).map((value) => ({
        ...ENVIRONMENT_OPTIONS[value],
        value,
        default: value === selected,
      })),
    },
    "Production: on the live site. Staging: from dev, not live yet."
  );

const appSelect = (apps: FeedbackApp[]) =>
  label("App", {
    type: ComponentType.StringSelect,
    custom_id: "app",
    placeholder: "Which app is this about?",
    required: true,
    options: apps.map((app) => ({ label: app.name, value: app.name, description: app.repo })),
  });

/**
 * /feedback's modal. Everything is optional: empty means "read the thread" (or the recent
 * messages here). The App select only appears for someone allowed for more than one app.
 */
export function buildIntakeModal(apps: FeedbackApp[]): APIInteractionResponse {
  const components: APILabelComponent[] = [
    label(
      "What should change",
      {
        type: ComponentType.TextInput,
        custom_id: "text",
        style: TextInputStyle.Paragraph,
        required: false,
        max_length: 4000,
        placeholder: "Leave empty to use this thread (or the recent messages here)",
      },
      "As you'd say it to a developer. One message can hold several changes."
    ),
    label("Page or URL", {
      type: ComponentType.TextInput,
      custom_id: "page",
      style: TextInputStyle.Short,
      required: false,
      max_length: 200,
      placeholder: "e.g. https://cxc.uwdatascience.ca/apply",
    }),
    environmentSelect(),
    label(
      "Screenshots",
      {
        type: ComponentType.FileUpload,
        custom_id: "screenshots",
        required: false,
        min_values: 0,
        max_values: 10,
      },
      "Up to 10 images. They're copied into the GitHub issue."
    ),
  ];
  if (apps.length > 1) components.push(appSelect(apps));
  return {
    type: InteractionResponseType.Modal,
    data: { custom_id: customId("intake"), title: "Send feedback", components },
  };
}

/** Send as feedback, for someone allowed for more than one app: which app, and where it was seen. */
export function buildMessageModal(messageId: string, apps: FeedbackApp[]): APIInteractionResponse {
  return {
    type: InteractionResponseType.Modal,
    data: {
      custom_id: customId("message", messageId),
      title: "Send as feedback",
      components: [appSelect(apps), environmentSelect()],
    },
  };
}

/** Edit one item: everything the issue is made from, except the organizer's own words. */
export function buildItemModal(
  draftId: string,
  index: number,
  item: FeedbackItem
): APIInteractionResponse {
  const text = (
    id: string,
    name: string,
    value: string | null,
    style: TextInputStyle,
    max: number,
    required: boolean
  ) =>
    label(name, {
      type: ComponentType.TextInput,
      custom_id: id,
      style,
      required,
      max_length: max,
      // Discord rejects an empty-string value, so omit it when there's nothing.
      ...(value ? { value: value.slice(0, max) } : {}),
    });
  return {
    type: InteractionResponseType.Modal,
    data: {
      custom_id: customId("item", `${draftId}:${index}`),
      title: truncate(`Edit item ${index + 1}`, 45),
      components: [
        text("title", "Title", item.title, TextInputStyle.Short, 120, true),
        label("Type", {
          type: ComponentType.StringSelect,
          custom_id: "type",
          required: true,
          options: (Object.keys(TYPE_LABELS) as FeedbackType[]).map((value) => ({
            label: TYPE_LABELS[value],
            value,
            default: value === item.type,
          })),
        }),
        text("page", "Page or URL", item.page, TextInputStyle.Short, 200, false),
        text("restatement", "Summary", item.restatement, TextInputStyle.Paragraph, 1000, true),
        environmentSelect(item.environment),
      ],
    },
  };
}
