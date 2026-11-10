import type { AdminApi } from "./admin-api";
import type { EventDraftStore, EventExtractor } from "./features/event-create/types";
import type { FeedbackDraftStore, FeedbackExtractor, UsageStore } from "./features/feedback/types";
import type { FeedbackGitHub } from "./github-app";
import type { ScreenshotStore } from "./screenshots";

/**
 * Everything features need beyond Discord itself. The transport builds the real ones
 * (apps/http/lib/runtime.ts); tests pass fakes. Add a field here when a feature needs a new store
 * or client.
 */
export interface Services {
  eventDrafts: EventDraftStore;
  adminApi: AdminApi;
  extractEvent: EventExtractor;
  /** discord.usage, for rate limits */
  usage: UsageStore;
  feedbackDrafts: FeedbackDraftStore;
  github: FeedbackGitHub;
  screenshots: ScreenshotStore;
  extractFeedback: FeedbackExtractor;
}
