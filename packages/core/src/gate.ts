import type { GuildSettings, WebsiteRole } from "./settings";

/**
 * The permission gate: `can(actor, capability, settings)`. Spec: nexus-bot Part 2 §6.
 *
 * Each capability names the website roles that may use it. Until B2 links Discord accounts to
 * website profiles (`require_linked_accounts = false`), the website role is inferred from the
 * member's Discord roles via the guild's `role_ids` setting, which generalizes today's
 * DISCORD_EXEC_ROLE_ID. With the flag on, B2 adds the linked-profile and role-sync checks.
 */

export const CAPABILITIES = {
  ping: "everyone",
  "event.create": ["exec", "admin", "pres"],
  summarize: ["exec", "admin", "pres"],
  ask: ["exec", "admin", "pres"],
  "support.claim": ["exec", "admin", "pres"],
  "support.reply": ["admin", "pres"],
  "announce.draft": ["exec", "admin"],
  "announce.approve": ["pres"],
  "access.request": ["exec", "admin", "pres"],
  // /feedback is per app, not per website role: the feature checks each app's `role_sets`
  // (settings `feedback_apps`), and the card's controls only work for whoever ran it.
  feedback: "everyone",
} as const satisfies Record<string, "everyone" | readonly WebsiteRole[]>;

export type Capability = keyof typeof CAPABILITIES;

export interface Actor {
  userId: string;
  /** The member's Discord role IDs in this guild. */
  roles: readonly string[];
}

export type GateResult =
  { allowed: true } | { allowed: false; code: "linked-accounts" | "role"; reason: string };

export function can(actor: Actor, capability: Capability, settings: GuildSettings): GateResult {
  const rule = CAPABILITIES[capability];
  if (rule === "everyone") return { allowed: true };

  if (settings.requireLinkedAccounts) {
    return {
      allowed: false,
      code: "linked-accounts",
      reason:
        "Linked accounts aren't supported yet. Ask the dev team to turn `require_linked_accounts` off.",
    };
  }

  const allowedRoleIds = new Set(rule.flatMap((role) => settings.roleIds[role] ?? []));
  if (actor.roles.some((id) => allowedRoleIds.has(id))) return { allowed: true };
  return { allowed: false, code: "role", reason: "You don't have permission to use this." };
}
