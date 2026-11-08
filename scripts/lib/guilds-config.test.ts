import fs from "node:fs";
import path from "node:path";
import { registry } from "@nexus-bot/core";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./env";
import { ConfigError, parseGuildsConfig, registrationPlan } from "./guilds-config";

const EXAMPLE = fs.readFileSync(path.join(REPO_ROOT, "config", "guilds.example.yaml"), "utf8");

describe("guilds config", () => {
  it("accepts the committed example", () => {
    const guilds = parseGuildsConfig(EXAMPLE);
    expect(guilds.map((g) => g.parsed.kind)).toEqual(["exec"]);
    expect(guilds[0]?.settings.require_linked_accounts).toBe(false);
  });

  it("refuses unquoted IDs, which YAML would round", () => {
    const text =
      "guilds:\n  - name: Exec\n    id: 123456789012345678\n    settings: { kind: exec }\n";
    expect(() => parseGuildsConfig(text)).toThrow(/quote the guild ID/);
  });

  it("lists every problem, labelled by guild", () => {
    const text = [
      "guilds:",
      "  - name: Exec",
      '    id: "123456789012345678"',
      "    settings: { kind: club, role_ids: { exec: [1] } }",
      "  - name: Again",
      '    id: "123456789012345678"',
      "    settings: { kind: exec }",
    ].join("\n");
    try {
      parseGuildsConfig(text);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).problems).toEqual([
        expect.stringMatching(/^Exec: `kind`/),
        expect.stringMatching(/^Exec: `role_ids.exec`/),
        expect.stringMatching(/^Again: guild .* listed twice/),
      ]);
    }
  });

  it("plans each guild's full command set from the registry", () => {
    const plan = registrationPlan(parseGuildsConfig(EXAMPLE), registry);
    expect(plan[0]?.commands.map((c) => c.name)).toEqual(["ping"]);
  });
});
