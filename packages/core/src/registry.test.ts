import { ApplicationCommandType, InteractionContextType } from "@nexus-bot/discord";
import { describe, expect, it } from "vitest";
import { registry as realRegistry } from "./features";
import { can } from "./gate";
import { RegistryError, createRegistry } from "./registry";
import { SettingsError, parseGuildSettings } from "./settings";
import { EXEC_ROLE, GUILD, VP_ROLE, settings } from "./test-helpers";
import type { FeatureModule } from "./types";

const feature = (
  name: string,
  commandName: string,
  guilds: FeatureModule["guilds"] = ["exec"]
): FeatureModule => ({
  name,
  guilds,
  commands: [
    {
      definition: { name: commandName, description: "x", type: ApplicationCommandType.ChatInput },
      capability: "ping",
      handle: () => ({ response: { type: 1 } }),
    },
  ],
});

describe("registry", () => {
  it("rejects clashing feature and command names", () => {
    expect(() => createRegistry([feature("a", "one"), feature("a", "two")])).toThrow(RegistryError);
    expect(() => createRegistry([feature("a", "same"), feature("b", "same")])).toThrow(
      /both a and b/
    );
    expect(() => createRegistry([feature("Bad Name", "x")])).toThrow(/Invalid feature name/);
    expect(() => createRegistry([feature("a", "Upper")])).toThrow(/Invalid command name/);
  });

  it("gives each guild kind its own command set, as guild-only commands", () => {
    const registry = createRegistry([
      feature("a", "exec-only"),
      feature("b", "everywhere", ["exec", "public"]),
    ]);
    expect(registry.commandsFor("exec").map((c) => c.name)).toEqual(["exec-only", "everywhere"]);
    expect(registry.commandsFor("public").map((c) => c.name)).toEqual(["everywhere"]);
    expect(registry.commandsFor("exec")[0]).toMatchObject({
      contexts: [InteractionContextType.Guild],
    });
  });

  it("registers message commands next to slash commands, unique per type", () => {
    const withMessage = (name: string, commandName: string): FeatureModule => ({
      ...feature(name, `${name}-cmd`),
      messageCommands: [
        {
          definition: { name: commandName, type: ApplicationCommandType.Message },
          capability: "ping",
          handle: () => ({ response: { type: 1 } }),
        },
      ],
    });
    const registry = createRegistry([withMessage("a", "Send as thing")]);
    expect(registry.commandsFor("exec").map((c) => [c.name, c.type])).toEqual([
      ["a-cmd", ApplicationCommandType.ChatInput],
      ["Send as thing", ApplicationCommandType.Message],
    ]);
    expect(registry.messageCommand("Send as thing")?.module.name).toBe("a");
    expect(registry.command("Send as thing")).toBeNull();
    expect(() => createRegistry([withMessage("a", "Same"), withMessage("b", "Same")])).toThrow(
      /Message command "Same" is defined by both a and b/
    );
    expect(() => createRegistry([withMessage("a", "x".repeat(33))])).toThrow(
      /Invalid message command name/
    );
  });

  it("registers /ping for the exec server only", () => {
    expect(realRegistry.commandsFor("exec").map((c) => c.name)).toContain("ping");
    expect(realRegistry.commandsFor("public")).toEqual([]);
  });
});

describe("settings", () => {
  it("parses the known keys and keeps the rest", () => {
    const parsed = parseGuildSettings(GUILD, {
      kind: "exec",
      role_ids: { exec: [EXEC_ROLE] },
      forum_tags: { a: 1 },
    });
    expect(parsed).toMatchObject({
      kind: "exec",
      requireLinkedAccounts: false,
      roleIds: { exec: [EXEC_ROLE] },
    });
    expect(parsed.values.forum_tags).toEqual({ a: 1 });
  });

  it("lists every problem", () => {
    try {
      parseGuildSettings("nope", {
        kind: "server",
        require_linked_accounts: "no",
        role_ids: { exec: [123], founder: [] },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SettingsError);
      expect((error as SettingsError).problems).toHaveLength(5);
    }
  });
});

describe("feedback_apps", () => {
  const ROLE = "200000000000000009";
  const app = (overrides: Record<string, unknown> = {}) => ({
    repo: "uw-datasci/cxc",
    production_url: "https://cxc.uwdatascience.ca/",
    role_sets: [[ROLE], [EXEC_ROLE, VP_ROLE]],
    ...overrides,
  });

  it("parses each app, with no channels meaning anywhere", () => {
    const parsed = settings({ feedback_apps: { cxc: app() } });
    expect(parsed.feedbackApps).toEqual({
      cxc: {
        name: "cxc",
        repo: "uw-datasci/cxc",
        productionUrl: "https://cxc.uwdatascience.ca",
        roleSets: [[ROLE], [EXEC_ROLE, VP_ROLE]],
        channels: [],
      },
    });
    expect(settings().feedbackApps).toEqual({});
  });

  it("lists every problem with an app", () => {
    try {
      settings({
        feedback_apps: {
          Bad: app({
            repo: "cxc",
            production_url: "http://cxc.uwdatascience.ca",
            role_sets: [[]],
            channels: [1],
          }),
        },
      });
      expect.unreachable();
    } catch (error) {
      expect((error as SettingsError).problems).toEqual([
        expect.stringMatching(/feedback_apps.Bad.*lowercase/),
        expect.stringMatching(/repo must be "owner\/name"/),
        expect.stringMatching(/production_url must be an https URL/),
        expect.stringMatching(/role_sets must be a list of role ID lists/),
        expect.stringMatching(/channels must be a list of channel IDs/),
      ]);
    }
  });
});

describe("gate", () => {
  const actor = (roles: string[]) => ({ userId: "1", roles });

  it("lets anyone ping", () => {
    expect(can(actor([]), "ping", settings())).toEqual({ allowed: true });
  });

  it("maps Discord roles to website roles while accounts aren't linked", () => {
    expect(can(actor([EXEC_ROLE]), "event.create", settings()).allowed).toBe(true);
    expect(can(actor([EXEC_ROLE]), "support.reply", settings()).allowed).toBe(false);
    expect(can(actor([VP_ROLE]), "support.reply", settings()).allowed).toBe(true);
    expect(can(actor(["999999999999999999"]), "event.create", settings()).allowed).toBe(false);
  });

  it("denies everything but ping once require_linked_accounts is on (B2 adds the checks)", () => {
    const linked = settings({ require_linked_accounts: true });
    expect(can(actor([EXEC_ROLE]), "event.create", linked)).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/Linked accounts/),
    });
    expect(can(actor([]), "ping", linked).allowed).toBe(true);
  });
});
