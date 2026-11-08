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
import type { AdminApi, CreatedEvent } from "../../admin-api";
import { dispatch } from "../../dispatch";
import { createRegistry } from "../../registry";
import { parseGuildSettings } from "../../settings";
import { eventCreate } from "./index";
import { ExtractionError } from "./extract";
import type { EventDraft, EventDraftStore, EventExtractor, ExtractedEvent } from "./types";

const GUILD = "100000000000000001";
const EXEC_ROLE = "200000000000000001";
const EXEC = "400000000000000001";
const THREAD = "300000000000000001";
const APP = "500000000000000001";
const NOW = Date.parse("2026-11-08T17:00:00Z");

// ─── Fakes ───────────────────────────────────────────────────────────────────

/** discord.event_drafts in memory, with the same guards as the SQL. */
function memoryStore(now: () => number) {
  const rows = new Map<string, EventDraft & { created_ms: number }>();
  const pending = (id: string) => {
    const row = rows.get(id);
    return row?.status === "pending" ? row : null;
  };
  const store: EventDraftStore = {
    async startRun(data) {
      const row = {
        id: randomUUID(),
        ...data,
        message_id: null,
        status: "pending" as const,
        name: null,
        location: null,
        description: null,
        start_time: null,
        end_time: null,
        category: null,
        submitted_name: null,
        submitted_location: null,
        submitted_start: null,
        submitted_end: null,
        submitted_description: null,
        created_event_id: null,
        created_at: new Date(now()),
        expires_at: new Date(now() + 3_600_000),
        created_ms: now(),
      };
      rows.set(row.id, row);
      return { ...row };
    },
    async setExtracted(id, data) {
      const row = rows.get(id)!;
      Object.assign(row, {
        ...data,
        start_time: data.start_time ? new Date(data.start_time) : null,
        end_time: data.end_time ? new Date(data.end_time) : null,
        expires_at: new Date(now() + 3_600_000),
      });
      return { ...row };
    },
    async countRecentRuns(initiator, channel, initiatorWindowS, channelWindowS) {
      const all = [...rows.values()];
      return {
        by_initiator: all.filter(
          (r) =>
            r.initiator_discord_id === initiator && r.created_ms > now() - initiatorWindowS * 1000
        ).length,
        by_channel: all.filter(
          (r) => r.channel_id === channel && r.created_ms > now() - channelWindowS * 1000
        ).length,
      };
    },
    async getById(id) {
      const row = rows.get(id);
      return row ? { ...row } : null;
    },
    async setCardMessage(id, channelId, messageId) {
      Object.assign(rows.get(id)!, { channel_id: channelId, message_id: messageId });
    },
    async updateCategory(id, category) {
      const row = pending(id);
      if (!row) return null;
      row.category = category;
      return { ...row };
    },
    async saveSubmission(id, v) {
      const row = pending(id);
      if (row)
        Object.assign(row, {
          submitted_name: v.name,
          submitted_location: v.location,
          submitted_start: v.start,
          submitted_end: v.end,
          submitted_description: v.description,
        });
    },
    async claimForCreation(id) {
      const row = pending(id);
      if (!row || row.expires_at.getTime() <= now()) return null;
      row.status = "created";
      return { ...row };
    },
    async releaseClaim(id) {
      const row = rows.get(id);
      if (row?.status === "created" && !row.created_event_id) row.status = "pending";
    },
    async setCreatedEvent(id, eventId) {
      rows.get(id)!.created_event_id = eventId;
    },
    async cancel(id) {
      const row = pending(id);
      if (!row) return null;
      row.status = "cancelled";
      return { ...row };
    },
  };
  return { store, rows };
}

const EXTRACTED: ExtractedEvent = {
  name: "Intro to SQL",
  location: "MC 4020",
  description: "Bring a laptop 💻",
  start_time: "2026-11-20T23:00:00.000Z",
  end_time: "2026-11-21T01:00:00.000Z",
  category: null,
};

