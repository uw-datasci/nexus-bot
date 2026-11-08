import { ApplicationCommandType, InteractionContextType } from "@nexus-bot/discord";
import type { FeatureModule } from "../../types";
import { COMMAND_NAME, FEATURE, MESSAGE_COMMAND_NAME } from "./cards";
import {
  handleCancel,
  handleCommand,
  handleCreate,
  handleDrop,
  handleEdit,
  handleEnvironment,
  handleIntakeSubmit,
  handleItemSubmit,
  handleMessageCommand,
  routeMessageModal,
} from "./handlers";
import {
  handleAnswer,
  handleAnswerSubmit,
  handleLooksGood,
  handleStillNotRight,
  handleStillNotRightSubmit,
} from "./updates";

export { createFeedbackExtractor, FeedbackExtractionError } from "./extract";
export { appsFor } from "./access";
export type * from "./types";

/**
 * /feedback and Send as feedback: organizers' feedback about an event app becomes GitHub issues
 * on its repo, which the app's triage workflow then routes (Feedback loop spec, §2 Intake). The
 * workflows' updates in Discord come back through the buttons in updates.ts (§6).
 * Who may use it is per app (settings `feedback_apps`), so the gate lets everyone through and
 * the handlers check the app's role sets; the card's controls only work for the runner.
 */
export const feedback: FeatureModule = {
  name: FEATURE,
  guilds: ["exec"],
  commands: [
    {
      definition: {
        name: COMMAND_NAME,
        description: "Turn feedback about an event app into GitHub issues",
        type: ApplicationCommandType.ChatInput,
        contexts: [InteractionContextType.Guild],
      },
      capability: "feedback",
      handle: handleCommand,
    },
  ],
  messageCommands: [
    {
      definition: {
        name: MESSAGE_COMMAND_NAME,
        type: ApplicationCommandType.Message,
        contexts: [InteractionContextType.Guild],
      },
      capability: "feedback",
      handle: handleMessageCommand,
    },
  ],
  components: {
    drop: { capability: "feedback", handle: handleDrop },
    env: { capability: "feedback", handle: handleEnvironment },
    edit: { capability: "feedback", handle: handleEdit },
    create: { capability: "feedback", handle: handleCreate },
    cancel: { capability: "feedback", handle: handleCancel },
    // The workflows' Discord updates (feedback-notify.yml); see updates.ts for the contract.
    good: { capability: "feedback", handle: handleLooksGood },
    again: { capability: "feedback", handle: handleStillNotRight },
    answer: { capability: "feedback", handle: handleAnswer },
  },
  modals: {
    intake: { capability: "feedback", handle: handleIntakeSubmit },
    message: { capability: "feedback", handle: routeMessageModal },
    item: { capability: "feedback", handle: handleItemSubmit },
    againtext: { capability: "feedback", handle: handleStillNotRightSubmit },
    answertext: { capability: "feedback", handle: handleAnswerSubmit },
  },
};
