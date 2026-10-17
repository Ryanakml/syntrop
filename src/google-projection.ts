import { createHash } from 'node:crypto';
import { LifeError } from './db.ts';
import { addDays, dateKey, localDate, localTime, timestamp, weekStart } from './time.ts';
import type { Row } from './core.ts';
import type {
  GoogleEvent,
  GoogleEventLabel,
  PresentationConfig,
  Projection,
  ProjectionConfig,
  Snapshot,
} from './google-types.ts';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
export const COLORS: Record<string, string> = {
  career: '9',
  oss: '3',
  learning: '7',
  review: '8',
  default: '1',
  habit: '10',
};
export const PALETTE_HEX: Record<string, string> = {
  '1': '#7986cb',
  '2': '#33b679',
  '3': '#8e24aa',
  '4': '#e67c73',
  '5': '#f6bf26',
  '6': '#f4511e',
  '7': '#039be5',
  '8': '#616161',
  '9': '#3f51b5',
  '10': '#0b8043',
  '11': '#d50000',
};

/** Google IDs allow the base32hex alphabet. Hex SHA-256 is a valid subset. */
export function eventIdentity(workspaceId: string, key: string): string {
  return `s${hash(JSON.stringify([workspaceId, key]))}`;
}

/** Google Calendar custom eventLabels require UUID-formatted IDs per calendar. */
export function labelIdentity(workspaceId: string, labelKey: string): string {
  const h = hash(JSON.stringify(['label', workspaceId, labelKey.toLowerCase()]));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function parseHexRgb(hex: string): [number, number, number] {
  const clean = hex.replace(/^#/, '');
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16),
  ];
}

/** Choose the closest supported Google Calendar colorId for a #RRGGBB color. */
export function nearestColorId(hex: string, catalog?: Record<string, unknown>): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return COLORS.default!;
  const [r1, g1, b1] = parseHexRgb(hex);
  const candidates = Object.entries(PALETTE_HEX).map(([id, fallbackHex]) => {
    const entry = catalog?.[id] as { background?: string } | undefined;
    const candidateHex =
      entry?.background && /^#[0-9a-fA-F]{6}$/.test(entry.background)
        ? entry.background
        : fallbackHex;
    return [id, candidateHex] as const;
  });
  let bestId = '1';
  let bestDist = Number.POSITIVE_INFINITY;
  for (const [id, candidateHex] of candidates) {
    if (catalog && Object.keys(catalog).length > 0 && !Object.hasOwn(catalog, id)) continue;
    const [r2, g2, b2] = parseHexRgb(candidateHex);
    const dist = (r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      bestId = id;
    }
  }
  return bestId;
}

