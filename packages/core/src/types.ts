import type {
  API,
  APIChatInputApplicationCommandInteraction,
  APIInteractionResponse,
  APIMessageComponentInteraction,
  APIModalSubmitInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "@nexus-bot/discord";
import type { Capability } from "./gate";
import type { GuildKind, GuildSettings } from "./settings";

/** Report an error to wherever the transport sends them (Raft on Vercel). Never throws. */
export type ReportError = (error: unknown, context?: Record<string, unknown>) => Promise<void>;

/** What every handler gets besides the interaction. */
export interface HandlerContext {
  settings: GuildSettings;
  discord: API;
  applicationId: string;
  reportError: ReportError;
  now: () => number;
}

/**
 * The handler contract: an immediate response (sent within Discord's 3 seconds) and optional slow
 * work that runs after it. The transport decides how `background` is kept alive (`after()` on
 * Vercel). Use the interaction token to edit the reply for 15 minutes, the bot token after that.
 */
export interface HandlerResult {
  response: APIInteractionResponse;
  background?: () => Promise<void>;
}

export type Handler<I> = (
  interaction: I,
  ctx: HandlerContext
) => Promise<HandlerResult> | HandlerResult;

export interface Command {
  definition: RESTPostAPIChatInputApplicationCommandsJSONBody;
  capability: Capability;
  handle: Handler<APIChatInputApplicationCommandInteraction>;
}

export interface ComponentRoute {
  capability: Capability;
  handle: Handler<APIMessageComponentInteraction>;
}

export interface ModalRoute {
  capability: Capability;
  handle: Handler<APIModalSubmitInteraction>;
}

/**
 * A feature: its slash commands, the component and modal handlers its messages use, and who may
 * use each. Add it to `features/index.ts` and that's all the wiring there is: the register script
 * and the dispatcher both read the same registry.
 */
export interface FeatureModule {
  /** Also the custom_id prefix (`<name>:<action>:<id>`), so keep it short: `evt`, `sup`, `fb`. */
  name: string;
  /** Which guilds get its commands and may use its components. */
  guilds: readonly GuildKind[];
  commands?: readonly Command[];
  /** custom_id action → handler, for buttons and select menus. */
  components?: Readonly<Record<string, ComponentRoute>>;
  /** custom_id action → handler, for modal submits. */
  modals?: Readonly<Record<string, ModalRoute>>;
}
