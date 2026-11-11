/** Timestamps are stored in UTC; every display uses the plant time zone. */
export const PLANT_TIME_ZONE = "Africa/Tunis";

const dateTimeFmt = new Intl.DateTimeFormat("fr-FR", {
  timeZone: PLANT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const timeFmt = new Intl.DateTimeFormat("fr-FR", {
  timeZone: PLANT_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

/** "11/11/2026 14:05:09" in Africa/Tunis. */
export function formatDateTime(value: Date | string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return dateTimeFmt.format(toDate(value));
}

/** "14:05:09" in Africa/Tunis. */
export function formatTime(value: Date | string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return timeFmt.format(toDate(value));
}

/** Offset (minutes) of the plant zone relative to UTC at the given instant. */
function zoneOffsetMinutes(instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PLANT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const hour = get("hour") === 24 ? 0 : get("hour");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return Math.round((asUtc - instant.getTime()) / 60000);
}

/**
 * UTC instant of 00:00 (plant time) on a YYYY-MM-DD calendar day.
 * Returns null for malformed input.
 */
export function plantDayStartUtc(day: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const guess = new Date(Date.UTC(y, mo - 1, d, 0, 0, 0));
  if (guess.getUTCFullYear() !== y || guess.getUTCMonth() !== mo - 1 || guess.getUTCDate() !== d) return null;
  const offset = zoneOffsetMinutes(guess);
  return new Date(guess.getTime() - offset * 60000);
}

/** Calendar year (plant time) of an instant — used in report references. */
export function plantYear(value: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: PLANT_TIME_ZONE, year: "numeric" }).format(value),
  );
}
