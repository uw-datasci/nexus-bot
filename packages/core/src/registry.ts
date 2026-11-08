import {
  ApplicationIntegrationType,
  InteractionContextType,
  parseCustomId,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "@nexus-bot/discord";
import type { GuildKind } from "./settings";
import type { Command, ComponentRoute, FeatureModule, ModalRoute } from "./types";

export interface Registry {
  readonly modules: readonly FeatureModule[];
  /** What `register-commands` sends for a guild of this kind (bulk overwrite). */
  commandsFor(kind: GuildKind): RESTPostAPIChatInputApplicationCommandsJSONBody[];
  command(name: string): { module: FeatureModule; command: Command } | null;
  component(customId: string): { module: FeatureModule; route: ComponentRoute; id: string } | null;
  modal(customId: string): { module: FeatureModule; route: ModalRoute; id: string } | null;
}

const MODULE_NAME = /^[a-z0-9_-]{1,20}$/;
const COMMAND_NAME = /^[-_\p{Ll}\p{N}]{1,32}$/u;

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

/** Collect feature modules. Throws on clashing names, so a bad module fails at startup and in CI. */
export function createRegistry(modules: readonly FeatureModule[]): Registry {
  const byName = new Map<string, FeatureModule>();
  const commands = new Map<string, { module: FeatureModule; command: Command }>();

  for (const module of modules) {
    if (!MODULE_NAME.test(module.name))
      throw new RegistryError(`Invalid feature name "${module.name}"`);
    if (byName.has(module.name)) throw new RegistryError(`Two features are named "${module.name}"`);
    byName.set(module.name, module);

    for (const command of module.commands ?? []) {
      const name = command.definition.name;
      if (!COMMAND_NAME.test(name))
        throw new RegistryError(`Invalid command name "/${name}" in ${module.name}`);
      const existing = commands.get(name);
      if (existing)
        throw new RegistryError(
          `/${name} is defined by both ${existing.module.name} and ${module.name}`
        );
      commands.set(name, { module, command });
    }
  }

  const route = <R>(
    customId: string,
    pick: (module: FeatureModule) => Readonly<Record<string, R>> | undefined
  ) => {
    const parsed = parseCustomId(customId);
    if (!parsed) return null;
    const module = byName.get(parsed.feature);
    const found = module ? pick(module)?.[parsed.action] : undefined;
    return module && found ? { module, route: found, id: parsed.id } : null;
  };

  return {
    modules,
    commandsFor: (kind) =>
      [...commands.values()]
        .filter(({ module }) => module.guilds.includes(kind))
        .map(({ command }) => ({
          // Guild commands only; features can override, e.g. default_member_permissions: "0".
          contexts: [InteractionContextType.Guild],
          integration_types: [ApplicationIntegrationType.GuildInstall],
          ...command.definition,
        })),
    command: (name) => commands.get(name) ?? null,
    component: (customId) => route(customId, (module) => module.components),
    modal: (customId) => route(customId, (module) => module.modals),
  };
}
