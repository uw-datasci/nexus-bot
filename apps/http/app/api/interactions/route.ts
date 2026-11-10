import { after } from "next/server";
import { withRaft } from "@uw-datasci/raft";
import { handleInteractionRequest } from "../../../lib/handle-request";
import { getRuntime } from "../../../lib/runtime";

/**
 * POST /api/interactions: Discord's Interactions Endpoint URL.
 *
 * The response must go out within 3 seconds; slow work runs in `after()`, inside this function's
 * lifetime. Pin a ceiling that covers a 40 s LLM call plus Discord and database calls (#3's
 * /event-create), since the Hobby default without Fluid Compute is 10 s.
 */
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export const POST = withRaft(async (request) => {
  const runtime = getRuntime();
  return handleInteractionRequest(request, { ...runtime, schedule: (work) => after(work) });
});
