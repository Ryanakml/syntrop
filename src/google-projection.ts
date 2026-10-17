import { createHash } from 'node:crypto';
import { LifeError } from './db.ts';
import { addDays, dateKey, localDate, localTime, timestamp, weekStart } from './time.ts';
import type { Row } from './core.ts';
import type { GoogleEvent, Projection, ProjectionConfig, Snapshot } from './google-types.ts';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const COLORS = { career: '9', oss: '3', learning: '7', review: '8', default: '1' };

/** Google IDs allow the base32hex alphabet. Hex SHA-256 is a valid subset. */
export function eventIdentity(workspaceId: string, key: string): string {
  return `s${hash(JSON.stringify([workspaceId, key]))}`;
}

/** Compare only fields owned by Syntrop, normalizing provider defaults and offsets. */
export function eventFingerprint(event: GoogleEvent): string {
  const when = (value: GoogleEvent['start']) =>
    value?.date
      ? { date: value.date }
      : value?.dateTime
        ? { dateTime: timestamp(value.dateTime) }
        : null;
  const recurrence = [...(event.recurrence ?? [])].sort();
  return hash(
    JSON.stringify({
      summary: event.summary ?? '',
      description: event.description ?? '',
      start: when(event.start),
      end: when(event.end),
      // The zone controls recurrence expansion; offsets alone cannot describe DST.
      recurrenceTimezone: recurrence.length
        ? (event.start?.timeZone ?? event.end?.timeZone ?? '')
        : '',
      recurrence,
      transparency: event.transparency ?? 'opaque',
      visibility: event.visibility ?? 'default',
      colorId: event.colorId ?? '',
      reminders: {
        useDefault: event.reminders?.useDefault ?? true,
        overrides: (event.reminders?.overrides ?? [])
          .map(({ method, minutes }) => ({ method, minutes }))
          .sort((a, b) => a.method.localeCompare(b.method) || a.minutes - b.minutes),
      },
    }),
  );
}

/** Reject gaps and overlaps instead of silently shifting an intended wall time. */
function wallInstant(date: string, time: string, timezone: string): string {
  dateKey(date);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))
    throw new LifeError('VALIDATION', 'Habit time must be HH:MM');
  const naive = Date.parse(`${date}T${time}:00Z`);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const offsets = new Set<number>();
  // Sample both sides of timezone transitions, including half-hour changes.
  for (let hours = -48; hours <= 48; hours += 6) {
    const probe = naive + hours * 3_600_000;
    const parts = formatter.formatToParts(new Date(probe));
    const part = (type: string) => Number(parts.find((item) => item.type === type)?.value);
    offsets.add(
      Date.UTC(
        part('year'),
        part('month') - 1,
        part('day'),
        part('hour'),
        part('minute'),
        part('second'),
      ) - probe,
    );
  }
  const matches = [...offsets]
    .map((offset) => new Date(naive - offset).toISOString())
    .filter((instant) => localTime(instant, timezone) === `${date} ${time}`);
  if (matches.length !== 1)
    throw new LifeError(
      'VALIDATION',
      `Habit wall time ${date} ${time} is ${matches.length ? 'ambiguous' : 'nonexistent'} in ${timezone}; select another start date/time`,
    );
  return matches[0]!;
}

function title(kind: string, value: unknown, config: ProjectionConfig): string {
  if (config.titleMode !== 'titles') return kind;
  return String(value || kind)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/[\r\n\t\u0000-\u001f]/g, ' ')
    .slice(0, 120);
}

