import type { feedback } from "@nexus-bot/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "./connection";
import { FeedbackDraftRepository } from "./feedback-drafts.repository";
import { migrate } from "./migrate";

/** discord.feedback_drafts against a real Postgres (TEST_DATABASE_URL; skipped without it). */
const url = process.env.TEST_DATABASE_URL;

const item = (title: string): feedback.FeedbackItem => ({
  title,
  type: "nit",
  page: "/apply",
  verbatim: "the button is 2px off 😅",
  restatement: "Align the button.",
  sources: ["https://discord.com/channels/1/2/3"],
  screenshots: [],
  environment: null,
  dropped: false,
  issue: null,
});

describe.skipIf(!url)("FeedbackDraftRepository", () => {
  let db: Db;
  let drafts: FeedbackDraftRepository;
  const create = (channel = "c1", items = [item("a"), item("b")]) =>
    drafts.create({
      guild_id: "g",
      channel_id: channel,
      runner_discord_id: "u1",
      app: "cxc",
      mode: "thread",
      items,
      sources: ["https://discord.com/channels/1/2/3"],
      public_repo: true,
    });

  beforeAll(async () => {
    db = createDb(url!);
    await db`DROP SCHEMA IF EXISTS discord CASCADE`;
    await migrate(db);
    drafts = new FeedbackDraftRepository(db);
  });

  beforeEach(async () => {
    await db`TRUNCATE discord.feedback_drafts`;
  });

  afterAll(async () => {
    await db?.end();
  });

  it("stores items as JSON, pending, expiring in an hour", async () => {
    const draft = await create();
    expect(draft).toMatchObject({ status: "pending", mode: "thread", message_id: null });
    expect(draft.items.map((i) => i.title)).toEqual(["a", "b"]);
    expect(draft.items[0]?.verbatim).toBe("the button is 2px off 😅");
    expect(draft.expires_at.getTime() - draft.created_at.getTime()).toBeCloseTo(3_600_000, -3);

    const edited = await drafts.updateItems(draft.id, [{ ...item("a"), dropped: true }]);
    expect(edited?.items).toHaveLength(1);
    expect(edited?.items[0]?.dropped).toBe(true);
  });

  it("finds the newest card in a channel", async () => {
    expect(await drafts.lastCardMessageId("c1")).toBeNull();
    const older = await create("c1");
    await drafts.setCardMessage(older.id, "m1");
    await db`UPDATE discord.feedback_drafts SET created_at = now() - interval '5 minutes' WHERE id = ${older.id}`;
    const newer = await create("c1");
    await drafts.setCardMessage(newer.id, "m2");
    await create("c1"); // no card yet
    await drafts.setCardMessage((await create("c2")).id, "m9");
    expect(await drafts.lastCardMessageId("c1")).toBe("m2");
  });

  it("lets only one Create claim a draft, never an expired one, and keeps filed issues", async () => {
    const draft = await create();
    const [a, b] = await Promise.all([
      drafts.claimForCreating(draft.id),
      drafts.claimForCreating(draft.id),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await drafts.updateItems(draft.id, [])).toBeNull(); // not while creating

    await drafts.setItemIssue(draft.id, 1, { number: 13, url: "https://github.com/o/r/issues/13" });
    const released = await drafts.releaseClaim(draft.id);
    expect(released?.status).toBe("pending");
    expect(released?.items.map((i) => i.issue?.number ?? null)).toEqual([null, 13]);

    await drafts.claimForCreating(draft.id);
    expect((await drafts.markCreated(draft.id))?.status).toBe("created");
    expect(await drafts.cancel(draft.id)).toBeNull();

    const expired = await create();
    await db`UPDATE discord.feedback_drafts SET expires_at = now() - interval '1 second' WHERE id = ${expired.id}`;
    expect(await drafts.claimForCreating(expired.id)).toBeNull();
  });

  it("ignores an issue for an item that doesn't exist", async () => {
    const draft = await create("c1", [item("only")]);
    await drafts.setItemIssue(draft.id, 5, { number: 1, url: "x" });
    expect((await drafts.getById(draft.id))?.items).toHaveLength(1);
  });

  it("rejects modes and statuses the code doesn't have", async () => {
    const draft = await create();
    await expect(
      db`UPDATE discord.feedback_drafts SET status = 'done' WHERE id = ${draft.id}`
    ).rejects.toThrow();
    await expect(
      db`UPDATE discord.feedback_drafts SET mode = 'dm' WHERE id = ${draft.id}`
    ).rejects.toThrow();
  });
});
