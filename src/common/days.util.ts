import { DAYS_DECIMAL_PRECISION } from './constants';

/** Round a day quantity to the configured precision to avoid floating point drift. */
export function roundDays(value: number): number {
  const factor = 10 ** DAYS_DECIMAL_PRECISION;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** True when two day quantities are equal within the configured precision. */
export function daysEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 10 ** -DAYS_DECIMAL_PRECISION;
}
