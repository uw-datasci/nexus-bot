import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "./connection";
import { EventDraftRepository } from "./event-drafts.repository";
import { migrate } from "./migrate";

/** discord.event_drafts against a real Postgres (TEST_DATABASE_URL; skipped without it). */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("EventDraftRepository", () => {
  let db: Db;
  let drafts: EventDraftRepository;
  const run = (initiator = "u1", channel = "c1") =>
    drafts.startRun({ initiator_discord_id: initiator, guild_id: "g", channel_id: channel });

  beforeAll(async () => {
    db = createDb(url!);
    await db`DROP SCHEMA IF EXISTS discord CASCADE`;
    await migrate(db);
    drafts = new EventDraftRepository(db);
  });

  beforeEach(async () => {
    await db`TRUNCATE discord.event_drafts`;
  });

  afterAll(async () => {
    await db?.end();
  });

  it("starts a pending run that expires in an hour, and stores the extraction", async () => {
    const draft = await run();
    expect(draft).toMatchObject({
      status: "pending",
      initiator_discord_id: "u1",
      message_id: null,
      category: null,
    });
    expect(draft.expires_at.getTime() - draft.created_at.getTime()).toBeCloseTo(60 * 60 * 1000, -3);

    const extracted = await drafts.setExtracted(draft.id, {
      name: "Intro to SQL",
      location: "MC 4020",
      description: "Bring a laptop 💻",
      start_time: "2026-11-20T23:00:00.000Z",
      end_time: "2026-11-21T01:00:00.000Z",
      category: "workshop",
    });
    expect(extracted).toMatchObject({ name: "Intro to SQL", category: "workshop" });
    expect(extracted.start_time).toEqual(new Date("2026-11-20T23:00:00.000Z"));

    await drafts.setCardMessage(draft.id, "c1", "m1");
    expect((await drafts.getById(draft.id))?.message_id).toBe("m1");
  });

  it("counts runs per exec within the hour and per thread within the minute, failed runs included", async () => {
    const first = await run("u1", "c1");
    await drafts.cancel(first.id); // a failed run still counts
    await run("u1", "c2");
    await run("u2", "c1");
    await db`UPDATE discord.event_drafts SET created_at = now() - interval '2 minutes' WHERE channel_id = 'c2'`;
    await run("u1", "c3");
    await db`UPDATE discord.event_drafts SET created_at = now() - interval '2 hours' WHERE channel_id = 'c3'`;

    expect(await drafts.countRecentRuns("u1", "c1", 3600, 60)).toEqual({
      by_initiator: 2,
      by_channel: 2,
    });
    expect(await drafts.countRecentRuns("u1", "c2", 3600, 60)).toEqual({
      by_initiator: 2,
      by_channel: 0,
    });
    expect(await drafts.countRecentRuns("u9", "c9", 3600, 60)).toEqual({
      by_initiator: 0,
      by_channel: 0,
    });
  });

  it("lets only one submit claim a draft, and never an expired one", async () => {
    const draft = await run();
    const [a, b] = await Promise.all([
      drafts.claimForCreation(draft.id),
      drafts.claimForCreation(draft.id),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);

    await drafts.releaseClaim(draft.id);
    expect((await drafts.getById(draft.id))?.status).toBe("pending");
    expect(await drafts.claimForCreation(draft.id)).not.toBeNull();
    await drafts.setCreatedEvent(draft.id, "00000000-0000-4000-8000-000000000001");
    await drafts.releaseClaim(draft.id); // no-op once the event exists
    expect((await drafts.getById(draft.id))?.status).toBe("created");

    const expired = await run();
    await db`UPDATE discord.event_drafts SET expires_at = now() - interval '1 second' WHERE id = ${expired.id}`;
    expect(await drafts.claimForCreation(expired.id)).toBeNull();
  });

  it("only changes pending drafts", async () => {
    const draft = await run();
    expect((await drafts.updateCategory(draft.id, "social"))?.category).toBe("social");
    expect(await drafts.cancel(draft.id)).not.toBeNull();
    expect(await drafts.cancel(draft.id)).toBeNull();
    expect(await drafts.updateCategory(draft.id, "academic")).toBeNull();
    await drafts.saveSubmission(draft.id, {
      name: "x",
      location: "y",
      start: "s",
      end: "e",
      description: "d",
    });
    expect((await drafts.getById(draft.id))?.submitted_name).toBeNull();
  });

  it("rejects values the website's enums wouldn't allow", async () => {
    const draft = await run();
    await expect(
      db`UPDATE discord.event_drafts SET category = 'party' WHERE id = ${draft.id}`
    ).rejects.toThrow();
    await expect(
      db`UPDATE discord.event_drafts SET status = 'done' WHERE id = ${draft.id}`
    ).rejects.toThrow();
  });
});
