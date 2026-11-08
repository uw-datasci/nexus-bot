import { DateTime } from "luxon";

export const EVENT_TIMEZONE = "America/Toronto";
/** Format execs type into (and see in) the review modal. */
export const MODAL_TIME_FORMAT = "yyyy-MM-dd HH:mm";

/** A stored instant rendered as "YYYY-MM-DD HH:mm" in America/Toronto, or null. */
export function formatTorontoTime(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const dt =
    value instanceof Date ? DateTime.fromJSDate(value) : DateTime.fromISO(value, { zone: "utc" });
  return dt.isValid ? dt.setZone(EVENT_TIMEZONE).toFormat(MODAL_TIME_FORMAT) : null;
}

/**
 * Strictly parse "YYYY-MM-DD HH:mm" as America/Toronto wall time. The round-trip check rejects
 * anything luxon would silently normalize, including times that don't exist because of the
 * spring-forward DST gap.
 */
export function parseTorontoTime(raw: string, label: string): { iso: string } | { error: string } {
  const trimmed = raw.trim();
  const dt = DateTime.fromFormat(trimmed, MODAL_TIME_FORMAT, { zone: EVENT_TIMEZONE });
  if (!dt.isValid) {
    return {
      error: `${label} time "${trimmed}" isn't a valid date in YYYY-MM-DD HH:mm format (e.g. 2026-10-03 18:00).`,
    };
  }
  if (dt.toFormat(MODAL_TIME_FORMAT) !== trimmed) {
    return {
      error: `${label} time "${trimmed}" doesn't exist (clocks skip that hour when EST switches to EDT). Pick a different time.`,
    };
  }
  return { iso: dt.toUTC().toISO() ?? "" };
}
