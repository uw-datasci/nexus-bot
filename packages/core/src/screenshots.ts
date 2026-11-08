import type { Severity } from "./types";

/**
 * Screenshots for feedback issues. Discord attachment URLs expire, so each screenshot an issue
 * uses is copied to Vercel Blob at intake and the issue embeds the Blob URL. The Blob store must
 * be public: GitHub renders the images, and the triage workflow downloads them.
 */

/** What Claude accepts as images, and what the triage workflow downloads. */
export const IMAGE_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
} as const;
export type ImageMediaType = keyof typeof IMAGE_TYPES;

export const isImageType = (type: string | null | undefined): type is ImageMediaType =>
  Boolean(type && type.split(";")[0]!.trim().toLowerCase() in IMAGE_TYPES);

/** Claude's per-image limit; bigger screenshots are still filed, just not shown to the model. */
export const MAX_MODEL_IMAGE_BYTES = 5 * 1024 * 1024;
/** Anything bigger isn't a screenshot worth copying (Discord's own upload limit is lower). */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export interface DownloadedImage {
  bytes: Uint8Array;
  mediaType: ImageMediaType;
}

export interface ScreenshotStore {
  download(url: string): Promise<DownloadedImage>;
  /** Store under `path` (e.g. `feedback/<run>/1.png`); returns the public URL. */
  save(path: string, image: DownloadedImage): Promise<string>;
}

export class ScreenshotError extends Error {
  constructor(
    message: string,
    readonly severity: Severity = "warning"
  ) {
    super(message);
    this.name = "ScreenshotError";
  }
}

/** `put` is @vercel/blob's, bound to the token; undefined when BLOB_READ_WRITE_TOKEN isn't set. */
export type BlobPut = (
  path: string,
  bytes: Uint8Array,
  contentType: ImageMediaType
) => Promise<{ url: string }>;

export function createScreenshotStore({
  put,
  fetch = globalThis.fetch,
  timeoutMs = 10_000,
}: {
  put: BlobPut | undefined;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}): ScreenshotStore {
  return {
    async download(url) {
      let response: Response;
      try {
        response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        throw new ScreenshotError(`Downloading a screenshot failed: ${(error as Error).message}`);
      }
      if (!response.ok) {
        throw new ScreenshotError(`Downloading a screenshot failed: ${response.status}`);
      }
      const type = response.headers.get("content-type");
      if (!isImageType(type))
        throw new ScreenshotError(`Not a supported image (${type ?? "none"})`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_IMAGE_BYTES) throw new ScreenshotError("Screenshot is too large");
      return { bytes, mediaType: type.split(";")[0]!.trim().toLowerCase() as ImageMediaType };
    },

    async save(path, image) {
      if (!put) throw new ScreenshotError("BLOB_READ_WRITE_TOKEN isn't configured.", "error");
      try {
        return (await put(path, image.bytes, image.mediaType)).url;
      } catch (error) {
        throw new ScreenshotError(
          `Saving a screenshot to Blob failed: ${(error as Error).message}`
        );
      }
    },
  };
}