function setup({ createDraftEvent }: { createDraftEvent?: AdminApi["createDraftEvent"] } = {}) {
  let clock = NOW;
  const { store, rows } = memoryStore(() => clock);
  const thread: APIMessage[] = [
    {
      id: THREAD,
      content: "Intro to SQL workshop, Nov 20 at 6 in MC 4020?",
      timestamp: "2026-11-01T15:00:00Z",
      author: { id: EXEC, username: "exec" },
    } as APIMessage,
  ];
  const extractEvent = vi.fn<EventExtractor>().mockResolvedValue(EXTRACTED);
  const discord = {
    channels: {
      getMessages: vi.fn().mockResolvedValue(thread),
      getMessage: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("Unknown Message"), { status: 404 })),
      editMessage: vi.fn().mockResolvedValue({}),
    },
    interactions: {
      editReply: vi.fn().mockResolvedValue({ id: "card-1", channel_id: THREAD }),
      followUp: vi.fn().mockResolvedValue({}),
    },
  };
  const createDraft = vi.fn<AdminApi["createDraftEvent"]>(
    createDraftEvent ??
      (async (fields) => ({ ok: true, event: { id: "event-1", ...fields } as CreatedEvent }))
  );
  const reportError = vi.fn().mockResolvedValue(undefined);
  const deps = {
    registry: createRegistry([eventCreate]),
    loadSettings: async () =>
      parseGuildSettings(GUILD, { kind: "exec", role_ids: { exec: [EXEC_ROLE] } }),
    discord: discord as unknown as API,
    applicationId: APP,
    reportError,
    now: () => clock,
    services: { eventDrafts: store, adminApi: { createDraftEvent: createDraft }, extractEvent },
  };
  return {
    rows,
    discord,
    createDraft,
    extractEvent,
    reportError,
    tick: (ms: number) => (clock += ms),
    send: (interaction: object) => dispatch(interaction as APIInteraction, deps),
  };
}

const base = (user = EXEC, roles = [EXEC_ROLE]) => ({
  id: "1436700000000000000",
  application_id: APP,
  token: "interaction-token",
  version: 1,
  guild_id: GUILD,
  member: { user: { id: user, username: "u" }, roles },
});
const command = (channelType = ChannelType.PublicThread, user?: string, roles?: string[]) => ({
  ...base(user, roles),
  type: InteractionType.ApplicationCommand,
  channel: { id: THREAD, type: channelType, parent_id: "600000000000000001" },
  data: { id: "c", name: "event-create", type: ApplicationCommandType.ChatInput },
});
const button = (customId: string, extra: object = {}) => ({
  ...base(),
  type: InteractionType.MessageComponent,
  message: { id: "card-1" },
  data: { custom_id: customId, component_type: ComponentType.Button, ...extra },
});
const select = (customId: string, value: string) =>
  button(customId, { component_type: ComponentType.StringSelect, values: [value] });
const modalSubmit = (customId: string, values: Record<string, string>, messageId = "card-1") => ({
  ...base(),
  type: InteractionType.ModalSubmit,
  message: { id: messageId },
  data: {
    custom_id: customId,
    components: Object.entries(values).map(([custom_id, value]) => ({
      type: 1,
      components: [{ type: 4, custom_id, value }],
    })),
  },
});

const contentOf = (result: { response: unknown }) =>
  (result.response as { data?: { content?: string } }).data?.content ?? "";
const GOOD = {
  name: "Intro to SQL",
  location: "MC 4020",
  start: "2026-11-20 18:00",
  end: "2026-11-20 20:00",
  description: "Bring a laptop 💻",
};

/** Run /event-create, post the card, and pick a category: a draft ready to confirm. */
async function readyDraft(t: ReturnType<typeof setup>) {
  const result = await t.send(command());
  await result.background?.();
  const [draft] = [...t.rows.values()];
  await t.send(select(`evt:category:${draft!.id}`, "workshop"));
  return draft!.id;
}

// ─── /event-create ───────────────────────────────────────────────────────────

describe("/event-create", () => {
  it("defers publicly, then reads the thread and edits the reply into the preview card", async () => {
    const t = setup();
    const result = await t.send(command());
    expect(result.response).toEqual({
      type: InteractionResponseType.DeferredChannelMessageWithSource,
    });

    await result.background?.();
    expect(t.extractEvent).toHaveBeenCalledWith(expect.any(Array), {
      starterId: THREAD,
      excludeAuthorId: APP,
    });
    const [, token, card] = t.discord.interactions.editReply.mock.calls[0]!;
    expect(token).toBe("interaction-token");
    expect(card.embeds[0].title).toBe("Intro to SQL");
    expect(card.components[1].components[0]).toMatchObject({
      label: "Review & confirm",
      disabled: true,
    });
    const [draft] = [...t.rows.values()];
    expect(draft).toMatchObject({ message_id: "card-1", name: "Intro to SQL", status: "pending" });
  });

  it("only works in a thread, and only for execs", async () => {
    const t = setup();
    expect(contentOf(await t.send(command(ChannelType.GuildText)))).toMatch(/inside the thread/);
    expect(contentOf(await t.send(command(ChannelType.PublicThread, "999", [])))).toBe(
      "Only execs can create events from Discord."
    );
    expect(t.rows.size).toBe(0);
  });

  it("rate limits: one run per thread per minute, five per exec per hour", async () => {
    const t = setup();
    await t.send(command());
    expect(contentOf(await t.send(command()))).toMatch(/was just run in this thread/);

    for (let i = 0; i < 4; i++) {
      t.tick(61_000);
      expect((await t.send(command())).response.type).toBe(
        InteractionResponseType.DeferredChannelMessageWithSource
      );
    }
    t.tick(61_000);
    expect(contentOf(await t.send(command()))).toMatch(/5 times in the last hour/);
    t.tick(60 * 60_000);
    expect((await t.send(command())).response.type).toBe(
      InteractionResponseType.DeferredChannelMessageWithSource
    );
  });

  it("shows a failure card, cancels the draft and reports when extraction fails", async () => {
    const t = setup();
    t.extractEvent.mockRejectedValue(
      new ExtractionError("The AI model timed out after 40s.", { detail: "x" })
    );
    const result = await t.send(command());
    await result.background?.();

    expect(t.discord.interactions.editReply.mock.calls[0]![2].embeds[0].description).toMatch(
      /timed out/
    );
    expect([...t.rows.values()][0]!.status).toBe("cancelled");
    expect(t.reportError).toHaveBeenCalledWith(
      expect.any(ExtractionError),
      expect.objectContaining({ route: "discord:event-bot", step: "extract", detail: "x" }),
      "warning"
    );
  });
});

