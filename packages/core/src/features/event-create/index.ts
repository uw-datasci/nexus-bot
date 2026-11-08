import { ApplicationCommandType, InteractionContextType } from "@nexus-bot/discord";
import type { FeatureModule } from "../../types";
import { COMMAND_NAME, FEATURE } from "./cards";
import {
  handleCancel,
  handleCategory,
  handleCommand,
  handleModalSubmit,
  handleReview,
} from "./handlers";

export { createClaudeExtractor, ExtractionError } from "./extract";
export type * from "./types";

const EXECS_ONLY = "Only execs can create events from Discord.";

/**
 * /event-create: run it in a thread where an event is being planned. The bot reads the thread,
 * an LLM extracts the details into a public preview card, the exec picks a category, reviews the
 * details in a modal and confirms, and admin gets an unpublished (Draft) event.
 */
export const eventCreate: FeatureModule = {
  name: FEATURE,
  guilds: ["exec"],
  commands: [
    {
      definition: {
        name: COMMAND_NAME,
        description: "Draft a website event from this thread (execs only)",
        type: ApplicationCommandType.ChatInput,
        // "0" = hidden from everyone except server admins until a role is allowed under
        // Server Settings → Integrations → <bot>. The gate checks roles too, so this is UX.
        default_member_permissions: "0",
        contexts: [InteractionContextType.Guild],
      },
      capability: "event.create",
      deniedMessage: EXECS_ONLY,
      handle: handleCommand,
    },
  ],
  components: {
    category: { capability: "event.create", deniedMessage: EXECS_ONLY, handle: handleCategory },
    review: { capability: "event.create", deniedMessage: EXECS_ONLY, handle: handleReview },
    fix: { capability: "event.create", deniedMessage: EXECS_ONLY, handle: handleReview },
    cancel: { capability: "event.create", deniedMessage: EXECS_ONLY, handle: handleCancel },
  },
  modals: {
    modal: { capability: "event.create", deniedMessage: EXECS_ONLY, handle: handleModalSubmit },
  },
};
