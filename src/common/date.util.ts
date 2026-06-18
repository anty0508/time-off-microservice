/**
 * Date helpers for time-off requests. Dates are handled as calendar dates (YYYY-MM-DD) in UTC to
 * avoid timezone drift. Day-counting is inclusive of both endpoints.
 *
 * NOTE: This implementation counts *calendar* days. Excluding weekends/public holidays requires a
 * per-location working-calendar and is called out as future work in the TRD.
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse a strict YYYY-MM-DD string into a UTC Date, or throw. */
export function parseIsoDate(value: string): Date {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) {
    throw new Error(`Invalid date "${value}": expected format YYYY-MM-DD`);
  }
  const [y, m, d] = value.split('-').map((p) => parseInt(p, 10));
  const date = new Date(Date.UTC(y, m - 1, d));
  // Guard against rollovers like 2024-02-31 silently becoming March.
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    throw new Error(`Invalid calendar date "${value}"`);
  }
  return date;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Inclusive calendar-day count between two YYYY-MM-DD strings.
 * Returns NaN-free positive integer; throws if start is after end.
 */
export function inclusiveDayCount(start: string, end: string): number {
  const s = parseIsoDate(start);
  const e = parseIsoDate(end);
  if (e.getTime() < s.getTime()) {
    throw new Error(`endDate (${end}) must not be before startDate (${start})`);
  }
  return Math.round((e.getTime() - s.getTime()) / MS_PER_DAY) + 1;
}