// ─── The card's controls ─────────────────────────────────────────────────────

describe("the card", () => {
  it("picks a category, which enables Review & confirm", async () => {
    const t = setup();
    const result = await t.send(command());
    await result.background?.();
    const id = [...t.rows.keys()][0]!;
    const updated = await t.send(select(`evt:category:${id}`, "workshop"));
    expect(updated.response.type).toBe(InteractionResponseType.UpdateMessage);
    expect(
      (updated.response as { data: { components: { components: { disabled?: boolean }[] }[] } })
        .data.components[1]!.components[0]!.disabled
    ).toBe(false);
    expect(contentOf(await t.send(select(`evt:category:${id}`, "party")))).toBe(
      "Unknown category."
    );
  });

  it("opens the review modal prefilled, preferring what was last typed", async () => {
    const t = setup();
    const id = await readyDraft(t);
    const opened = await t.send(button(`evt:review:${id}`));
    expect(opened.response.type).toBe(InteractionResponseType.Modal);
    const inputs = (
      opened.response as {
        data: { components: { components: { custom_id: string; value?: string }[] }[] };
      }
    ).data.components.map((row) => row.components[0]!);
    expect(inputs.find((i) => i.custom_id === "start")?.value).toBe("2026-11-20 18:00");
  });

  it("lets only the runner use the controls, and only while the draft is live", async () => {
    const t = setup();
    const id = await readyDraft(t);
    // A member without the exec role.
    const nonExec = {
      ...button(`evt:review:${id}`),
      member: { user: { id: "400000000000000002" }, roles: [] },
    };
    expect(contentOf(await t.send(nonExec))).toBe("Only execs can create events from Discord.");

    const other = setup();
    const otherId = await readyDraft(other);
    // Same exec role, different person.
    const stranger = {
      ...button(`evt:review:${otherId}`),
      member: { user: { id: "400000000000000009" }, roles: [EXEC_ROLE] },
    };
    expect(contentOf(await other.send(stranger))).toBe(`Only <@${EXEC}> can edit this event.`);

    other.tick(61 * 60_000);
    expect(contentOf(await other.send(button(`evt:review:${otherId}`)))).toMatch(
      /This draft expired/
    );
    expect(
      contentOf(await other.send(button(`evt:review:00000000-0000-4000-8000-000000000000`)))
    ).toBe("This draft no longer exists.");
  });

  it("cancels", async () => {
    const t = setup();
    const id = await readyDraft(t);
    const cancelled = await t.send(button(`evt:cancel:${id}`));
    expect(contentOf(cancelled)).toBe(`❌ Cancelled by <@${EXEC}>.`);
    expect(contentOf(await t.send(button(`evt:review:${id}`)))).toBe(
      "This draft is no longer active."
    );
  });
});

// ─── Confirming ──────────────────────────────────────────────────────────────