export function sanitizeDisplayText(value: unknown, maxLength = 120): string {
  return String(value ?? '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/[\r\n\t\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/** Validate and normalize a versioned PresentationConfig against the local workspace snapshot. */
export function validatePresentation(
  input: unknown,
  snapshot?: Snapshot,
  existingCategories?: Record<string, string>,
): PresentationConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new LifeError('VALIDATION', 'Presentation configuration must be a JSON object');
  const raw = input as Record<string, unknown>;
  const version = raw.version === undefined ? 1 : Number(raw.version);
  if (version !== 1)
    throw new LifeError('VALIDATION', 'Presentation configuration version must be 1');

  const labels: Record<string, { name: string; color: string; colorId?: string }> = {};
  const rawTheme = (raw.theme ?? {}) as Record<string, unknown>;
  if (rawTheme !== null && (typeof rawTheme !== 'object' || Array.isArray(rawTheme)))
    throw new LifeError('VALIDATION', 'Presentation theme must be an object');
  const rawLabels = (rawTheme.labels ?? raw.labels ?? {}) as Record<string, unknown>;
  if (typeof rawLabels !== 'object' || Array.isArray(rawLabels))
    throw new LifeError('VALIDATION', 'Presentation theme.labels must be an object');
  const labelEntries = Object.entries(rawLabels);
  if (labelEntries.length > 25)
    throw new LifeError('VALIDATION', 'Presentation supports at most 25 custom labels');
  for (const [key, val] of labelEntries) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,49}$/.test(key))
      throw new LifeError('VALIDATION', `Invalid presentation label key: ${key}`);
    if (!val || typeof val !== 'object' || Array.isArray(val))
      throw new LifeError('VALIDATION', `Presentation label ${key} must be an object`);
    const item = val as Record<string, unknown>;
    const rawName = String(item.name ?? '').trim();
    if (!rawName || rawName.length > 16)
      throw new LifeError('VALIDATION', `Presentation label ${key} name must be 1..16 characters`);
    const name = sanitizeDisplayText(rawName, 16);
    if (!name) throw new LifeError('VALIDATION', `Presentation label ${key} requires a name`);
    const color = String(item.color ?? item.backgroundColor ?? '').trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(color))
      throw new LifeError(
        'VALIDATION',
        `Presentation label ${key} color must be #RRGGBB hexadecimal`,
      );
    let colorId: string | undefined;
    if (item.colorId !== undefined) {
      colorId = String(item.colorId);
      if (!Object.hasOwn(PALETTE_HEX, colorId))
        throw new LifeError('VALIDATION', `Presentation label ${key} colorId must be 1..11`);
    } else {
      colorId = nearestColorId(color.toLowerCase());
    }
    labels[key] = { name, color: color.toLowerCase(), ...(colorId ? { colorId } : {}) };
  }

  const validLabelRef = (ref: unknown, contextName: string): string | undefined => {
    if (ref === undefined || ref === null || ref === '') return undefined;
    const key = String(ref).trim();
    if (!Object.hasOwn(labels, key) && !Object.hasOwn(COLORS, key))
      throw new LifeError(
        'VALIDATION',
        `${contextName} references undefined presentation label: ${key}`,
      );
    return key;
  };

  const sessionPrefix =
    rawTheme.sessionPrefix === undefined ? 'project' : String(rawTheme.sessionPrefix);
  if (!['project', 'label', 'none'].includes(sessionPrefix))
    throw new LifeError('VALIDATION', 'theme.sessionPrefix must be project, label, or none');

  const rawDefaults = (raw.defaults ?? {}) as Record<string, unknown>;
  const defaults = {
    ...(validLabelRef(rawDefaults.sessionLabel, 'defaults.sessionLabel')
      ? { sessionLabel: validLabelRef(rawDefaults.sessionLabel, 'defaults.sessionLabel') }
      : {}),
    ...(validLabelRef(rawDefaults.commitmentLabel, 'defaults.commitmentLabel')
      ? { commitmentLabel: validLabelRef(rawDefaults.commitmentLabel, 'defaults.commitmentLabel') }
      : {}),
    ...(validLabelRef(rawDefaults.deadlineLabel, 'defaults.deadlineLabel')
      ? { deadlineLabel: validLabelRef(rawDefaults.deadlineLabel, 'defaults.deadlineLabel') }
      : {}),
    ...(validLabelRef(rawDefaults.habitLabel, 'defaults.habitLabel')
      ? { habitLabel: validLabelRef(rawDefaults.habitLabel, 'defaults.habitLabel') }
      : {}),
  };

  const projects: NonNullable<PresentationConfig['projects']> = {};
  if (existingCategories) {
    for (const [projId, cat] of Object.entries(existingCategories)) {
      if (Object.hasOwn(labels, cat) || Object.hasOwn(COLORS, cat)) {
        projects[projId] = { label: cat };
      }
    }
  }
  const rawProjects = (raw.projects ?? {}) as Record<string, unknown>;
  if (typeof rawProjects !== 'object' || Array.isArray(rawProjects))
    throw new LifeError('VALIDATION', 'Presentation projects must be an object');
  for (const [projId, val] of Object.entries(rawProjects)) {
    if (snapshot && !snapshot.projects.some((p) => String(p.id) === projId))
      throw new LifeError('NOT_FOUND', `Presentation references unknown project: ${projId}`);
    if (!val || typeof val !== 'object' || Array.isArray(val))
      throw new LifeError('VALIDATION', `Project presentation for ${projId} must be an object`);
    const item = val as Record<string, unknown>;
    const label = validLabelRef(item.label, `projects.${projId}`);
    const shortName =
      item.shortName !== undefined ? sanitizeDisplayText(item.shortName, 40) : undefined;
    if (item.shortName !== undefined && !shortName)
      throw new LifeError('VALIDATION', `Project ${projId} shortName cannot be empty`);
    projects[projId] = {
      ...projects[projId],
      ...(label ? { label } : {}),
      ...(shortName ? { shortName } : {}),
    };
  }

  const tasks: NonNullable<PresentationConfig['tasks']> = {};
  const rawTasks = (raw.tasks ?? {}) as Record<string, unknown>;
  if (typeof rawTasks !== 'object' || Array.isArray(rawTasks))
    throw new LifeError('VALIDATION', 'Presentation tasks must be an object');
  for (const [taskId, val] of Object.entries(rawTasks)) {
    if (snapshot && !snapshot.tasks.some((t) => String(t.id) === taskId))
      throw new LifeError('NOT_FOUND', `Presentation references unknown task: ${taskId}`);
    if (!val || typeof val !== 'object' || Array.isArray(val))
      throw new LifeError('VALIDATION', `Task presentation for ${taskId} must be an object`);
    const item = val as Record<string, unknown>;
    const label = validLabelRef(item.label, `tasks.${taskId}`);
    const shortTitle =
      item.shortTitle !== undefined ? sanitizeDisplayText(item.shortTitle, 100) : undefined;
    if (item.shortTitle !== undefined && !shortTitle)
      throw new LifeError('VALIDATION', `Task ${taskId} shortTitle cannot be empty`);
    const scheduledDate =
      item.scheduledDate !== undefined && item.scheduledDate !== null && item.scheduledDate !== ''
        ? dateKey(String(item.scheduledDate))
        : undefined;
    const publish = typeof item.publish === 'boolean' ? item.publish : undefined;
    tasks[taskId] = {
      ...(shortTitle ? { shortTitle } : {}),
      ...(label ? { label } : {}),
      ...(publish !== undefined ? { publish } : {}),
      ...(scheduledDate ? { scheduledDate } : {}),
    };
  }

  const habits: NonNullable<PresentationConfig['habits']> = {};
  const rawHabits = (raw.habits ?? {}) as Record<string, unknown>;
  if (typeof rawHabits !== 'object' || Array.isArray(rawHabits))
    throw new LifeError('VALIDATION', 'Presentation habits must be an object');
  for (const [habitId, val] of Object.entries(rawHabits)) {
    if (snapshot && !snapshot.habits.some((h) => String(h.id) === habitId))
      throw new LifeError('NOT_FOUND', `Presentation references unknown habit: ${habitId}`);
    if (!val || typeof val !== 'object' || Array.isArray(val))
      throw new LifeError('VALIDATION', `Habit presentation for ${habitId} must be an object`);
    const item = val as Record<string, unknown>;
    const label = validLabelRef(item.label, `habits.${habitId}`);
    const shortName =
      item.shortName !== undefined ? sanitizeDisplayText(item.shortName, 80) : undefined;
    if (item.shortName !== undefined && !shortName)
      throw new LifeError('VALIDATION', `Habit ${habitId} shortName cannot be empty`);
    habits[habitId] = {
      ...(shortName ? { shortName } : {}),
      ...(label ? { label } : {}),
    };
  }

  return {
    version: 1,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    theme: {
      name: sanitizeDisplayText(rawTheme.name || 'adaptive-default', 50) || 'adaptive-default',
      style: sanitizeDisplayText(rawTheme.style || 'minimal', 30) || 'minimal',
      sessionPrefix: sessionPrefix as 'project' | 'label' | 'none',
      labels,
    },
    defaults,
    projects,
    tasks,
    habits,
  };
}

