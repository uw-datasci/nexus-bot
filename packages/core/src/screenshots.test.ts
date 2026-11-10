import { describe, expect, it, vi } from "vitest";
import { createScreenshotStore, isImageType } from "./screenshots";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const respond = (body: ConstructorParameters<typeof Response>[0], type: string, status = 200) =>
  vi.fn(async () => new Response(body, { status, headers: { "content-type": type } }));

describe("screenshots", () => {
  it("knows the image types Claude and the triage workflow take", () => {
    expect(isImageType("image/png")).toBe(true);
    expect(isImageType("image/JPEG; charset=binary")).toBe(true);
    expect(isImageType("image/svg+xml")).toBe(false);
    expect(isImageType(undefined)).toBe(false);
  });

  it("downloads images and saves them through Blob's put", async () => {
    const put = vi.fn(async (path: string) => ({ url: `https://blob.example/${path}` }));
    const store = createScreenshotStore({
      put,
      fetch: respond(PNG, "image/png") as unknown as typeof fetch,
    });
    const image = await store.download("https://cdn.discordapp.com/a.png");
    expect(image).toEqual({ bytes: PNG, mediaType: "image/png" });
    expect(await store.save("feedback/run/1.png", image)).toBe(
      "https://blob.example/feedback/run/1.png"
    );
    expect(put).toHaveBeenCalledWith("feedback/run/1.png", PNG, "image/png");
  });

  it("refuses what isn't a supported image, and saving without a Blob token", async () => {
    const html = createScreenshotStore({
      put: undefined,
      fetch: respond("<html>", "text/html") as unknown as typeof fetch,
    });
    await expect(html.download("https://x")).rejects.toThrow(/Not a supported image/);
    await expect(html.save("p", { bytes: PNG, mediaType: "image/png" })).rejects.toMatchObject({
      severity: "error",
      message: expect.stringMatching(/BLOB_READ_WRITE_TOKEN/),
    });
    const gone = createScreenshotStore({
      put: undefined,
      fetch: respond("", "image/png", 404) as unknown as typeof fetch,
    });
    await expect(gone.download("https://x")).rejects.toThrow(/404/);
  });
});
