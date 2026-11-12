import { randomUUID } from "node:crypto";
import {
  ApplicationCommandType,
  ChannelType,
  ComponentType,
  InteractionResponseType,
  InteractionType,
  MessageFlags,
  type API,
  type APIInteraction,
  type APIMessage,
} from "@nexus-bot/discord";
import { describe, expect, it, vi } from "vitest";
import { dispatch } from "../../dispatch";
import { GitHubError, type FeedbackGitHub, type NewIssue } from "../../github-app";
import { createRegistry } from "../../registry";
import type { ScreenshotStore } from "../../screenshots";
import type { Services } from "../../services";
import { parseGuildSettings } from "../../settings";
import { FeedbackExtractionError } from "./extract";
import {
  APP_ID,
  CHANNEL,
  CXC_TEAM,
  DESIGN,
  GUILD,
  RUNNER,
  THREAD,
  VP,
  image,
  message,
} from "./fixtures";
import { RUNS_PER_USER } from "./handlers";
import { feedback } from "./index";
import type { ExtractedItem, FeedbackDraft, FeedbackDraftStore, FeedbackExtractor } from "./types";

/** A message body or response data, loosely: only what the tests look at. */
type Payload = { content?: string; flags?: number; [key: string]: unknown };

const NOW = Date.parse("2026-11-08T17:00:00Z");
const CARD_ID = "650000000000000001";

// ─── Fakes ───────────────────────────────────────────────────────────────────

/** discord.feedback_drafts in memory, with the same guards as the SQL. */
function memoryDrafts(now: () => number) {
  const rows = new Map<string, FeedbackDraft>();
  const copy = (d: FeedbackDraft) => structuredClone(d);
  const transition = (id: string, from: FeedbackDraft["status"], to: FeedbackDraft["status"]) => {
    const row = rows.get(id);
    if (row?.status !== from) return null;
    row.status = to;
    return copy(row);
  };
  const store: FeedbackDraftStore = {
    async create(data) {
      const row: FeedbackDraft = {
        id: randomUUID(),
        ...structuredClone(data),
        status: "pending",
        message_id: null,
        created_at: new Date(now()),
        expires_at: new Date(now() + 3_600_000),
      };
      rows.set(row.id, row);
      return copy(row);
    },
    getById: async (id) => (rows.has(id) ? copy(rows.get(id)!) : null),
    async setCardMessage(id, messageId) {
      rows.get(id)!.message_id = messageId;
    },
    async lastCardMessageId(channelId) {
      const cards = [...rows.values()].filter((r) => r.channel_id === channelId && r.message_id);
      return cards.at(-1)?.message_id ?? null;
    },
    async updateItems(id, items) {
      const row = rows.get(id);
      if (row?.status !== "pending") return null;
      row.items = structuredClone(items);
      return copy(row);
    },
    claimForCreating: async (id) => {
      const row = rows.get(id);
      if (!row || row.expires_at.getTime() <= now()) return null;
      return transition(id, "pending", "creating");
    },
    async setItemIssue(id, index, issue) {
      const row = rows.get(id)!;
      if (row.items[index]) row.items[index]!.issue = issue;
    },
    releaseClaim: async (id) => transition(id, "creating", "pending"),
    markCreated: async (id) => transition(id, "creating", "created"),
    cancel: async (id) => transition(id, "pending", "cancelled"),
  };
  return { rows, store };
}

const extractedItem = (overrides: Partial<ExtractedItem> = {}): ExtractedItem => ({
  title: "Fix the FAQ link",
  type: "bug",
  page: "https://cxc.uwdatascience.ca/faq",
  verbatim: "the FAQ link 404s",
  restatement: "Point the FAQ link at the FAQ.",
  messages: [1],
  screenshots: [],
  ...overrides,
});

interface Setup {
  extracted?: ExtractedItem[];
  extractError?: Error;
  failIssues?: number[];
  messages?: Record<string, APIMessage[]>;
  apps?: Record<string, unknown>;
}

