/**
 * Per-guild settings, stored as key/value rows in `discord.settings` and seeded from
 * config/guilds.yaml. This file owns what the keys mean; packages/db only stores them.
 *
 * Known keys:
 *   kind                     "exec" | "public": which command set and features the guild gets
 *   require_linked_accounts  false until B2; see gate.ts
 *   role_ids                 { exec?: [...], admin?: [...], pres?: [...] } Discord role IDs that
 *                            stand for each website role while accounts aren't linked
 * Any other key is kept as-is in `values` for the features that use it.
 */

export const GUILD_KINDS = ["exec", "public"] as const;
export type GuildKind = (typeof GUILD_KINDS)[number];

/** Website roles (`public.user_roles`) that grant bot capabilities. `admin` is a VP. */
export const WEBSITE_ROLES = ["exec", "admin", "pres"] as const;
export type WebsiteRole = (typeof WEBSITE_ROLES)[number];

export interface GuildSettings {
  guildId: string;
  kind: GuildKind;
  requireLinkedAccounts: boolean;
  roleIds: Partial<Record<WebsiteRole, string[]>>;
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

  if (problems.length > 0) throw new SettingsError(problems);
  return {
    guildId,
    kind: kind as GuildKind,
    requireLinkedAccounts: requireLinked as boolean,
    roleIds,
    values: { ...raw },
  };
}
