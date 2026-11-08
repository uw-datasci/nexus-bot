import {
  ApplicationCommandType,
  InteractionResponseType,
  InteractionType,
  ephemeral,
  pong,
  type API,
  type APIChatInputApplicationCommandInteraction,
  type APIInteraction,
} from "@nexus-bot/discord";
import { can, type Actor, type Capability } from "./gate";
import type { Registry } from "./registry";
import type { GuildSettings } from "./settings";
import type { FeatureModule, HandlerContext, HandlerResult, ReportError } from "./types";

export interface DispatchDeps {
  registry: Registry;
  /** The guild's settings, or null if the guild isn't set up (no rows in discord.settings). */
  loadSettings: (guildId: string) => Promise<GuildSettings | null>;
  discord: API;
  applicationId: string;
  reportError: ReportError;
  now?: () => number;
}

export const MESSAGES = {
  noGuild: "Use this in a server.",
  notSetUp: "This bot isn't set up for this server yet.",
  unknownCommand: "Unknown command. It may have been removed; try again in a minute.",
  staleComponent: "This button is no longer supported.",
  unavailable: "That isn't available in this server.",
  unsupported: "Unsupported interaction.",
  failed: "Something went wrong. The error has been logged for the dev team.",
} as const;

/**
 * Route one verified interaction to its feature, after the guild and permission checks. A failing
 * handler gets an ephemeral error reply and is reported; `background` errors are reported too, so
 * transports don't have to. Only infrastructure errors (loading settings) propagate.
 */
export async function dispatch(
  interaction: APIInteraction,
  deps: DispatchDeps
): Promise<HandlerResult> {
  if (interaction.type === InteractionType.Ping) return { response: pong() };
  if (interaction.type === InteractionType.ApplicationCommandAutocomplete) {
    return {
      response: {
        type: InteractionResponseType.ApplicationCommandAutocompleteResult,
        data: { choices: [] },
      },
    };
  }

  const guildId = interaction.guild_id;
  if (!guildId || !interaction.member) return { response: ephemeral(MESSAGES.noGuild) };

  const settings = await deps.loadSettings(guildId);
  if (!settings) return { response: ephemeral(MESSAGES.notSetUp) };

  const actor: Actor = { userId: interaction.member.user.id, roles: interaction.member.roles };
  const ctx: HandlerContext = {
    settings,
    discord: deps.discord,
    applicationId: deps.applicationId,
    reportError: deps.reportError,
    now: deps.now ?? Date.now,
  };

  type Target = {
    module: FeatureModule;
    capability: Capability;
    label: string;
    run: () => Promise<HandlerResult> | HandlerResult;
  };
  let target: Target | null = null;
  let missing: string = MESSAGES.unsupported;

  switch (interaction.type) {
    case InteractionType.ApplicationCommand: {
      missing = MESSAGES.unknownCommand;
      if (interaction.data.type !== ApplicationCommandType.ChatInput) break;
      const found = deps.registry.command(interaction.data.name);
      const chatInput = interaction as APIChatInputApplicationCommandInteraction;
      if (found) {
        target = {
          module: found.module,
          capability: found.command.capability,
          label: `/${interaction.data.name}`,
          run: () => found.command.handle(chatInput, ctx),
        };
      }
      break;
    }
    case InteractionType.MessageComponent: {
      missing = MESSAGES.staleComponent;
      const found = deps.registry.component(interaction.data.custom_id);
      if (found) {
        target = {
          module: found.module,
          capability: found.route.capability,
          label: interaction.data.custom_id,
          run: () => found.route.handle(interaction, ctx),
        };
      }
      break;
    }
    case InteractionType.ModalSubmit: {
      missing = MESSAGES.staleComponent;
      const found = deps.registry.modal(interaction.data.custom_id);
      if (found) {
        target = {
          module: found.module,
          capability: found.route.capability,
          label: interaction.data.custom_id,
          run: () => found.route.handle(interaction, ctx),
        };
      }
      break;
    }
  }

  if (!target) return { response: ephemeral(missing) };
  if (!target.module.guilds.includes(settings.kind))
    return { response: ephemeral(MESSAGES.unavailable) };

  const gate = can(actor, target.capability, settings);
  if (!gate.allowed) return { response: ephemeral(gate.reason) };

  const errorContext = {
    route: "discord:interactions",
    feature: target.module.name,
    interaction: target.label,
    guildId,
  };
  try {
    const result = await target.run();
    const background = result.background;
    if (!background) return result;
    return {
      response: result.response,
      background: async () => {
        try {
          await background();
        } catch (error) {
          await deps.reportError(error, { ...errorContext, phase: "background" });
        }
      },
    };
  } catch (error) {
    // Reporting can be slow (Raft writes to Postgres), so it runs after the reply goes out.
    return {
      response: ephemeral(MESSAGES.failed),
      background: () => deps.reportError(error, errorContext),
    };
  }
}
