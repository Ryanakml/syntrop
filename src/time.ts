import { LifeError } from './db.ts';

export function timestamp(value: string): string {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match)
    throw new LifeError(
      'VALIDATION',
      'Time must be ISO 8601 with a timezone offset, for example 2026-10-15T09:00+07:00',
    );
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new LifeError('VALIDATION', `Invalid time: ${value}`);
  const [, year, month, day, hour, minute, second, , , sign, offsetHour, offsetMinute] = match;
  const offset = sign
    ? (sign === '+' ? 1 : -1) * (Number(offsetHour) * 60 + Number(offsetMinute))
    : 0;
  const wall = new Date(date.getTime() + offset * 60_000);
  if (
    wall.getUTCFullYear() !== Number(year) ||
    wall.getUTCMonth() + 1 !== Number(month) ||
    wall.getUTCDate() !== Number(day) ||
    wall.getUTCHours() !== Number(hour) ||
    wall.getUTCMinutes() !== Number(minute) ||
    wall.getUTCSeconds() !== Number(second ?? 0)
  )
    throw new LifeError('VALIDATION', `Invalid time: ${value}`);
  return date.toISOString();
}

export function dateKey(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  )
    throw new LifeError('VALIDATION', `Invalid date: ${value}`);
  return value;
}

export function localDate(instant: string | Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant instanceof Date ? instant : new Date(instant));
  const get = (name: string) => parts.find((part) => part.type === name)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function localTime(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const get = (name: string) => parts.find((part) => part.type === name)?.value;
  return `${localDate(instant, timezone)} ${get('hour')}:${get('minute')}`;
}

export function addDays(key: string, count: number): string {
  const date = new Date(`${dateKey(key)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

export function weekStart(key: string): string {
  const day = new Date(`${dateKey(key)}T00:00:00Z`).getUTCDay();
  return addDays(key, -((day + 6) % 7));
}

export function inDateRange(
  start: string,
  end: string,
  from: string,
  through: string,
  timezone: string,
): boolean {
  const first = localDate(start, timezone);
  const last = localDate(new Date(new Date(end).getTime() - 1), timezone);
  return first <= through && last >= from;
}