/** Build deterministic Google Calendar custom eventLabels for defined presentation labels. */
export function desiredCalendarLabels(config: ProjectionConfig): Record<string, GoogleEventLabel> {
  const result: Record<string, GoogleEventLabel> = {};
  const labels = config.presentation?.theme?.labels ?? {};
  for (const [key, def] of Object.entries(labels)) {
    result[key] = {
      id: labelIdentity(config.workspaceId, key),
      name: def.name.slice(0, 50),
      backgroundColor: def.color.toLowerCase(),
    };
  }
  return result;
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
  const managedLabelId =
    event.extendedProperties?.private?.syntrop_label ??
    (event.eventLabelId && !event.colorId ? event.eventLabelId : undefined);
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
      colorId: managedLabelId ? '' : (event.colorId ?? ''),
      ...(managedLabelId ? { eventLabelId: managedLabelId } : {}),
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

function resolveColorAndLabel(
  labelKey: string | undefined,
  fallbackColorId: string,
  config: ProjectionConfig,
  colors?: Record<string, unknown>,
  activeLabelIds?: Record<string, string>,
): { colorId: string; eventLabelId?: string } {
  const key = labelKey ?? 'default';
  const customLabel = config.presentation?.theme?.labels?.[key];
  const colorId = customLabel
    ? (customLabel.colorId ?? nearestColorId(customLabel.color, colors))
    : (COLORS[key] ?? fallbackColorId);
  const eventLabelId = activeLabelIds?.[key];
  return { colorId, ...(eventLabelId ? { eventLabelId } : {}) };
}

function formatSessionTitle(task: Row, config: ProjectionConfig, labelKey: string): string {
  if (config.titleMode !== 'titles') return 'Focus';
  if (!config.presentation) return title('Focus', task.title, config);
  const taskId = String(task.id);
  const projectId = task.project_id ? String(task.project_id) : '';
  const taskPres = config.presentation.tasks?.[taskId];
  const projPres = projectId ? config.presentation.projects?.[projectId] : undefined;
  let base = taskPres?.shortTitle
    ? sanitizeDisplayText(taskPres.shortTitle, 100)
    : title('Focus', task.title, config).trim();
  if (
    !taskPres?.shortTitle &&
    ['minimal', 'compact'].includes(config.presentation.theme?.style ?? '') &&
    base.length > 68
  ) {
    const stripped = base
      .replace(/\s*\([^)]*\)\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (stripped.length >= 16) base = stripped;
    if (base.length > 68) {
      const cut = base.slice(0, 65);
      const lastSpace = cut.lastIndexOf(' ');
      base = (lastSpace >= 24 ? cut.slice(0, lastSpace) : cut).replace(/[·:,-]+$/, '').trim();
    }
  }
  const prefixMode = config.presentation.theme?.sessionPrefix ?? 'project';
  let prefix = '';
  if (prefixMode === 'project' && projPres?.shortName) {
    prefix = projPres.shortName;
  } else if (prefixMode === 'label') {
    prefix = config.presentation.theme?.labels?.[labelKey]?.name ?? '';
  }
  if (
    prefix &&
    !base.toLowerCase().startsWith(`${prefix.toLowerCase()} · `) &&
    !base.toLowerCase().startsWith(`${prefix.toLowerCase()}:`)
  ) {
    return `${prefix} · ${base}`.slice(0, 120);
  }
  return base.slice(0, 120);
}

export function projectEvents(
  snapshot: Snapshot,
  config: ProjectionConfig,
  from: string,
  through: string,
  colors?: Record<string, unknown>,
  activeLabelIds?: Record<string, string>,
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
    eventLabelId?: string,
  ) {
    if (eventLabelId) {
      event.eventLabelId = eventLabelId;
    } else if (colors && Object.hasOwn(colors, color)) {
      event.colorId = color;
    }
    event.visibility = 'private';
    event.reminders ??= { useDefault: false };
    event.id = eventIdentity(config.workspaceId, key);
    event.extendedProperties = {
      private: {
        syntrop_workspace: config.workspaceId,
        syntrop_key: key,
        syntrop_projection: '1',
        ...(eventLabelId ? { syntrop_label: eventLabelId } : {}),
      },
    };
    event.extendedProperties.private!.syntrop_hash = eventFingerprint(event);
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
    const projectId = String(task.project_id ?? '');
    const labelKey =
      config.presentation?.tasks?.[String(task.id)]?.label ??
      config.presentation?.projects?.[projectId]?.label ??
      config.categories[projectId] ??
      config.presentation?.defaults?.sessionLabel ??
      'default';
    const resolved = resolveColorAndLabel(
      labelKey,
      COLORS.default!,
      config,
      colors,
      activeLabelIds,
    );
    emit(
      `session:${session.id}`,
      'focus',
      session,
      {
        summary: formatSessionTitle(task, config, labelKey),
        description: `Syntrop source: session:${session.id}`,
        start: { dateTime: timestamp(String(session.start_at)), timeZone: snapshot.timezone },
        end: { dateTime: timestamp(String(session.end_at)), timeZone: snapshot.timezone },
        transparency: 'opaque',
      },
      resolved.colorId,
      resolved.eventLabelId,
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
      const labelKey = config.presentation?.defaults?.commitmentLabel ?? 'default';
      const resolved = resolveColorAndLabel(
        labelKey,
        COLORS.default!,
        config,
        colors,
        activeLabelIds,
      );
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
        resolved.colorId,
        resolved.eventLabelId,
      );
    }
  if (config.deadlines)
    for (const task of snapshot.tasks) {
      if (!taskActive(task) || !task.due_at) continue;
      const date = localDate(String(task.due_at), snapshot.timezone);
      if (date < fromDate || date > throughDate) continue;
      const labelKey = config.presentation?.defaults?.deadlineLabel ?? 'review';
      const resolved = resolveColorAndLabel(labelKey, '8', config, colors, activeLabelIds);
      const summarySource = config.presentation?.tasks?.[String(task.id)]?.shortTitle ?? task.title;
      emit(
        `deadline:${task.id}`,
        'focus',
        task,
        {
          summary: title('Deadline', summarySource, config),
          description: `Syntrop source: deadline:${task.id}`,
          start: { date },
          end: { date: addDays(date, 1) },
          transparency: 'transparent',
        },
        resolved.colorId,
        resolved.eventLabelId,
      );
    }
  for (const habit of snapshot.habits) {
    const display = config.habits[String(habit.id)];
    if (!habit.active || !display || display.mode === 'none' || display.mode === 'tasks') continue;
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
    const habitName = config.presentation?.habits?.[String(habit.id)]?.shortName ?? habit.name;
    const event: GoogleEvent = {
      summary: `${title('Habit', habitName, config)}${weekReminder ? ' (weekly reminder)' : ''}`,
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
    const labelKey =
      config.presentation?.habits?.[String(habit.id)]?.label ??
      config.presentation?.defaults?.habitLabel ??
      'habit';
    const resolved = resolveColorAndLabel(labelKey, '10', config, colors);
    emit(`habit:${habit.id}`, 'habits', habit, event, resolved.colorId);
  }
  return output.sort((a, b) => a.key.localeCompare(b.key));
}
