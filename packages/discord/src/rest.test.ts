import { describe, expect, it, vi } from "vitest";
import { editInteractionMessage, snowflakeTime, type API } from "./rest";

// Discord's own example snowflake: 175928847299117063 was created at 2016-04-30T11:18:25.796Z.
const SNOWFLAKE = "175928847299117063";
const CREATED = Date.parse("2016-04-30T11:18:25.796Z");

function fakeApi() {
  const editReply = vi.fn().mockResolvedValue({});
  const editMessage = vi.fn().mockResolvedValue({});
  return {
    api: { interactions: { editReply }, channels: { editMessage } } as unknown as API,
    editReply,
    editMessage,
  };
}

const ref = {
  applicationId: "app",
  interactionId: SNOWFLAKE,
  interactionToken: "tok",
  channelId: "chan",
  messageId: "msg",
};

describe("snowflakeTime", () => {
  it("reads the creation time from a snowflake", () => {
    expect(snowflakeTime(SNOWFLAKE)).toBe(CREATED);
  });
});

describe("editInteractionMessage", () => {
  it("uses the interaction token while it's fresh", async () => {
    const { api, editReply, editMessage } = fakeApi();
    await editInteractionMessage(api, ref, { content: "x" }, CREATED + 5 * 60_000);
    expect(editReply).toHaveBeenCalledWith("app", "tok", { content: "x" }, "msg");
    expect(editMessage).not.toHaveBeenCalled();
  });

  it("edits the original response by default", async () => {
    const { api, editReply } = fakeApi();
    await editInteractionMessage(api, { ...ref, messageId: undefined }, { content: "x" }, CREATED);
    expect(editReply).toHaveBeenCalledWith("app", "tok", { content: "x" }, "@original");
  });

  it("switches to the bot token near and after the 15-minute expiry", async () => {
    const { api, editReply, editMessage } = fakeApi();
    await editInteractionMessage(api, ref, { content: "x" }, CREATED + 14.5 * 60_000);
    expect(editMessage).toHaveBeenCalledWith("chan", "msg", { content: "x" });
    expect(editReply).not.toHaveBeenCalled();
  });

  it("needs a message ID once the token has expired", async () => {
    const { api } = fakeApi();
    await expect(
      editInteractionMessage(
        api,
        { ...ref, messageId: undefined },
        { content: "x" },
        CREATED + 60 * 60_000
      )
    ).rejects.toThrow(/message ID/);
  });
});
