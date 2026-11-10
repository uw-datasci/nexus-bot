import { DateTime } from "luxon";

/**
 * Cleaning Discord message text before it goes into an LLM prompt. Shared by every feature that
 * sends messages to a model (/event-create, /feedback): the text is untrusted, so it must not be
 * able to close the prompt's data delimiters.
 */

export const TIMEZONE = "America/Toronto";

/** A display name, safe to put in a transcript line. */
export function sanitizeName(name: string): string {
  return (
    name
      .replaceAll(/[\r\n\t:<>[\]]/g, " ")
      .trim()
      .slice(0, 40) || "member"
  );
}

/** Drop ASCII control characters except tab and newline. */
export function stripControlChars(text: string): string {
  return Array.from(text)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code === 9 || code === 10 || (code >= 32 && code !== 127);
    })
    .join("");
}

/**
 * Strip Discord markup the model can't use, control characters, and the prompt's delimiters
 * (`<thread>`, `<messages>` and `<runner_feedback>`, opening or closing).
 */
export function sanitizeContent(content: string): string {
  return (
    stripControlChars(content)
      // Discord timestamps carry real dates: render them as Toronto wall time.
      .replaceAll(/<t:(\d{1,12})(?::[tTdDfFR])?>/g, (_, secs: string) =>
        DateTime.fromSeconds(Number(secs), { zone: TIMEZONE }).toFormat("yyyy-MM-dd HH:mm (cccc)")
      )
      .replaceAll(/<@[!&]?\d+>/g, "@someone")
      .replaceAll(/<#\d+>/g, "#channel")
      .replaceAll(/<a?:(\w+):\d+>/g, ":$1:")
      // Message text is untrusted: don't let it close or reopen the data delimiters.
      .replaceAll(/<\/?\s*(thread|messages|runner_feedback|background)\s*>/gi, "")
      .replaceAll(/[ \t]+/g, " ")
      .replaceAll(/\n{3,}/g, "\n\n")
      .trim()
  );
}
