import { HermesError } from '../shared/errors';

/**
 * Standard 5-field cron (minute hour day-of-month month day-of-week), evaluated in the machine's
 * local time zone. Supports *, lists (1,15), ranges (1-5), steps (*\/10, 8-18/2), month and day
 * names (jan, mon) and @hourly/@daily/@weekly/@monthly/@yearly. When both day fields are
 * restricted, a date matches if EITHER matches (Vixie cron semantics).
 */

export interface CronSchedule {
  expression: string;
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  dayRestricted: boolean;
  weekdayRestricted: boolean;
}

const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function field(raw: string, min: number, max: number, label: string, names?: string[]): Set<number> {
  const out = new Set<number>();
  const value = (v: string) => {
    const named = names?.indexOf(v.toLowerCase()) ?? -1;
    const n = named >= 0 ? named + (label === 'mois' ? 1 : 0) : Number(v);
    if (!/^\d+$/.test(String(v)) && named < 0)
      throw new HermesError('VALIDATION', `Valeur invalide « ${v} » (${label})`);
    if (n < min || n > max)
      throw new HermesError('VALIDATION', `${label} hors bornes : ${v} (${min}-${max})`);
    return n;
  };
  for (const part of raw.split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1)
      throw new HermesError('VALIDATION', `Pas invalide « ${part} » (${label})`);
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (range!.includes('-')) {
      const [a, b] = range!.split('-');
      lo = value(a!);
      hi = value(b!);
      if (lo > hi) throw new HermesError('VALIDATION', `Intervalle inversé « ${range} » (${label})`);
    } else {
      lo = value(range!);
      hi = stepRaw === undefined ? lo : max;
    }
    for (let n = lo; n <= hi; n += step) out.add(n);
  }
  return out;
}

export function parseCron(expression: string): CronSchedule {
  const expr = expression.trim().toLowerCase();
  const parts = (ALIASES[expr] ?? expr).split(/\s+/);
  if (parts.length !== 5)
    throw new HermesError(
      'VALIDATION',
      'Expression cron invalide : 5 champs attendus (minute heure jour mois jour-de-semaine)',
    );
  const [mi, h, d, mo, wd] = parts as [string, string, string, string, string];
  const weekdays = field(wd, 0, 7, 'jour de semaine', DAYS);
  if (weekdays.has(7)) {
    weekdays.delete(7);
    weekdays.add(0); // 7 = Sunday too
  }
  return {
    expression: expression.trim(),
    minutes: field(mi, 0, 59, 'minute'),
    hours: field(h, 0, 23, 'heure'),
    days: field(d, 1, 31, 'jour'),
    months: field(mo, 1, 12, 'mois', MONTHS),
    weekdays,
    dayRestricted: d !== '*',
    weekdayRestricted: wd !== '*',
  };
}

function dayMatches(s: CronSchedule, t: Date): boolean {
  const dom = s.days.has(t.getDate());
  const dow = s.weekdays.has(t.getDay());
  if (s.dayRestricted && s.weekdayRestricted) return dom || dow;
  if (s.dayRestricted) return dom;
  if (s.weekdayRestricted) return dow;
  return true;
}

/** First minute strictly after `after` matching the schedule (local time), or null within 5 years. */
export function nextCronRun(s: CronSchedule, after: Date): Date | null {
  const t = new Date(after.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const limit = after.getTime() + 5 * 366 * 86_400_000;
  while (t.getTime() <= limit) {
    if (!s.months.has(t.getMonth() + 1)) {
      t.setMonth(t.getMonth() + 1, 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(s, t)) {
      t.setDate(t.getDate() + 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!s.hours.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!s.minutes.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1, 0, 0);
      continue;
    }
    return t;
  }
  return null;
}

export function nextCronRuns(expression: string, after: Date, count: number): Date[] {
  const s = parseCron(expression);
  const out: Date[] = [];
  let cur = after;
  while (out.length < count) {
    const n = nextCronRun(s, cur);
    if (!n) break;
    out.push(n);
    cur = n;
  }
  return out;
}
