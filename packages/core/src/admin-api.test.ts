import { describe, expect, it, vi } from "vitest";
import { AdminApiError, createAdminApi, type DraftEventFields } from "./admin-api";

const FIELDS: DraftEventFields = {
  name: "Intro to SQL",
  description: "Bring a laptop",
  location: "MC 4020",
  start_time: "2026-11-20T23:00:00.000Z",
  end_time: "2026-11-21T01:00:00.000Z",
  category: "workshop",
  image_url: null,
  resources: [],
};

function api(status: number, body: unknown, options: { bypassToken?: string } = {}) {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  return {
    fetch,
    client: createAdminApi({
      baseUrl: "https://admin.test",
      token: "secret-token",
      fetch,
      ...options,
    }),
  };
}

describe("admin API: createDraftEvent", () => {
  it("posts the fields and the actor with the bearer token", async () => {
    const event = { id: "e1", ...FIELDS };
    const { fetch, client } = api(200, { event }, { bypassToken: "bypass" });
    expect(await client.createDraftEvent(FIELDS, { discordId: "123" })).toEqual({
      ok: true,
      event,
    });

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://admin.test/api/internal/events/drafts");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer secret-token",
      "x-vercel-protection-bypass": "bypass",
    });
    expect(JSON.parse(init.body)).toEqual({ ...FIELDS, actor_discord_id: "123" });
  });

  it("returns validation and permission problems with the admin's message", async () => {
    const invalid = api(400, {
      error: "Validation error",
      message: "End date & time must be after start date & time",
    });
    expect(await invalid.client.createDraftEvent(FIELDS, { discordId: "1" })).toEqual({
      ok: false,
      status: 400,
      message: "End date & time must be after start date & time",
    });
    const forbidden = api(403, {
      error: "Forbidden",
      message: "Only execs can create event drafts",
    });
    expect(await forbidden.client.createDraftEvent(FIELDS, { discordId: "1" })).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("throws on anything else, so it gets reported", async () => {
    for (const [status, body] of [
      [401, { error: "Unauthorized" }],
      [503, { error: "Internal API is not configured" }],
      [200, { nothing: true }],
    ] as const) {
      await expect(
        api(status, body).client.createDraftEvent(FIELDS, { discordId: "1" })
      ).rejects.toBeInstanceOf(AdminApiError);
    }
    const down = createAdminApi({
      baseUrl: "https://admin.test",
      token: "t",
      fetch: vi.fn().mockRejectedValue(new Error("ECONNRESET")),
    });
    await expect(down.createDraftEvent(FIELDS, { discordId: "1" })).rejects.toThrow(/ECONNRESET/);
  });
});
