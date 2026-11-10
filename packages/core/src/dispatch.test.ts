import {
  ApplicationCommandType,
  InteractionResponseType,
  InteractionType,
  reply,
  type APIInteraction,
} from "@nexus-bot/discord";
import { describe, expect, it, vi } from "vitest";
import { MESSAGES, dispatch } from "./dispatch";
import { registry as realRegistry } from "./features";
import { createRegistry } from "./registry";
import type { FeatureModule } from "./types";
import { EXEC_ROLE, button, command, deps, modalSubmit, settings } from "./test-helpers";

const content = (result: { response: unknown }) =>
  (result.response as { data?: { content?: string } }).data?.content;

/** A feature written the way a real one would be, with one of each handler kind. */
function testFeature() {
  const calls: string[] = [];
  const feature: FeatureModule = {
    name: "demo",
    guilds: ["exec"],
    commands: [
      {
        definition: { name: "demo", description: "Demo", type: ApplicationCommandType.ChatInput },
        capability: "event.create",
        handle: () => {
          calls.push("command");
          return {
            response: reply("from command"),
            background: async () => void calls.push("background"),
          };
        },
      },
    ],
    components: {
      approve: {
        capability: "event.create",
        handle: (i) => (calls.push(`approve ${i.data.custom_id}`), { response: reply("approved") }),
      },
    },
    modals: {
      submit: {
        capability: "event.create",
        handle: () => (calls.push("modal"), { response: reply("submitted") }),
      },
    },
  };
  return { feature, calls };
}

describe("dispatch", () => {
  it("answers PING with PONG, before anything else", async () => {
    const { deps: d } = deps(realRegistry, {
      loadSettings: () => Promise.reject(new Error("not called")),
    });
    const result = await dispatch({ type: InteractionType.Ping } as APIInteraction, d);
    expect(result.response).toEqual({ type: InteractionResponseType.Pong });
  });

  it("answers /ping from the real registry", async () => {
    const { deps: d } = deps(realRegistry);
    expect(content(await dispatch(command("ping"), d))).toMatch(/^Pong!/);
  });

  it("routes a new feature's command, components and modals with no other wiring", async () => {
    const { feature, calls } = testFeature();
    const { deps: d } = deps(createRegistry([feature]));

    const result = await dispatch(command("demo", [EXEC_ROLE]), d);
    expect(content(result)).toBe("from command");
    await result.background?.();
    expect(content(await dispatch(button("demo:approve:42", [EXEC_ROLE]), d))).toBe("approved");
    expect(content(await dispatch(modalSubmit("demo:submit:", [EXEC_ROLE]), d))).toBe("submitted");
    expect(calls).toEqual(["command", "background", "approve demo:approve:42", "modal"]);
  });

  it("checks the gate for commands and components", async () => {
    const { feature, calls } = testFeature();
    const { deps: d } = deps(createRegistry([feature]));
    expect(content(await dispatch(command("demo", []), d))).toMatch(/permission/);
    expect(content(await dispatch(button("demo:approve:1", ["999999999999999999"]), d))).toMatch(
      /permission/
    );
    expect(calls).toEqual([]);
  });

  it("explains unknown commands, stale buttons and guilds that aren't set up", async () => {
    const { feature } = testFeature();
    const { deps: d } = deps(createRegistry([feature]));
    expect(content(await dispatch(command("gone"), d))).toBe(MESSAGES.unknownCommand);
    expect(content(await dispatch(button("demo:nope:1"), d))).toBe(MESSAGES.staleComponent);
    expect(content(await dispatch(button("other:approve:1"), d))).toBe(MESSAGES.staleComponent);
    expect(content(await dispatch(button("not-a-custom-id"), d))).toBe(MESSAGES.staleComponent);

    const elsewhere = { ...command("demo"), guild_id: "100000000000000099" } as APIInteraction;
    expect(content(await dispatch(elsewhere, d))).toBe(MESSAGES.notSetUp);
    const dm = {
      ...command("demo"),
      guild_id: undefined,
      member: undefined,
    } as unknown as APIInteraction;
    expect(content(await dispatch(dm, d))).toBe(MESSAGES.noGuild);
  });

  it("keeps a feature to the guild kinds it's for", async () => {
    const { feature } = testFeature();
    const { deps: d } = deps(createRegistry([feature]), {
      loadSettings: async () => settings({ kind: "public" }),
    });
    expect(content(await dispatch(command("demo", [EXEC_ROLE]), d))).toBe(MESSAGES.unavailable);
  });

  it("reports a handler error after replying, and background errors too", async () => {
    const boom = new Error("boom");
    const feature: FeatureModule = {
      name: "bad",
      guilds: ["exec"],
      commands: [
        {
          definition: { name: "throws", description: "x" },
          capability: "ping",
          handle: () => {
            throw boom;
          },
        },
        {
          definition: { name: "later", description: "x" },
          capability: "ping",
          handle: () => ({ response: reply("ok"), background: () => Promise.reject(boom) }),
        },
      ],
    };
    const { deps: d, reportError } = deps(createRegistry([feature]));

    const thrown = await dispatch(command("throws"), d);
    expect(content(thrown)).toBe(MESSAGES.failed);
    expect(reportError).not.toHaveBeenCalled();
    await thrown.background?.();
    expect(reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({ feature: "bad", interaction: "/throws" })
    );

    const later = await dispatch(command("later"), d);
    await expect(later.background?.()).resolves.toBeUndefined();
    expect(reportError).toHaveBeenLastCalledWith(
      boom,
      expect.objectContaining({ phase: "background" })
    );
  });

  it("answers autocomplete with no choices", async () => {
    const { deps: d } = deps(realRegistry);
    const result = await dispatch(
      { type: InteractionType.ApplicationCommandAutocomplete } as APIInteraction,
      d
    );
    expect(result.response).toEqual({
      type: InteractionResponseType.ApplicationCommandAutocompleteResult,
      data: { choices: [] },
    });
  });

  it("lets infrastructure errors, like the settings load failing, reach the transport", async () => {
    // Settings failures are infrastructure errors: they propagate to the transport (Raft's route
    // wrapper), which answers 500 and reports them.
    const { deps: d } = deps(realRegistry, {
      loadSettings: vi.fn().mockRejectedValue(new Error("db down")),
    });
    await expect(dispatch(command("ping"), d)).rejects.toThrow("db down");
  });
});
