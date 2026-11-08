import { describe, expect, it } from "vitest";
import { formatCustomId, parseCustomId } from "./custom-id";
import { ephemeral, reply } from "./responses";
import { MessageFlags } from "discord-api-types/v10";

describe("custom_id", () => {
  it("round-trips, and the id may contain colons", () => {
    expect(formatCustomId("evt", "review", "42")).toBe("evt:review:42");
    expect(parseCustomId("evt:review:42")).toEqual({ feature: "evt", action: "review", id: "42" });
    expect(parseCustomId("fb:open:a:b")).toEqual({ feature: "fb", action: "open", id: "a:b" });
    expect(parseCustomId("ping:again:")).toEqual({ feature: "ping", action: "again", id: "" });
  });

  it("rejects ids that aren't in the format", () => {
    for (const bad of ["", "evt", "evt:review", ":review:1", "e v t:review:1"])
      expect(parseCustomId(bad)).toBeNull();
    expect(() => formatCustomId("evt:x", "review")).toThrow(/feature/);
    expect(() => formatCustomId("evt", "review", "x".repeat(100))).toThrow(/100/);
  });
});

describe("responses", () => {
  it("never pings by default, and ephemeral sets the flag", () => {
    expect(reply("hi")).toEqual({
      type: 4,
      data: { content: "hi", allowed_mentions: { parse: [] } },
    });
    expect((ephemeral("no") as { data?: unknown }).data).toMatchObject({
      flags: MessageFlags.Ephemeral,
    });
  });
});