function setup({
  extracted = [extractedItem()],
  extractError,
  failIssues = [],
  messages = {},
  apps,
}: Setup = {}) {
  let clock = NOW;
  const now = () => clock;
  const { rows, store } = memoryDrafts(now);

  const runs: { userId: string; at: number }[] = [];
  const usage: Services["usage"] = {
    async record(run) {
      runs.push({ userId: run.userId, at: now() });
    },
    async recentRuns({ userId, userWindowSeconds }) {
      return {
        byUser: runs.filter((r) => r.userId === userId && r.at > now() - userWindowSeconds * 1000)
          .length,
        byChannel: 0,
      };
    },
  };

  let issueNumber = 11;
  let createCalls = 0;
  const filed: NewIssue[] = [];
  // Only what intake uses; updates.test.ts covers the rest.
  const github: Pick<FeedbackGitHub, "isPublic" | "strictness" | "createIssue"> = {
    isPublic: vi.fn(async () => true),
    strictness: vi.fn(async () => "strict" as const),
    createIssue: vi.fn(async (_repo: string, issue: NewIssue) => {
      createCalls++;
      if (failIssues.includes(createCalls)) throw new GitHubError("GitHub returned 502", 502);
      filed.push(issue);
      issueNumber++;
      return {
        number: issueNumber,
        url: `https://github.com/uw-datasci/cxc/issues/${issueNumber}`,
      };
    }),
  };

  const screenshots: ScreenshotStore = {
    download: vi.fn(async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: "image/png" as const,
    })),
    save: vi.fn(async (path: string) => `https://blob.example/${path}`),
  };

  const extractFeedback = vi.fn<FeedbackExtractor>(async () => {
    if (extractError) throw extractError;
    return extracted;
  });

  const discord = {
    channels: {
      getMessages: vi.fn(async (id: string) => [...(messages[id] ?? [])].reverse()),
      getMessage: vi.fn(async () => {
        throw Object.assign(new Error("Unknown Message"), { status: 404 });
      }),
    },
    interactions: {
      editReply: vi.fn(async (_app: string, _token: string, _body: Payload) => ({
        id: "ephemeral",
        channel_id: THREAD,
      })),
      followUp: vi.fn(async (_app: string, _token: string, _body: Payload) => ({
        id: CARD_ID,
        channel_id: THREAD,
      })),
    },
  };
  const reportError = vi.fn().mockResolvedValue(undefined);
  const deps = {
    registry: createRegistry([feedback]),
    loadSettings: async () =>
      parseGuildSettings(GUILD, {
        kind: "exec",
        feedback_apps: apps ?? {
          cxc: {
            repo: "uw-datasci/cxc",
            production_url: "https://cxc.uwdatascience.ca",
            role_sets: [[CXC_TEAM], [VP, DESIGN]],
          },
        },
      }),
    discord: discord as unknown as API,
    applicationId: APP_ID,
    reportError,
    now,
    services: {
      usage,
      feedbackDrafts: store,
      github: github as FeedbackGitHub,
      screenshots,
      extractFeedback,
    } as Partial<Services> as Services,
  };

  const send = async (interaction: object) => {
    const result = await dispatch(interaction as APIInteraction, deps);
    await result.background?.();
    return result.response as { type: number; data?: Payload };
  };

  return {
    rows,
    runs,
    filed,
    github,
    screenshots,
    extractFeedback,
    discord,
    reportError,
    send,
    tick: (ms: number) => (clock += ms),
    /** The card the last run posted, and its draft. */
    card: () => discord.interactions.followUp.mock.calls.at(-1)![2],
    draft: () => [...rows.values()].at(-1)!,
  };
}

// ─── Interactions ────────────────────────────────────────────────────────────

