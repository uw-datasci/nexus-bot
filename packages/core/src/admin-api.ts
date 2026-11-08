import type { EventCategory } from "./features/event-create/types";

/**
 * The website admin app's internal API (`/api/internal/*`, uwdsc-website-v3): the bot's writes
 * to website-owned tables go through it, so admin keeps its tables and rules.
 * Auth: `Authorization: Bearer $NEXUS_BOT_INTERNAL_TOKEN`.
 */

export interface DraftEventFields {
  name: string;
  description: string;
  location: string;
  /** UTC ISO */
  start_time: string;
  end_time: string;
  category: EventCategory;
  image_url: null;
  resources: [];
}

/** The fields the bot's "created" card shows. Times are ISO strings. */
export interface CreatedEvent {
  id: string;
  name: string;
  description: string;
  location: string;
  start_time: string;
  end_time: string;
  category: EventCategory;
}

export type CreateDraftResult =
  | { ok: true; event: CreatedEvent }
  /** 400: `message` is the first validation problem; 403: the actor isn't allowed. */
  | { ok: false; status: 400 | 403; message: string };

export interface AdminApi {
  /** POST /api/internal/events/drafts: an unpublished event, shown as a Draft in admin. */
  createDraftEvent(
    fields: DraftEventFields,
    actor: { discordId: string }
  ): Promise<CreateDraftResult>;
}

/** Anything but a clear yes, a validation problem or a permission denial: a fault to report. */
export class AdminApiError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

export interface AdminApiOptions {
  /** e.g. https://admin.uwdatascience.ca, or a preview deployment's URL */
  baseUrl: string;
  token: string;
  /** Vercel Deployment Protection bypass secret, for calling a protected preview deployment. */
  bypassToken?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

const messageFrom = (body: unknown, fallback: string): string => {
  if (body && typeof body === "object") {
    const { message, error } = body as { message?: unknown; error?: unknown };
    if (typeof message === "string" && message) return message;
    if (typeof error === "string" && error) return error;
  }
  return fallback;
};

export function createAdminApi({
  baseUrl,
  token,
  bypassToken,
  timeoutMs = 15_000,
  fetch = globalThis.fetch,
}: AdminApiOptions): AdminApi {
  const url = (path: string) =>
    new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();

  return {
    async createDraftEvent(fields, actor) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "nexus-bot",
      };
      if (bypassToken) headers["x-vercel-protection-bypass"] = bypassToken;

      let response: Response;
      try {
        response = await fetch(url("api/internal/events/drafts"), {
          method: "POST",
          headers,
          body: JSON.stringify({ ...fields, actor_discord_id: actor.discordId }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new AdminApiError(`Admin API request failed: ${(error as Error).message}`);
      }

      const body: unknown = await response.json().catch(() => null);
      if (response.ok) {
        const event = (body as { event?: CreatedEvent } | null)?.event;
        if (!event?.id) throw new AdminApiError("Admin API returned no event", response.status);
        return { ok: true, event };
      }
      if (response.status === 400 || response.status === 403) {
        return {
          ok: false,
          status: response.status,
          message: messageFrom(body, "Invalid event details"),
        };
      }
      throw new AdminApiError(
        `Admin API returned ${response.status}: ${messageFrom(body, response.statusText)}`,
        response.status
      );
    },
  };
}
