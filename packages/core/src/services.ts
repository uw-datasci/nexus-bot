import type { AdminApi } from "./admin-api";
import type { EventDraftStore, EventExtractor } from "./features/event-create/types";

/**
 * Everything features need beyond Discord itself. The transport builds the real ones
 * (apps/http/lib/runtime.ts); tests pass fakes. Add a field here when a feature needs a new store
 * or client.
 */
export interface Services {
  eventDrafts: EventDraftStore;
  adminApi: AdminApi;
  extractEvent: EventExtractor;
}
