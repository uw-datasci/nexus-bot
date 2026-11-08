import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import {
  SettingsError,
  parseGuildSettings,
  type GuildSettings,
  type Registry,
} from "@nexus-bot/core";
import { REPO_ROOT } from "./env";

/**
 * config/guilds.yaml (gitignored; config/guilds.example.yaml is the template): which guilds the
 * bot serves and the settings seeded into discord.settings for each. IDs only, never secrets.
 */

export const DEFAULT_CONFIG_PATH = path.join(REPO_ROOT, "config", "guilds.yaml");

export interface GuildConfig {
  name: string;
  id: string;
  /** Raw key/values, exactly as they'll be stored. */
  settings: Record<string, unknown>;
  parsed: GuildSettings;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid guild config:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseGuildsConfig(text: string): GuildConfig[] {
  const doc: unknown = parse(text);
  if (!isObject(doc) || !Array.isArray(doc.guilds))
    throw new ConfigError(["the file needs a top-level `guilds:` list"]);

  const problems: string[] = [];
  const guilds: GuildConfig[] = [];
  const seen = new Set<string>();

  doc.guilds.forEach((entry: unknown, i: number) => {
    const label = isObject(entry) && typeof entry.name === "string" ? entry.name : `guilds[${i}]`;
    if (!isObject(entry)) return void problems.push(`${label}: must be a mapping`);
    if (typeof entry.id === "number") {
      // An unquoted 18-digit ID is read as a float and silently loses its last digits.
      return void problems.push(
        `${label}: quote the guild ID ("${entry.id}" may already be wrong)`
      );
    }
    if (typeof entry.id !== "string") return void problems.push(`${label}: \`id\` is required`);
    if (seen.has(entry.id))
      return void problems.push(`${label}: guild ${entry.id} is listed twice`);
    seen.add(entry.id);
    if (!isObject(entry.settings))
      return void problems.push(`${label}: \`settings\` must be a mapping`);

    try {
      const parsed = parseGuildSettings(entry.id, entry.settings);
      guilds.push({ name: label, id: entry.id, settings: entry.settings, parsed });
    } catch (error) {
      if (!(error instanceof SettingsError)) throw error;
      problems.push(...error.problems.map((problem) => `${label}: ${problem}`));
    }
  });

  if (problems.length > 0) throw new ConfigError(problems);
  return guilds;
}

export function readGuildsConfig(
  file = process.env.GUILDS_CONFIG ?? DEFAULT_CONFIG_PATH
): GuildConfig[] {
  if (!fs.existsSync(file)) {
    console.error(
      `${path.relative(process.cwd(), file)} not found. Copy config/guilds.example.yaml to config/guilds.yaml and fill in your IDs.`
    );
    process.exit(1);
  }
  return parseGuildsConfig(fs.readFileSync(file, "utf8"));
}

/** Each guild's full command set, as register-commands will send it (a bulk overwrite). */
export function registrationPlan(guilds: GuildConfig[], registry: Registry) {
  return guilds.map((guild) => ({ guild, commands: registry.commandsFor(guild.parsed.kind) }));
}