const base = (
  roles = [CXC_TEAM],
  user = RUNNER,
  channel: object = { id: THREAD, type: ChannelType.PublicThread, parent_id: CHANNEL }
) => ({
  id: "1436700000000000000",
  application_id: APP_ID,
  token: "interaction-token",
  version: 1,
  guild_id: GUILD,
  channel,
  channel_id: (channel as { id: string }).id,
  member: { user: { id: user, username: "sam", global_name: "Sam" }, roles },
});

const slash = (roles?: string[]) => ({
  ...base(roles),
  type: InteractionType.ApplicationCommand,
  data: { id: "1", name: "feedback", type: ApplicationCommandType.ChatInput },
});

/** /feedback's modal, submitted: text inputs and selects in Labels, uploads resolved. */
function intake(
  fields: { text?: string; page?: string; environment?: string; uploads?: string[] } = {},
  options: { roles?: string[]; channel?: object } = {}
) {
  const uploads = fields.uploads ?? [];
  return {
    ...base(options.roles, RUNNER, options.channel),
    type: InteractionType.ModalSubmit,
    data: {
      custom_id: "fb:intake:",
      components: [
        {
          type: ComponentType.Label,
          component: { type: ComponentType.TextInput, custom_id: "text", value: fields.text ?? "" },
        },
        {
          type: ComponentType.Label,
          component: { type: ComponentType.TextInput, custom_id: "page", value: fields.page ?? "" },
        },
        {
          type: ComponentType.Label,
          component: {
            type: ComponentType.StringSelect,
            custom_id: "environment",
            values: fields.environment ? [fields.environment] : [],
          },
        },
        {
          type: ComponentType.Label,
          component: { type: ComponentType.FileUpload, custom_id: "screenshots", values: uploads },
        },
      ],
      resolved: { attachments: Object.fromEntries(uploads.map((url) => [url, image(url)])) },
    },
  };
}

const select = (action: string, id: string, values: string[], user = RUNNER) => ({
  ...base([CXC_TEAM], user),
  type: InteractionType.MessageComponent,
  message: { id: CARD_ID },
  data: { custom_id: `fb:${action}:${id}`, component_type: ComponentType.StringSelect, values },
});

const button = (action: string, id: string, user = RUNNER) => ({
  ...base([CXC_TEAM], user),
  type: InteractionType.MessageComponent,
  message: { id: CARD_ID },
  data: { custom_id: `fb:${action}:${id}`, component_type: ComponentType.Button },
});

const content = (response: { data?: Payload }) => response.data?.content;
const isEphemeral = (response: { data?: Payload }) =>
  Boolean((response.data?.flags ?? 0) & MessageFlags.Ephemeral);

