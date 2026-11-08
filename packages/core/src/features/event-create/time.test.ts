import { describe, expect, it } from "vitest";
import { formatTorontoTime, parseTorontoTime } from "./time";

describe("parseTorontoTime", () => {
  it("reads Toronto wall time, in both EST and EDT", () => {
    expect(parseTorontoTime("2026-11-20 18:00", "Start")).toEqual({
      iso: "2026-11-20T23:00:00.000Z",
    }); // EST, -5
    expect(parseTorontoTime(" 2026-07-01 18:00 ", "Start")).toEqual({
      iso: "2026-07-01T22:00:00.000Z",
    }); // EDT, -4
  });

  it("rejects anything not in YYYY-MM-DD HH:mm", () => {
    for (const raw of [
      "2026-11-20",
      "2026-11-20 6pm",
      "20/11/2026 18:00",
      "2026-13-01 10:00",
      "2026-11-20T18:00",
      "",
    ]) {
      const result = parseTorontoTime(raw, "Start");
      expect(result, raw).toHaveProperty("error");
      expect((result as { error: string }).error).toMatch(/^Start time .* isn't a valid date/);
    }
  });

  it("rejects times that don't exist because of the spring-forward gap", () => {
    // 2027-03-14: clocks jump from 02:00 EST to 03:00 EDT.
    const result = parseTorontoTime("2027-03-14 02:30", "End");
    expect((result as { error: string }).error).toMatch(
      /^End time "2027-03-14 02:30" doesn't exist/
    );
    expect(parseTorontoTime("2027-03-14 03:30", "End")).toEqual({
      iso: "2027-03-14T07:30:00.000Z",
    });
  });
});

describe("formatTorontoTime", () => {
  it("shows stored instants as Toronto wall time, from a Date or an ISO string", () => {
    expect(formatTorontoTime(new Date("2026-11-20T23:00:00Z"))).toBe("2026-11-20 18:00");
    expect(formatTorontoTime("2026-07-01T22:00:00.000Z")).toBe("2026-07-01 18:00");
    expect(formatTorontoTime(null)).toBeNull();
    expect(formatTorontoTime("not a date")).toBeNull();
  });

  it("round-trips with parseTorontoTime", () => {
    const parsed = parseTorontoTime("2026-10-03 18:00", "Start") as { iso: string };
    expect(formatTorontoTime(parsed.iso)).toBe("2026-10-03 18:00");
  });
});
