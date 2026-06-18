import { inclusiveDayCount, parseIsoDate } from './date.util';
import { daysEqual, roundDays } from './days.util';

describe('date.util', () => {
  describe('parseIsoDate', () => {
    it('parses a valid date', () => {
      expect(parseIsoDate('2026-06-18').getUTCFullYear()).toBe(2026);
    });

    it('rejects a malformed string', () => {
      expect(() => parseIsoDate('2026/06/18')).toThrow(/YYYY-MM-DD/);
      expect(() => parseIsoDate('not-a-date')).toThrow();
    });

    it('rejects an impossible calendar date (no silent rollover)', () => {
      expect(() => parseIsoDate('2026-02-31')).toThrow(/Invalid calendar date/);
    });
  });

  describe('inclusiveDayCount', () => {
    it('counts a single day as 1', () => {
      expect(inclusiveDayCount('2026-06-18', '2026-06-18')).toBe(1);
    });

    it('counts inclusive ranges', () => {
      expect(inclusiveDayCount('2026-06-18', '2026-06-20')).toBe(3);
    });

    it('handles month boundaries', () => {
      expect(inclusiveDayCount('2026-01-30', '2026-02-02')).toBe(4);
    });

    it('throws when end precedes start', () => {
      expect(() => inclusiveDayCount('2026-06-20', '2026-06-18')).toThrow(/must not be before/);
    });
  });
});

describe('days.util', () => {
  it('rounds away floating-point drift', () => {
    expect(roundDays(0.1 + 0.2)).toBe(0.3);
  });

  it('compares within precision', () => {
    expect(daysEqual(0.1 + 0.2, 0.3)).toBe(true);
    expect(daysEqual(1, 1.5)).toBe(false);
  });
});