describe("the review modal", () => {
  it("rejects bad times and DST-gap times with a Fix button, before creating anything", async () => {
    const t = setup();
    const id = await readyDraft(t);
    for (const [start, pattern] of [
      ["tomorrow at 6", /isn't a valid date/],
      ["2027-03-14 02:30", /doesn't exist/],
    ] as const) {
      const result = await t.send(modalSubmit(`evt:modal:${id}`, { ...GOOD, start }));
      expect(contentOf(result)).toMatch(pattern);
      const data = (
        result.response as {
          data: { flags: number; components: { components: { custom_id: string }[] }[] };
        }
      ).data;
      expect(data.flags & MessageFlags.Ephemeral).toBeTruthy();
      expect(data.components[0]!.components[0]!.custom_id).toBe(`evt:fix:${id}`);
    }
    expect(t.createDraft).not.toHaveBeenCalled();
    // [Fix] reopens the modal with what was typed.
    const fix = await t.send(button(`evt:fix:${id}`));
    const inputs = (
      fix.response as {
        data: { components: { components: { custom_id: string; value?: string }[] }[] };
      }
    ).data.components.map((r) => r.components[0]!);
    expect(inputs.find((i) => i.custom_id === "start")?.value).toBe("2027-03-14 02:30");
  });

  it("needs a category first", async () => {
    const t = setup();
    const result = await t.send(command());
    await result.background?.();
    const id = [...t.rows.keys()][0]!;
    expect(contentOf(await t.send(modalSubmit(`evt:modal:${id}`, GOOD)))).toMatch(
      /Pick a category/
    );
  });

  it("acknowledges, then creates the draft event through the admin API and updates the card", async () => {
    const t = setup();
    const id = await readyDraft(t);
    const result = await t.send(modalSubmit(`evt:modal:${id}`, GOOD));
    expect(result.response).toEqual({ type: InteractionResponseType.DeferredMessageUpdate });
    expect(t.createDraft).not.toHaveBeenCalled();

    await result.background?.();
    expect(t.createDraft).toHaveBeenCalledWith(
      {
        name: "Intro to SQL",
        location: "MC 4020",
        description: "Bring a laptop 💻",
        start_time: "2026-11-20T23:00:00.000Z",
        end_time: "2026-11-21T01:00:00.000Z",
        category: "workshop",
        image_url: null,
        resources: [],
      },
      { discordId: EXEC }
    );
    const created = t.discord.interactions.editReply.mock.calls.at(-1)![2];
    expect(created.content).toMatch(/Draft created by/);
    expect(created.embeds[0].url).toBe("https://admin.uwdatascience.ca/events");
    expect(t.rows.get(id)).toMatchObject({ status: "created", created_event_id: "event-1" });
  });

  it("can't create two events from a double submit", async () => {
    const t = setup();
    const id = await readyDraft(t);
    const [a, b] = await Promise.all([
      t.send(modalSubmit(`evt:modal:${id}`, GOOD)),
      t.send(modalSubmit(`evt:modal:${id}`, GOOD)),
    ]);
    const texts = [contentOf(a), contentOf(b)];
    expect(texts.filter((x) => /already submitted|no longer active/.test(x))).toHaveLength(1);
  });

  it("shows the admin's validation message with Fix, and frees the draft for another try", async () => {
    const t = setup({
      createDraftEvent: async () => ({
        ok: false,
        status: 400,
        message: "End date & time must be after start date & time",
      }),
    });
    const id = await readyDraft(t);
    const result = await t.send(modalSubmit(`evt:modal:${id}`, GOOD));
    await result.background?.();

    const [, , followUp] = t.discord.interactions.followUp.mock.calls[0]!;
    expect(followUp.content).toBe("⚠️ End date & time must be after start date & time");
    expect(followUp.flags & MessageFlags.Ephemeral).toBeTruthy();
    expect(followUp.components[0].components[0].custom_id).toBe(`evt:fix:${id}`);
    expect(t.rows.get(id)!.status).toBe("pending");
  });

  it("reports an admin outage, tells the exec, and frees the draft", async () => {
    const t = setup({
      createDraftEvent: async () => Promise.reject(new Error("Admin API returned 503")),
    });
    const id = await readyDraft(t);
    const result = await t.send(modalSubmit(`evt:modal:${id}`, GOOD));
    await result.background?.();

    expect(t.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ route: "discord:event-bot", step: "create" }),
      "error"
    );
    expect(t.discord.interactions.followUp.mock.calls[0]![2].content).toMatch(
      /Couldn't create the event/
    );
    expect(t.rows.get(id)!.status).toBe("pending");
  });

  it("submitted from [Fix], closes the ephemeral message and edits the card with the bot token", async () => {
    const t = setup();
    const id = await readyDraft(t);
    const result = await t.send(modalSubmit(`evt:modal:${id}`, GOOD, "ephemeral-error-message"));
    await result.background?.();

    expect(t.discord.interactions.editReply.mock.calls.at(-1)![2].content).toMatch(
      /card in the thread has been updated/
    );
    const [channelId, messageId, card] = t.discord.channels.editMessage.mock.calls[0]!;
    expect([channelId, messageId]).toEqual([THREAD, "card-1"]);
    expect(card.content).toMatch(/Draft created by/);
  });
});
