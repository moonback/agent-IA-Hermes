import { describe, expect, it } from 'vitest';
import { nextCronRun, nextCronRuns, parseCron } from '@hermes/core';

// Local-time dates: the scheduler follows the machine's time zone, like the user's clock.
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const fmt = (d: Date | null) =>
  d
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    : null;

describe('expressions cron', () => {
  it('« tous les matins à 8 h » et l’instant exact est exclu', () => {
    const s = parseCron('0 8 * * *');
    expect(fmt(nextCronRun(s, at(2026, 10, 24, 7, 59)))).toBe('2026-10-24 08:00');
    expect(fmt(nextCronRun(s, at(2026, 10, 24, 8, 0)))).toBe('2026-10-25 08:00');
  });
  it('jours ouvrés, pas, listes et noms', () => {
    // 2026-10-24 is a Saturday.
    expect(fmt(nextCronRun(parseCron('30 9 * * mon-fri'), at(2026, 10, 24, 12)))).toBe('2026-10-26 09:30');
    expect(nextCronRuns('*/15 9 * * *', at(2026, 10, 24, 8, 50), 5).map(fmt)).toEqual([
      '2026-10-24 09:00',
      '2026-10-24 09:15',
      '2026-10-24 09:30',
      '2026-10-24 09:45',
      '2026-10-25 09:00',
    ]);
    expect(nextCronRuns('0 8-18/5 * * *', at(2026, 10, 24), 3).map(fmt)).toEqual([
      '2026-10-24 08:00',
      '2026-10-24 13:00',
      '2026-10-24 18:00',
    ]);
    expect(fmt(nextCronRun(parseCron('0 0 1 jan,jul *'), at(2026, 10, 24)))).toBe('2027-01-01 00:00');
  });
  it('raccourcis @daily, @weekly, @monthly ; 7 = dimanche', () => {
    expect(fmt(nextCronRun(parseCron('@daily'), at(2026, 10, 24, 10)))).toBe('2026-10-25 00:00');
    expect(fmt(nextCronRun(parseCron('@weekly'), at(2026, 10, 24, 10)))).toBe('2026-10-25 00:00');
    expect(fmt(nextCronRun(parseCron('@monthly'), at(2026, 10, 24)))).toBe('2026-11-01 00:00');
    expect(fmt(nextCronRun(parseCron('0 12 * * 7'), at(2026, 10, 24)))).toBe('2026-10-25 12:00');
  });
  it('jour du mois OU jour de semaine quand les deux sont restreints (cron Vixie)', () => {
    // The 13th, or any Friday.
    expect(nextCronRuns('0 9 13 * fri', at(2026, 11, 1), 3).map(fmt)).toEqual([
      '2026-11-06 09:00',
      '2026-11-13 09:00',
      '2026-11-20 09:00',
    ]);
  });
  it('29 février : trouvé dans une année bissextile ; 31 février : jamais', () => {
    expect(fmt(nextCronRun(parseCron('0 0 29 2 *'), at(2026, 10, 24)))).toBe('2028-02-29 00:00');
    expect(nextCronRun(parseCron('0 0 31 2 *'), at(2026, 10, 24))).toBeNull();
  });
  it.each([
    '* * * *',
    '60 * * * *',
    '* 24 * * *',
    '* * 0 * *',
    '* * * 13 *',
    '*/0 * * * *',
    '5-1 * * * *',
    'x * * * *',
    '* * * * dim',
  ])('refuse « %s »', (e) => {
    expect(() => parseCron(e)).toThrow();
  });
});
