import {
  ApplicationCommandType,
  ComponentType,
  InteractionType,
  type API,
  type APIInteraction,
} from "@nexus-bot/discord";
import { vi } from "vitest";
import type { DispatchDeps } from "./dispatch";
import type { Registry } from "./registry";
import type { Services } from "./services";
import { parseGuildSettings, type GuildSettings } from "./settings";

export const GUILD = "100000000000000001";
export const EXEC_ROLE = "200000000000000001";
export const VP_ROLE = "200000000000000002";
// Created at 2026-11-08 or so; the exact value only matters to /ping's latency.
export const INTERACTION_ID = "1436700000000000000";

export const settings = (raw: Record<string, unknown> = {}): GuildSettings =>
  parseGuildSettings(GUILD, {
    kind: "exec",
    role_ids: { exec: [EXEC_ROLE], admin: [VP_ROLE] },
    ...raw,
  });

const base = (roles: string[] = []) => ({
  id: INTERACTION_ID,
  application_id: "app",
  token: "token",
  version: 1,
  guild_id: GUILD,
  channel_id: "300000000000000001",
  member: { user: { id: "400000000000000001", username: "someone" }, roles },
  locale: "en-US",
  app_permissions: "0",
  entitlements: [],
  authorizing_integration_owners: {},
  attachment_size_limit: 0,
});

export const command = (name: string, roles?: string[]) =>
  ({
    ...base(roles),
    type: InteractionType.ApplicationCommand,
    data: { id: "1", name, type: ApplicationCommandType.ChatInput },
  }) as unknown as APIInteraction;

export const button = (customId: string, roles?: string[]) =>
  ({
    ...base(roles),
    type: InteractionType.MessageComponent,
    message: {},
    data: { custom_id: customId, component_type: ComponentType.Button },
  }) as unknown as APIInteraction;

export const modalSubmit = (customId: string, roles?: string[]) =>
  ({
    ...base(roles),
    type: InteractionType.ModalSubmit,
    data: { custom_id: customId, components: [] },
  }) as unknown as APIInteraction;

export function deps(registry: Registry, overrides: Partial<DispatchDeps> = {}) {
  const reportError = vi.fn().mockResolvedValue(undefined);
  return {
    reportError,
    deps: {
      registry,
      loadSettings: async (id: string) => (id === GUILD ? settings() : null),
      discord: {} as API,
      applicationId: "app",
      reportError,
      services: {} as Services,
      now: () => 0,
      ...overrides,
    } satisfies DispatchDeps,
  };
}