export function projectEvents(
  snapshot: Snapshot,
  config: ProjectionConfig,
  from: string,
  through: string,
  colors?: Record<string, unknown>,
): Projection[] {
  // Validate the IANA zone even if there are no projected records.
  new Intl.DateTimeFormat('en-US', { timeZone: snapshot.timezone }).format(0);
  const fromDate = dateKey(from);
  const throughDate = dateKey(through);
  if (fromDate > throughDate) throw new LifeError('VALIDATION', 'Projection window is reversed');
  const projects = new Map(snapshot.projects.map((row) => [String(row.id), row]));
  const tasks = new Map(snapshot.tasks.map((row) => [String(row.id), row]));
  const taskActive = (task: Row) =>
    !['done', 'cancelled'].includes(String(task.status)) &&
    (!task.project_id || projects.get(String(task.project_id))?.status === 'active');
  const inWindow = (start: string, end: string): boolean => {
    const a = timestamp(start),
      b = timestamp(end);
    if (a >= b) throw new LifeError('VALIDATION', 'Projected event end must follow start');
    return (
      localDate(new Date(Date.parse(b) - 1), snapshot.timezone) >= fromDate &&
      localDate(a, snapshot.timezone) <= throughDate
    );
  };
  const output: Projection[] = [];
  function emit(
    key: string,
    calendar: Projection['calendar'],
    row: Row,
    event: GoogleEvent,
    color: string,
  ) {
    if (colors && Object.hasOwn(colors, color)) event.colorId = color;
    event.visibility = 'private';
    event.reminders ??= { useDefault: false };
    event.id = eventIdentity(config.workspaceId, key);
    event.extendedProperties = {
      private: {
        syntrop_workspace: config.workspaceId,
        syntrop_key: key,
        syntrop_projection: '1',
        syntrop_hash: eventFingerprint(event),
      },
    };
    output.push({ key, calendar, sourceVersion: Number(row.version ?? 1), event });
  }
  for (const session of snapshot.work_sessions) {
    const task = tasks.get(String(session.task_id));
    if (
      session.status !== 'scheduled' ||
      !task ||
      !taskActive(task) ||
      !inWindow(String(session.start_at), String(session.end_at))
    )
      continue;
    emit(
      `session:${session.id}`,
      'focus',
      session,
      {
        summary: title('Focus', task.title, config),
        description: `Syntrop source: session:${session.id}`,
        start: { dateTime: timestamp(String(session.start_at)), timeZone: snapshot.timezone },
        end: { dateTime: timestamp(String(session.end_at)), timeZone: snapshot.timezone },
        transparency: 'opaque',
      },
      COLORS[config.categories[String(task.project_id)] ?? 'default'],
    );
  }
  if (config.commitments)
    for (const commitment of snapshot.calendar_events) {
      if (
        commitment.status === 'cancelled' ||
        config.excludeCommitments.includes(String(commitment.id)) ||
        !inWindow(String(commitment.start_at), String(commitment.end_at))
      )
        continue;
      emit(
        `commitment:${commitment.id}`,
        'focus',
        commitment,
        {
          summary: title('Commitment', commitment.title, config),
          description: `Syntrop source: commitment:${commitment.id}`,
          start: { dateTime: timestamp(String(commitment.start_at)), timeZone: snapshot.timezone },
          end: { dateTime: timestamp(String(commitment.end_at)), timeZone: snapshot.timezone },
          transparency: 'opaque',
        },
        COLORS.default,
      );
    }
  if (config.deadlines)
    for (const task of snapshot.tasks) {
      if (!taskActive(task) || !task.due_at) continue;
      const date = localDate(String(task.due_at), snapshot.timezone);
      if (date < fromDate || date > throughDate) continue;
      emit(
        `deadline:${task.id}`,
        'focus',
        task,
        {
          summary: title('Deadline', task.title, config),
          description: `Syntrop source: deadline:${task.id}`,
          start: { date },
          end: { date: addDays(date, 1) },
          transparency: 'transparent',
        },
        '8',
      );
    }
  for (const habit of snapshot.habits) {
    const display = config.habits[String(habit.id)];
    if (!habit.active || !display || display.mode === 'none') continue;
    const weekly = habit.frequency === 'weekly';
    const weekdays = [...new Set(display.weekdays ?? [])];
    if (weekdays.some((day) => !DAYS.includes(day)))
      throw new LifeError('VALIDATION', 'Habit weekdays must be MO,TU,WE,TH,FR,SA,SU');
    weekdays.sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b));
    if (!display.startDate)
      throw new LifeError('VALIDATION', 'Habit display requires an explicit startDate');
    let anchor = dateKey(display.startDate);
    const weekReminder = weekly && !weekdays.length && display.mode === 'flexible';
    if (weekReminder) anchor = weekStart(anchor);
    // A recurrence is a stable series; never re-anchor it to the current sync date.
    if (anchor > throughDate) continue;
    if (weekly && weekdays.length) {
      for (let i = 0; i < 7; i++) {
        const day = new Date(`${anchor}T00:00:00Z`).getUTCDay();
        if (weekdays.includes(DAYS[(day + 6) % 7]!)) break;
        anchor = addDays(anchor, 1);
      }
    }
    if (anchor > throughDate) continue;
    const event: GoogleEvent = {
      summary: `${title('Habit', habit.name, config)}${weekReminder ? ' (weekly reminder)' : ''}`,
      description: `Syntrop source: habit:${habit.id}${weekReminder ? '\nFlexible weekly target; this is a week-level reminder, not a scheduled occurrence.' : ''}`,
      recurrence: [
        `RRULE:FREQ=${weekly ? 'WEEKLY' : 'DAILY'}${weekly ? ';WKST=MO' : ''}${weekly && weekdays.length ? `;BYDAY=${weekdays.join(',')}` : ''}`,
      ],
      transparency: 'transparent',
    };
    if (display.mode === 'timed') {
      if (
        !display.time ||
        !Number.isSafeInteger(display.duration) ||
        display.duration! <= 0 ||
        (weekly && !weekdays.length)
      )
        throw new LifeError(
          'VALIDATION',
          'Timed habits need time, positive duration, and weekly weekdays',
        );
      // Google expands the native series in this zone. Reject problematic wall times
      // already visible in this bounded preview; never silently pick a DST fold.
      let occurrence = anchor > fromDate ? anchor : fromDate;
      let checkedDays = 0;
      for (; occurrence <= throughDate; occurrence = addDays(occurrence, 1)) {
        if (++checkedDays > 367)
          throw new LifeError('VALIDATION', 'Habit projection horizon exceeds 367 days');
        const day = new Date(`${occurrence}T00:00:00Z`).getUTCDay();
        if (!weekly || weekdays.includes(DAYS[(day + 6) % 7]!))
          wallInstant(occurrence, display.time, snapshot.timezone);
      }
      const start = wallInstant(anchor, display.time, snapshot.timezone);
      event.start = { dateTime: start, timeZone: snapshot.timezone };
      event.end = {
        dateTime: new Date(Date.parse(start) + display.duration! * 60_000).toISOString(),
        timeZone: snapshot.timezone,
      };
      event.transparency = 'opaque';
    } else {
      event.start = { date: anchor };
      event.end = { date: addDays(anchor, weekReminder ? 7 : 1) };
    }
    if (display.reminderMinutes !== undefined) {
      if (
        !Number.isSafeInteger(display.reminderMinutes) ||
        display.reminderMinutes < 0 ||
        display.reminderMinutes > 40320
      )
        throw new LifeError('VALIDATION', 'Habit popup reminder must be 0..40320 minutes');
      event.reminders = {
        useDefault: false,
        overrides: [{ method: 'popup', minutes: display.reminderMinutes }],
      };
    }
    emit(`habit:${habit.id}`, 'habits', habit, event, '10');
  }
  return output.sort((a, b) => a.key.localeCompare(b.key));
}
