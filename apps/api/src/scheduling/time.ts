import { DateTime } from 'luxon';
import { z } from 'zod';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/);
const interval = z.tuple([hhmm, hhmm]).refine(([a, b]) => a < b, 'interval end must be after start');
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
type Day = (typeof DAYS)[number];

/** Location opening hours, wall-clock in the location timezone. Missing day = closed. */
export const openingHoursSchema = z
  .object(
    Object.fromEntries(DAYS.map((d) => [d, z.array(interval).optional()])) as Record<
      Day,
      z.ZodOptional<z.ZodArray<typeof interval>>
    >,
  )
  .strict();
export type OpeningHours = z.infer<typeof openingHoursSchema>;

export function isValidTimezone(tz: string): boolean {
  return DateTime.local().setZone(tz).isValid;
}

/**
 * True when [from, to) overlaps any open interval of the location. A location with no
 * hours configured is treated as always open (no OUTSIDE_HOURS decisions without data).
 */
export function overlapsOpeningHours(from: Date, to: Date, timezone: string, hours: OpeningHours): boolean {
  if (DAYS.every((d) => !hours[d]?.length)) return true;

  let day = DateTime.fromJSDate(from, { zone: timezone }).startOf('day').minus({ days: 1 });
  const lastDay = DateTime.fromJSDate(to, { zone: timezone }).startOf('day');
  const fromMs = from.getTime();
  const toMs = to.getTime();

  while (day <= lastDay) {
    const key = DAYS[day.weekday - 1] as Day;
    for (const [start, end] of hours[key] ?? []) {
      const openMs = atWallClock(day, start).toMillis();
      const closeMs = atWallClock(day, end).toMillis();
      if (openMs < toMs && closeMs > fromMs) return true;
    }
    day = day.plus({ days: 1 });
  }
  return false;
}

function atWallClock(day: DateTime, hhmmValue: string): DateTime {
  const [h, m] = hhmmValue.split(':').map(Number) as [number, number];
  return h === 24 ? day.plus({ days: 1 }) : day.set({ hour: h, minute: m, second: 0, millisecond: 0 });
}

/** "Friday 24 October at 4:30 PM" in the location timezone, for TTS (contract Slot.speakable). */
export function speakable(at: Date, timezone: string): string {
  return DateTime.fromJSDate(at, { zone: timezone }).setLocale('en-US').toFormat("cccc d LLLL 'at' h:mm a");
}