const threadMessages = () => ({
  [THREAD]: [message("the FAQ link on the landing page 404s"), message("yeah, and it's on prod")],
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("/feedback", () => {
  it("opens the modal for cxc-team, and for VP with Design, but not VP alone", async () => {
    const t = setup();
    expect((await t.send(slash([CXC_TEAM]))).type).toBe(InteractionResponseType.Modal);
    expect((await t.send(slash([VP, DESIGN]))).type).toBe(InteractionResponseType.Modal);
    const refused = await t.send(slash([VP]));
    expect(isEphemeral(refused)).toBe(true);
    expect(content(refused)).toMatch(/can't send feedback here/);
  });

  it("refuses the 11th run in an hour, and allows it again later", async () => {
    const t = setup({ messages: threadMessages() });
    for (let i = 0; i < RUNS_PER_USER; i++) await t.send(intake());
    expect(content(await t.send(slash()))).toMatch(/10 times in the last hour/);
    expect(content(await t.send(intake()))).toMatch(/10 times in the last hour/);
    expect(t.runs).toHaveLength(RUNS_PER_USER);
    t.tick(3_600_001);
    expect((await t.send(slash())).type).toBe(InteractionResponseType.Modal);
  });

  it("empty in a thread: reads the thread and posts a public card, privately acknowledged", async () => {
    const t = setup({ messages: threadMessages() });
    const response = await t.send(intake());
    expect(response).toEqual({
      type: InteractionResponseType.DeferredChannelMessageWithSource,
      data: { flags: MessageFlags.Ephemeral },
    });

    const input = t.extractFeedback.mock.calls[0]![0];
    expect(input).toMatchObject({ app: "cxc", mode: "thread", messageCount: 2, runnerText: null });
    expect(input.transcript).toMatch(/^\[m1\] .*the FAQ link on the landing page 404s\n\[m2\]/);

    expect(t.discord.interactions.editReply.mock.calls[0]).toMatchObject([
      APP_ID,
      "interaction-token",
      { content: "Feedback card posted below. Only you can use its controls." },
    ]);
    const card = t.card();
    expect(card.flags).toBeUndefined(); // public
    expect(card.content).toContain(
      "📝 **Feedback for cxc** from <@400000000000000001>. From this thread (2 messages"
    );
    expect(t.draft()).toMatchObject({
      mode: "thread",
      message_id: CARD_ID,
      items: [
        {
          title: "Fix the FAQ link",
          environment: "prod",
          sources: [expect.stringContaining(`/${THREAD}/`)],
        },
      ],
    });
  });

  it("prompt mode: the typed text and screenshots are the feedback, copied to Blob", async () => {
    const t = setup({
      messages: threadMessages(),
      extracted: [extractedItem({ messages: [], screenshots: [1, 2], page: null })],
    });
    await t.send(
      intake({
        text: "the logo is blurry",
        page: "https://cxc-git-dev.vercel.app/",
        uploads: ["https://cdn.discordapp.com/1.png", "https://cdn.discordapp.com/2.png"],
      })
    );
    const input = t.extractFeedback.mock.calls[0]![0];
    expect(input).toMatchObject({
      mode: "prompt",
      runnerText: "the logo is blurry",
      imageCount: 2,
    });
    expect(input.images.map((i) => i.label)).toEqual([
      "attached to /feedback",
      "attached to /feedback",
    ]);
    expect(input.transcript).toContain("[m1]"); // the thread, as background

    const [saved] = t.draft().items;
    expect(saved!.environment).toBe("staging"); // from the preview URL
    expect(saved!.screenshots).toEqual([
      expect.stringMatching(/^https:\/\/blob\.example\/feedback\/[\w-]+\/1\.png$/),
      expect.stringMatching(/\/2\.png$/),
    ]);
    expect(t.draft().sources).toEqual([]);
  });

  it("empty in a channel: only the messages since the last card", async () => {
    const channel = { id: CHANNEL, type: ChannelType.GuildText };
    const earlier = message("old feedback", { channel_id: CHANNEL, at: "2026-11-08T16:50:00Z" });
    const later = message("the apply button is broken", {
      channel_id: CHANNEL,
      at: "2026-11-08T16:58:00Z",
    });
    const t = setup({ messages: { [CHANNEL]: [earlier, later] } });
    await t.send(intake({}, { channel }));
    expect(t.extractFeedback.mock.calls[0]![0].messageCount).toBe(2);

    // Pretend the card was posted right after the earlier message.
    t.draft().message_id = earlier.id;
    await t.send(intake({}, { channel }));
    const second = t.extractFeedback.mock.calls[1]![0];
    expect(second.mode).toBe("channel");
    expect(second.transcript).not.toContain("old feedback");
    expect(second.messageCount).toBe(1);
  });

  it("finds nothing: an ephemeral hint, no card and no draft", async () => {
    const t = setup({
      messages: threadMessages(),
      extracted: [extractedItem({ type: "question" })],
    });
    await t.send(intake());
    expect(t.discord.interactions.editReply.mock.calls.at(-1)![2]).toMatchObject({
      content: expect.stringMatching(/^Nothing to file/),
    });
    expect(t.discord.interactions.followUp).not.toHaveBeenCalled();
    expect(t.rows.size).toBe(0);

    const empty = setup();
    await empty.send(intake());
    expect(empty.extractFeedback).not.toHaveBeenCalled(); // no LLM call for an empty thread
  });

  it("shows extraction failures privately and reports them with their severity", async () => {
    const t = setup({
      messages: threadMessages(),
      extractError: new FeedbackExtractionError("The AI model timed out after 30s."),
    });
    await t.send(intake());
    expect(t.discord.interactions.editReply.mock.calls.at(-1)![2]).toMatchObject({
      content: "Couldn't read the feedback: The AI model timed out after 30s.",
    });
    expect(t.reportError).toHaveBeenCalledWith(
      expect.any(FeedbackExtractionError),
      expect.objectContaining({ route: "discord:feedback", step: "intake", mode: "thread" }),
      "warning"
    );
  });
});

describe("Send as feedback", () => {
  it("reads the message, its attachments and the replies to it", async () => {
    const target = message("the countdown shows the wrong date", {
      channel_id: CHANNEL,
      attachments: [image("https://cdn.discordapp.com/shot.png")] as never,
    });
    const reply = message("it's off by a day", {
      channel_id: CHANNEL,
      message_reference: { message_id: target.id } as never,
    });
    const t = setup({
      messages: { [CHANNEL]: [target, reply] },
      extracted: [extractedItem({ messages: [1, 2], screenshots: [1] })],
    });
    await t.send({
      ...base([CXC_TEAM], RUNNER, { id: CHANNEL, type: ChannelType.GuildText }),
      type: InteractionType.ApplicationCommand,
      data: {
        id: "2",
        name: "Send as feedback",
        type: ApplicationCommandType.Message,
        target_id: target.id,
        resolved: { messages: { [target.id]: target } },
      },
    });
    const input = t.extractFeedback.mock.calls[0]![0];
    expect(input).toMatchObject({ mode: "message", messageCount: 2, imageCount: 1 });
    expect(input.images[0]!.label).toBe("in m1");
    expect(t.draft().items[0]!.sources).toHaveLength(2);
    expect(t.draft().items[0]!.screenshots).toHaveLength(1);
  });

  it("is refused for VP alone", async () => {
    const t = setup();
    const response = await t.send({
      ...base([VP]),
      type: InteractionType.ApplicationCommand,
      data: {
        id: "2",
        name: "Send as feedback",
        type: ApplicationCommandType.Message,
        target_id: "1",
        resolved: { messages: {} },
      },
    });
    expect(content(response)).toMatch(/can't send feedback here/);
  });
});

describe("the card", () => {
  const twoItems = [
    extractedItem(),
    extractedItem({ title: "Tighten the hero spacing", type: "nit", page: "the landing page" }),
  ];

  async function withCard(options: Setup = {}) {
    const t = setup({ messages: threadMessages(), extracted: twoItems, ...options });
    await t.send(intake());
    return { ...t, id: t.draft().id };
  }

  it("only works for the runner, and stops after an hour", async () => {
    const t = await withCard();
    const other = await t.send(button("cancel", t.id, "400000000000000999"));
    expect(content(other)).toBe("Only <@400000000000000001> can use this card.");
    t.tick(3_600_000);
    expect(content(await t.send(button("cancel", t.id)))).toMatch(/expired/);
    expect(t.draft().status).toBe("pending");
  });

  it("blocks Create until every kept item has an environment", async () => {
    const t = await withCard();
    const blocked = await t.send(button("create", t.id));
    expect(content(blocked)).toMatch(/Pick an environment for item 2/);
    expect(t.github.createIssue).not.toHaveBeenCalled();

    const updated = await t.send(select("env", t.id, ["staging"]));
    expect(updated.type).toBe(InteractionResponseType.UpdateMessage);
    expect(t.draft().items.map((i) => i.environment)).toEqual(["staging", "staging"]);
  });

  it("leaves items out, edits one, then files the rest as issues", async () => {
    const t = await withCard();
    await t.send(select("drop", t.id, ["0"]));
    expect(t.draft().items.map((i) => i.dropped)).toEqual([true, false]);

    const modal = await t.send(button("edit", `${t.id}:1`));
    expect(modal.type).toBe(InteractionResponseType.Modal);
    await t.send({
      ...base(),
      type: InteractionType.ModalSubmit,
      message: { id: CARD_ID },
      data: {
        custom_id: `fb:item:${t.id}:1`,
        components: [
          {
            type: ComponentType.Label,
            component: {
              type: ComponentType.TextInput,
              custom_id: "title",
              value: "Reduce hero padding",
            },
          },
          {
            type: ComponentType.Label,
            component: { type: ComponentType.StringSelect, custom_id: "type", values: ["change"] },
          },
          {
            type: ComponentType.Label,
            component: {
              type: ComponentType.TextInput,
              custom_id: "page",
              value: "https://cxc.uwdatascience.ca/",
            },
          },
          {
            type: ComponentType.Label,
            component: {
              type: ComponentType.TextInput,
              custom_id: "restatement",
              value: "Halve the hero's top padding.",
            },
          },
          {
            type: ComponentType.Label,
            component: {
              type: ComponentType.StringSelect,
              custom_id: "environment",
              values: ["prod"],
            },
          },
        ],
      },
    });
    expect(t.draft().items[1]).toMatchObject({
      title: "Reduce hero padding",
      type: "change",
      environment: "prod",
    });

    const created = await t.send(button("create", t.id));
    expect(created.type).toBe(InteractionResponseType.DeferredMessageUpdate);
    expect(t.filed).toHaveLength(1);
    expect(t.filed[0]).toMatchObject({
      title: "Reduce hero padding",
      labels: ["feedback", "feedback:change", "env:prod"],
    });
    expect(t.filed[0]!.body).toContain(`"message":"${CARD_ID}"`);
    expect(t.filed[0]!.body).toContain("Submitted by **Sam**");
    expect(t.draft().status).toBe("created");
    const edit = t.discord.interactions.editReply.mock.calls.at(-1)!;
    expect(edit[2].content).toMatch(/^✅ Created \[#12\]/);
  });

  it("a second Create loses the claim and files nothing twice", async () => {
    const t = await withCard();
    await t.send(select("env", t.id, ["prod"]));
    await t.send(button("create", t.id));
    expect(content(await t.send(button("create", t.id)))).toMatch(/no longer active/);
    expect(t.filed).toHaveLength(2);
  });

  it("after a partial failure, Create again files only what's missing", async () => {
    const t = await withCard({ failIssues: [2] });
    await t.send(select("env", t.id, ["prod"]));
    await t.send(button("create", t.id));
    expect(t.draft().status).toBe("pending");
    expect(t.draft().items.map((i) => i.issue?.number ?? null)).toEqual([12, null]);
    expect(t.discord.interactions.followUp.mock.calls.at(-1)![2]).toMatchObject({
      content: expect.stringMatching(/item 2\. Press \*\*Create\*\* again/),
      flags: MessageFlags.Ephemeral,
    });
    expect(t.reportError).toHaveBeenCalledWith(
      expect.any(GitHubError),
      expect.objectContaining({ step: "create", failed: 1 }),
      "warning"
    );

    await t.send(button("create", t.id));
    expect(t.filed.map((i) => i.title)).toEqual(["Fix the FAQ link", "Tighten the hero spacing"]);
    expect(t.draft().status).toBe("created");
  });

  it("cancels", async () => {
    const t = await withCard();
    const response = await t.send(button("cancel", t.id));
    expect(content(response)).toBe("❌ Feedback cancelled by <@400000000000000001>.");
    expect(t.draft().status).toBe("cancelled");
    expect(content(await t.send(button("create", t.id)))).toMatch(/no longer active/);
  });
});
