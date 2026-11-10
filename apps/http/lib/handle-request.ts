import { dispatch, type DispatchDeps } from "@nexus-bot/core";
import { verifyInteraction, type APIInteraction } from "@nexus-bot/discord";

export interface RequestDeps {
  publicKey: string;
  dispatch: DispatchDeps;
  /** Run work after the response is sent, within the function's lifetime (`after()` on Vercel). */
  schedule: (work: () => Promise<void>) => void;
}

/**
 * One Discord interaction over HTTP. Signature first, on the exact raw body: Discord probes the
 * endpoint with bad signatures when the URL is saved, and expects a 401 for them.
 */
export async function handleInteractionRequest(
  request: Request,
  deps: RequestDeps
): Promise<Response> {
  const rawBody = await request.text();
  const valid = verifyInteraction({
    rawBody,
    signature: request.headers.get("x-signature-ed25519"),
    timestamp: request.headers.get("x-signature-timestamp"),
    publicKey: deps.publicKey,
  });
  if (!valid) return Response.json({ error: "Invalid request signature" }, { status: 401 });

  let interaction: APIInteraction;
  try {
    interaction = JSON.parse(rawBody) as APIInteraction;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { response, background } = await dispatch(interaction, deps.dispatch);
  if (background) deps.schedule(background);
  return Response.json(response);
}
