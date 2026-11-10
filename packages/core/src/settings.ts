/**
 * Per-guild settings, stored as key/value rows in `discord.settings` and seeded from
 * config/guilds.yaml. This file owns what the keys mean; packages/db only stores them.
 *
 * Known keys:
 *   kind                     "exec" | "public": which command set and features the guild gets
 *   require_linked_accounts  false until B2; see gate.ts
 *   role_ids                 { exec?: [...], admin?: [...], pres?: [...] } Discord role IDs that
 *                            stand for each website role while accounts aren't linked
 *   feedback_apps            { <app>: { repo, production_url, role_sets, channels? } } apps that
 *                            take /feedback; see FeedbackApp
 * Any other key is kept as-is in `values` for the features that use it.
 */

export const GUILD_KINDS = ["exec", "public"] as const;
export type GuildKind = (typeof GUILD_KINDS)[number];

/** Website roles (`public.user_roles`) that grant bot capabilities. `admin` is a VP. */
export const WEBSITE_ROLES = ["exec", "admin", "pres"] as const;
export type WebsiteRole = (typeof WEBSITE_ROLES)[number];

/** An app that takes /feedback, from the guild's `feedback_apps` setting. */
export interface FeedbackApp {
  /** The key in `feedback_apps`, e.g. `cxc`. */
  name: string;
  /** `owner/name` of the GitHub repo the issues go to. */
  repo: string;
  /** e.g. https://cxc.uwdatascience.ca: a page URL on this host means Production. */
  productionUrl: string;
  /** Who may send feedback: any one set is enough, and every role in that set is needed. */
  roleSets: string[][];
  /** Channels (or threads under them) it can be used in. Empty means anywhere. */
  channels: string[];
}

export interface GuildSettings {
  guildId: string;
  kind: GuildKind;
  requireLinkedAccounts: boolean;
  roleIds: Partial<Record<WebsiteRole, string[]>>;
  feedbackApps: Record<string, FeedbackApp>;
  /** Every key, including the ones above, as stored. */
  values: Record<string, unknown>;
}

export class SettingsError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid guild settings:\n- ${problems.join("\n- ")}`);
    this.name = "SettingsError";
  }
}

const SNOWFLAKE = /^\d{17,20}$/;
const APP_NAME = /^[a-z0-9-]{1,32}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isIdList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((id) => typeof id === "string" && SNOWFLAKE.test(id));

function parseFeedbackApps(raw: unknown, problems: string[]): Record<string, FeedbackApp> {
  const apps: Record<string, FeedbackApp> = {};
  if (raw === undefined) return apps;
  if (!isObject(raw)) {
    problems.push("`feedback_apps` must map app names to their settings");
    return apps;
  }
  for (const [name, app] of Object.entries(raw)) {
    const at = `\`feedback_apps.${name}\``;
    if (!APP_NAME.test(name)) problems.push(`${at}: app names are lowercase letters, digits and -`);
    if (!isObject(app)) {
      problems.push(`${at} must be a mapping`);
      continue;
    }
    const before = problems.length;
    if (typeof app.repo !== "string" || !REPO.test(app.repo))
      problems.push(`${at}.repo must be "owner/name"`);
    let productionUrl = "";
    try {
      const url = new URL(String(app.production_url));
      if (url.protocol !== "https:") throw new Error("not https");
      productionUrl = url.origin;
    } catch {
      problems.push(`${at}.production_url must be an https URL`);
    }
    const roleSets = app.role_sets;
    if (
      !Array.isArray(roleSets) ||
      roleSets.length === 0 ||
      !roleSets.every((set) => isIdList(set) && set.length > 0)
    ) {
      problems.push(
        `${at}.role_sets must be a list of role ID lists, e.g. [["<team>"], ["<VP>", "<Design>"]], as quoted strings`
      );
    }
    const channels = app.channels ?? [];
    if (!isIdList(channels)) problems.push(`${at}.channels must be a list of channel IDs`);
    if (problems.length > before) continue;
    apps[name] = {
      name,
      repo: app.repo as string,
      productionUrl,
      roleSets: roleSets as string[][],
      channels: channels as string[],
    };
  }
  return apps;
}

/** Validate a guild's raw key/value settings. Throws SettingsError listing every problem. */
export function parseGuildSettings(guildId: string, raw: Record<string, unknown>): GuildSettings {
  const problems: string[] = [];
  if (!SNOWFLAKE.test(guildId)) problems.push(`guild ID "${guildId}" isn't a Discord ID`);

  const kind = raw.kind;
  if (!GUILD_KINDS.includes(kind as GuildKind))
    problems.push(`\`kind\` must be one of ${GUILD_KINDS.join(", ")}`);

  const requireLinked = raw.require_linked_accounts ?? false;
  if (typeof requireLinked !== "boolean")
    problems.push("`require_linked_accounts` must be true or false");

  const roleIds: Partial<Record<WebsiteRole, string[]>> = {};
  const rawRoles = raw.role_ids ?? {};
  if (typeof rawRoles !== "object" || rawRoles === null || Array.isArray(rawRoles)) {
    problems.push("`role_ids` must map website roles to lists of Discord role IDs");
  } else {
    for (const [role, ids] of Object.entries(rawRoles)) {
      if (!WEBSITE_ROLES.includes(role as WebsiteRole)) {
        problems.push(`\`role_ids.${role}\` isn't a website role (${WEBSITE_ROLES.join(", ")})`);
      } else if (
        !Array.isArray(ids) ||
        !ids.every((id) => typeof id === "string" && SNOWFLAKE.test(id))
      ) {
        problems.push(`\`role_ids.${role}\` must be a list of Discord role IDs, as quoted strings`);
      } else {
        roleIds[role as WebsiteRole] = ids;
      }
    }
  }

  const feedbackApps = parseFeedbackApps(raw.feedback_apps, problems);

  if (problems.length > 0) throw new SettingsError(problems);
  return {
    guildId,
    kind: kind as GuildKind,
    requireLinkedAccounts: requireLinked as boolean,
    roleIds,
    feedbackApps,
    values: { ...raw },
  };
}
