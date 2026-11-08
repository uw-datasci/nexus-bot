import { generateKeyPairSync, sign } from "node:crypto";
import {
  ApplicationCommandType,
  InteractionResponseType,
  InteractionType,
  deferred,
  type API,
} from "@nexus-bot/discord";
import { createRegistry, parseGuildSettings, registry, type Services } from "@nexus-bot/core";
import { describe, expect, it, vi, type Mock } from "vitest";
import { handleInteractionRequest, type RequestDeps } from "./handle-request";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_KEY = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url").toString("hex");
const GUILD = "100000000000000001";

function signedRequest(body: unknown, { tamper = false } = {}) {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.from(timestamp + raw), privateKey).toString("hex");
  return new Request("https://bot.test/api/interactions", {
    method: "POST",
    headers: { "x-signature-ed25519": signature, "x-signature-timestamp": timestamp },
    body: tamper ? raw.replace("1", "2") : raw,
  });
}

const command = (name: string) => ({
  id: "1436700000000000000",
  type: InteractionType.ApplicationCommand,
  guild_id: GUILD,
  member: { user: { id: "4" }, roles: [] },
  data: { id: "1", name, type: ApplicationCommandType.ChatInput },
});

type Schedule = RequestDeps["schedule"];

function deps(): RequestDeps & { schedule: Mock<Schedule> } {
  return {
    publicKey: PUBLIC_KEY,
    schedule: vi.fn<Schedule>(),
    dispatch: {
      registry,
      discord: {} as API,
      applicationId: "app",
      loadSettings: async (id) =>
        id === GUILD ? parseGuildSettings(GUILD, { kind: "exec" }) : null,
      reportError: vi.fn(),
      services: {} as Services,
    },
  };
}

describe("POST /api/interactions", () => {
  it("answers a bad signature with 401, as Discord's endpoint check requires", async () => {
    const response = await handleInteractionRequest(
      signedRequest({ type: 1 }, { tamper: true }),
      deps()
    );
    expect(response.status).toBe(401);
    const unsigned = new Request("https://bot.test/api/interactions", {
      method: "POST",
      body: "{}",
    });
    expect((await handleInteractionRequest(unsigned, deps())).status).toBe(401);
  });

  it("answers a signed PING with PONG", async () => {
    const response = await handleInteractionRequest(
      signedRequest({ type: InteractionType.Ping }),
      deps()
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: InteractionResponseType.Pong });
  });

  it("answers /ping through the registry", async () => {
    const d = deps();
    const response = await handleInteractionRequest(signedRequest(command("ping")), d);
    expect(await response.json()).toMatchObject({
      type: InteractionResponseType.ChannelMessageWithSource,
      data: { content: expect.stringMatching(/^Pong!/) },
    });
    expect(d.schedule).not.toHaveBeenCalled();
  });

  it("hands background work to the scheduler, after replying", async () => {
    const work = vi.fn().mockResolvedValue(undefined);
    const d = deps();
    d.dispatch.registry = createRegistry([
      {
        name: "slow",
        guilds: ["exec"],
        commands: [
          {
            definition: { name: "slow", description: "x", type: ApplicationCommandType.ChatInput },
            capability: "ping",
            handle: () => ({ response: deferred(), background: work }),
          },
        ],
      },
    ]);
    const response = await handleInteractionRequest(signedRequest(command("slow")), d);
    expect(await response.json()).toEqual({
      type: InteractionResponseType.DeferredChannelMessageWithSource,
    });
    expect(d.schedule).toHaveBeenCalledTimes(1);
    expect(work).not.toHaveBeenCalled();
    await d.schedule.mock.calls[0]![0]();
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("rejects a signed body that isn't JSON", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(null, Buffer.from(timestamp + "nope"), privateKey).toString("hex");
    const request = new Request("https://bot.test/api/interactions", {
      method: "POST",
      headers: { "x-signature-ed25519": signature, "x-signature-timestamp": timestamp },
      body: "nope",
    });
    expect((await handleInteractionRequest(request, deps())).status).toBe(400);
  });
});
