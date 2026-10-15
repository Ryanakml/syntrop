import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { LifeError } from './db.ts';
import { timestamp, dateKey, localDate, addDays, weekStart, inDateRange } from './time.ts';

export type Row = Record<string, string | number | null>;
export const now = () => new Date().toISOString();
export const id = (prefix: string) => `${prefix}_${randomUUID()}`;
export const get = (db: DatabaseSync, table: string, key: string): Row => {
  const allowed = [
    'goals',
    'projects',
    'tasks',
    'work_sessions',
    'calendar_events',
    'habits',
    'habit_occurrences',
    'decisions',
  ];
  if (!allowed.includes(table)) throw new Error('Invalid table');
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(key) as Row | undefined;
  if (!row) throw new LifeError('NOT_FOUND', `${table.slice(0, -1)} ${key} not found`);
  return row;
};
export const rows = (db: DatabaseSync, sql: string, ...params: (string | number | null)[]): Row[] =>
  db.prepare(sql).all(...params) as Row[];
export const text = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim())
    throw new LifeError('VALIDATION', `${name} is required`);
  return value.trim();
};
export const optionalText = (value: unknown, name: string): string =>
  value === undefined ? '' : text(value, name);
export const choice = (value: string, choices: readonly string[], name: string): string => {
  if (!choices.includes(value))
    throw new LifeError('VALIDATION', `${name} must be one of: ${choices.join(', ')}`);
  return value;
};
export const integer = (
  value: string | undefined,
  name: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number => {
  const parsed = Number(value);
  if (!value || !Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new LifeError('VALIDATION', `${name} must be an integer from ${min} to ${max}`);
  return parsed;
};
export const maybeId = (db: DatabaseSync, table: string, key?: string): string | null =>
  key ? String(get(db, table, key).id) : null;
export const assertVersion = (row: Row, expected?: string): void => {
  if (expected !== undefined && Number(row.version) !== integer(expected, 'expected-version', 1))
    throw new LifeError(
      'STALE_VERSION',
      `Expected version ${expected}, current version ${row.version}`,
    );
};

export function task(
  db: DatabaseSync,
  key: string,
): Row & { blocked_by: string[]; ready: boolean } {
  const item = get(db, 'tasks', key);
  const blocked = rows(
    db,
    `SELECT d.depends_on_id FROM task_dependencies d JOIN tasks prerequisite ON prerequisite.id = d.depends_on_id WHERE d.task_id = ? AND prerequisite.status != 'done' ORDER BY d.depends_on_id`,
    key,
  ).map((row) => String(row.depends_on_id));
  return {
    ...item,
    blocked_by: blocked,
    ready:
      ['inbox', 'todo', 'in_progress'].includes(String(item.status)) &&
      blocked.length === 0 &&
      (!item.project_id || get(db, 'projects', String(item.project_id)).status === 'active'),
  } as Row & { blocked_by: string[]; ready: boolean };
}

export function taskList(db: DatabaseSync, project?: string): ReturnType<typeof task>[] {
  if (project) get(db, 'projects', project);
  return rows(
    db,
    `SELECT id FROM tasks WHERE (? IS NULL OR project_id = ?) ORDER BY CASE status WHEN 'done' THEN 1 WHEN 'cancelled' THEN 2 ELSE 0 END, priority, created_at`,
    project ?? null,
    project ?? null,
  ).map((row) => task(db, String(row.id)));
}

export function addDependency(db: DatabaseSync, taskId: string, prerequisiteId: string): Row {
  const dependent = get(db, 'tasks', taskId);
  if (['done', 'cancelled'].includes(String(dependent.status)))
    throw new LifeError('CONFLICT', 'Dependencies of completed or cancelled tasks are historical');
  const prerequisite = get(db, 'tasks', prerequisiteId);
  if (prerequisite.status === 'cancelled')
    throw new LifeError('CONFLICT', 'A cancelled task cannot become a new prerequisite');
  if (taskId === prerequisiteId) throw new LifeError('CYCLE', 'Task cannot depend on itself');
  const cycle = db
    .prepare(
      `WITH RECURSIVE ancestors(id) AS (
    SELECT depends_on_id FROM task_dependencies WHERE task_id = ?
    UNION SELECT d.depends_on_id FROM task_dependencies d JOIN ancestors a ON d.task_id = a.id
  ) SELECT 1 AS found FROM ancestors WHERE id = ? LIMIT 1`,
    )
    .get(prerequisiteId, taskId);
  if (cycle) throw new LifeError('CYCLE', 'Dependency would create a cycle');
  db.prepare('INSERT OR IGNORE INTO task_dependencies(task_id, depends_on_id) VALUES (?, ?)').run(
    taskId,
    prerequisiteId,
  );
  return task(db, taskId);
}

export function assertNoConflict(
  db: DatabaseSync,
  start: string,
  end: string,
  except?: string,
): void {
  if (end <= start) throw new LifeError('VALIDATION', 'End must be after start');
  const collisions = [
    ...rows(
      db,
      `SELECT id, 'session' AS kind FROM work_sessions WHERE status = 'scheduled' AND start_at < ? AND end_at > ? AND id != ?`,
      end,
      start,
      except ?? '',
    ),
    ...rows(
      db,
      `SELECT id, 'event' AS kind FROM calendar_events WHERE status = 'scheduled' AND start_at < ? AND end_at > ? AND id != ?`,
      end,
      start,
      except ?? '',
    ),
  ];
  if (collisions.length)
    throw new LifeError(
      'SCHEDULE_CONFLICT',
      `Time overlaps ${collisions.map((row) => `${row.kind} ${row.id}`).join(', ')}`,
    );
}

export function addSession(
  db: DatabaseSync,
  taskId: string,
  startValue: string,
  endValue: string,
  note = '',
): Row {
  const item = get(db, 'tasks', taskId);
  if (['done', 'cancelled'].includes(String(item.status)))
    throw new LifeError('VALIDATION', 'Cannot schedule a completed or cancelled task');
  if (item.project_id && get(db, 'projects', String(item.project_id)).status !== 'active')
    throw new LifeError('CONFLICT', 'Cannot schedule work in a non-active project');
  const start = timestamp(startValue),
    end = timestamp(endValue);
  assertNoConflict(db, start, end);
  const key = id('ses'),
    at = now();
  db.prepare(
    'INSERT INTO work_sessions(id, task_id, start_at, end_at, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(key, taskId, start, end, note, at, at);
  return get(db, 'work_sessions', key);
}

export function addEvent(
  db: DatabaseSync,
  title: string,
  startValue: string,
  endValue: string,
  note = '',
): Row {
  const start = timestamp(startValue),
    end = timestamp(endValue);
  assertNoConflict(db, start, end);
  const key = id('evt'),
    at = now();
  db.prepare(
    'INSERT INTO calendar_events(id, title, start_at, end_at, note, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(key, text(title, 'title'), start, end, note, at, at);
  return get(db, 'calendar_events', key);
}

export function moveTime(
  db: DatabaseSync,
  table: 'work_sessions' | 'calendar_events',
  key: string,
  startValue: string,
  endValue: string,
  expected?: string,
): Row {
  const item = get(db, table, key);
  assertVersion(item, expected);
  if (item.status === 'cancelled')
    throw new LifeError('CONFLICT', 'Cancelled sessions or events cannot be moved');
  if (table === 'work_sessions' && sessionOutcome(db, key))
    throw new LifeError('CONFLICT', 'Recorded sessions cannot be moved');
  const start = timestamp(startValue),
    end = timestamp(endValue);
  assertNoConflict(db, start, end, key);
  db.prepare(
    `UPDATE ${table} SET start_at = ?, end_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
  ).run(start, end, now(), key);
  return get(db, table, key);
}

export function cancelSession(db: DatabaseSync, key: string, expected?: string): Row {
  const item = get(db, 'work_sessions', key);
  assertVersion(item, expected);
  if (item.status === 'cancelled') throw new LifeError('CONFLICT', 'Session is already cancelled');
  if (sessionOutcome(db, key))
    throw new LifeError('CONFLICT', 'Recorded sessions cannot be cancelled');
  db.prepare(
    `UPDATE work_sessions SET status = 'cancelled', updated_at = ?, version = version + 1 WHERE id = ?`,
  ).run(now(), key);
  return get(db, 'work_sessions', key);
}

function sessionOutcome(db: DatabaseSync, key: string): Row | undefined {
  return db.prepare('SELECT * FROM session_outcomes WHERE session_id = ?').get(key) as
    Row | undefined;
}

export function recordSession(
  db: DatabaseSync,
  key: string,
  outcomeValue: string,
  actualValue: string | undefined,
  note?: string,
  correct = false,
  expected?: string,
): Row {
  const session = get(db, 'work_sessions', key);
  if (session.status !== 'scheduled')
    throw new LifeError('CONFLICT', 'Cancelled sessions have no work outcome');
  if (String(session.end_at) > now())
    throw new LifeError(
      'CONFLICT',
      'A session outcome can only be recorded after its scheduled end',
    );
  const outcome = choice(outcomeValue, ['completed', 'skipped'], 'outcome');
  const actual = integer(actualValue, 'actual-minutes', outcome === 'completed' ? 1 : 0);
  if (outcome === 'skipped' && actual !== 0)
    throw new LifeError('VALIDATION', 'Skipped sessions must have zero actual minutes');
  const existing = sessionOutcome(db, key);
  const noteValue = note ?? (existing ? String(existing.note) : '');
  if (existing) {
    if (!correct) throw new LifeError('CONFLICT', 'Session already recorded; use --correct');
    assertVersion(existing, expected);
    db.prepare(
      'UPDATE session_outcomes SET outcome = ?, actual_minutes = ?, note = ?, recorded_at = ?, version = version + 1 WHERE session_id = ?',
    ).run(outcome, actual, noteValue, now(), key);
  } else {
    if (correct) throw new LifeError('NOT_FOUND', 'No session outcome to correct');
    if (expected !== undefined)
      throw new LifeError('VALIDATION', '--expected-version applies to an existing outcome');
    db.prepare(
      'INSERT INTO session_outcomes(session_id, outcome, actual_minutes, note, recorded_at) VALUES (?, ?, ?, ?, ?)',
    ).run(key, outcome, actual, noteValue, now());
  }
  return sessionOutcome(db, key)!;
}

export function cancelEvent(db: DatabaseSync, key: string, expected?: string): Row {
  const item = get(db, 'calendar_events', key);
  assertVersion(item, expected);
  if (item.status === 'cancelled') throw new LifeError('CONFLICT', 'Event is already cancelled');
  db.prepare(
    `UPDATE calendar_events SET status = 'cancelled', updated_at = ?, version = version + 1 WHERE id = ?`,
  ).run(now(), key);
  return get(db, 'calendar_events', key);
}

export function logHabit(
  db: DatabaseSync,
  habitId: string,
  keyValue: string,
  outcomeValue: string,
  note = '',
  correct = false,
): Row {
  const habit = get(db, 'habits', habitId);
  if (!habit.active) throw new LifeError('VALIDATION', 'Habit is inactive');
  const key = dateKey(keyValue),
    outcome = choice(outcomeValue, ['completed', 'skipped'], 'outcome');
  const existing = db
    .prepare('SELECT * FROM habit_occurrences WHERE habit_id = ? AND occurrence_key = ?')
    .get(habitId, key) as Row | undefined;
  if (existing) {
    if (!correct)
      throw new LifeError(
        'CONFLICT',
        `Habit already recorded for ${key}; use --correct to amend it`,
      );
    db.prepare(
      'UPDATE habit_occurrences SET outcome = ?, note = ?, recorded_at = ?, version = version + 1 WHERE id = ?',
    ).run(outcome, note, now(), String(existing.id));
    return get(db, 'habit_occurrences', String(existing.id));
  }
  if (correct) throw new LifeError('NOT_FOUND', `No habit record for ${key} to correct`);
  const idValue = id('occ');
  db.prepare('INSERT INTO habit_occurrences VALUES (?, ?, ?, ?, ?, ?, 1)').run(
    idValue,
    habitId,
    key,
    outcome,
    note,
    now(),
  );
  return get(db, 'habit_occurrences', idValue);
}

export function view(
  db: DatabaseSync,
  timezone: string,
  from: string,
  through: string,
): {
  from: string;
  through: string;
  timezone: string;
  tasks: ReturnType<typeof task>[];
  sessions: Row[];
  events: Row[];
  habits: (Row & { occurrences: Row[] })[];
} {
  dateKey(from);
  dateKey(through);
  const sessions = rows(
    db,
    `SELECT s.*, t.title AS task_title FROM work_sessions s JOIN tasks t ON t.id = s.task_id WHERE s.status = 'scheduled' ORDER BY s.start_at`,
  ).filter((row) => inDateRange(String(row.start_at), String(row.end_at), from, through, timezone));
  const events = rows(
    db,
    "SELECT * FROM calendar_events WHERE status = 'scheduled' ORDER BY start_at",
  ).filter((row) => inDateRange(String(row.start_at), String(row.end_at), from, through, timezone));
  const scheduledTaskIds = new Set(sessions.map((row) => String(row.task_id)));
  const tasks = taskList(db).filter(
    (row) =>
      !['done', 'cancelled'].includes(String(row.status)) &&
      (scheduledTaskIds.has(String(row.id)) ||
        (row.due_at !== null && localDate(String(row.due_at), timezone) <= through)),
  );
  const habits = rows(db, 'SELECT * FROM habits WHERE active = 1 ORDER BY name').map((row) => ({
    ...row,
    occurrences: rows(
      db,
      'SELECT * FROM habit_occurrences WHERE habit_id = ? AND occurrence_key BETWEEN ? AND ? ORDER BY occurrence_key',
      String(row.id),
      from,
      through,
    ),
  })) as (Row & { occurrences: Row[] })[];
  return { from, through, timezone, tasks, sessions, events, habits };
}

export function dateView(
  db: DatabaseSync,
  timezone: string,
  kind: 'today' | 'tomorrow' | 'week',
  fromOverride?: string,
) {
  const base = fromOverride ? dateKey(fromOverride) : localDate(new Date(), timezone);
  const from = kind === 'week' ? weekStart(base) : kind === 'tomorrow' ? addDays(base, 1) : base;
  return view(db, timezone, from, kind === 'week' ? addDays(from, 6) : from);
}

export function weeklyReview(db: DatabaseSync, timezone: string, date?: string) {
  const base = date ? dateKey(date) : localDate(new Date(), timezone);
  const from = weekStart(base),
    through = addDays(from, 6);
  const generatedAt = now();
  const sessions = rows(
    db,
    `SELECT s.*, t.title AS task_title, o.outcome, o.actual_minutes,
            o.note AS outcome_note, o.recorded_at, o.version AS outcome_version
     FROM work_sessions s JOIN tasks t ON t.id = s.task_id
     LEFT JOIN session_outcomes o ON o.session_id = s.id ORDER BY s.start_at`,
  )
    .filter((row) => inDateRange(String(row.start_at), String(row.end_at), from, through, timezone))
    .map((row) => ({
      ...row,
      evidence:
        row.status === 'cancelled'
          ? 'cancelled'
          : row.outcome
            ? String(row.outcome)
            : String(row.start_at) > generatedAt
              ? 'pending'
              : String(row.end_at) > generatedAt
                ? 'in_progress'
                : 'unrecorded',
    })) as (Row & { evidence: string })[];
  const events = rows(db, 'SELECT * FROM calendar_events ORDER BY start_at').filter((row) =>
    inDateRange(String(row.start_at), String(row.end_at), from, through, timezone),
  );
  const completedTasks = rows(
    db,
    "SELECT * FROM tasks WHERE status = 'done' AND completed_at IS NOT NULL ORDER BY completed_at",
  ).filter(
    (row) =>
      localDate(String(row.completed_at), timezone) >= from &&
      localDate(String(row.completed_at), timezone) <= through,
  );
  const habits = rows(db, 'SELECT * FROM habits ORDER BY name').map((row) => ({
    ...row,
    occurrences: rows(
      db,
      'SELECT * FROM habit_occurrences WHERE habit_id = ? AND occurrence_key BETWEEN ? AND ? ORDER BY occurrence_key',
      String(row.id),
      from,
      through,
    ),
  }));
  const summary = {
    scheduled: sessions.filter((row) => row.status === 'scheduled').length,
    completed: sessions.filter((row) => row.evidence === 'completed').length,
    skipped: sessions.filter((row) => row.evidence === 'skipped').length,
    unrecorded: sessions.filter((row) => row.evidence === 'unrecorded').length,
    pending: sessions.filter((row) => row.evidence === 'pending').length,
    in_progress: sessions.filter((row) => row.evidence === 'in_progress').length,
    cancelled: sessions.filter((row) => row.evidence === 'cancelled').length,
    planned_minutes: sessions
      .filter((row) => row.status === 'scheduled')
      .reduce(
        (sum, row) =>
          sum + (Date.parse(String(row.end_at)) - Date.parse(String(row.start_at))) / 60000,
        0,
      ),
    recorded_actual_minutes: sessions.reduce(
      (sum, row) => sum + Number(row.actual_minutes ?? 0),
      0,
    ),
  };
  return {
    from,
    through,
    timezone,
    generated_at: generatedAt,
    evidence_rule: 'unrecorded means a past session with unknown outcome, not skipped',
    summary,
    sessions,
    events,
    completed_tasks: completedTasks,
    open_tasks_now: taskList(db).filter(
      (row) => !['done', 'cancelled'].includes(String(row.status)),
    ),
    habits,
    decisions: rows(db, 'SELECT * FROM decisions ORDER BY decided_at DESC LIMIT 20'),
  };
}

export function validate(db: DatabaseSync) {
  const issues: string[] = [];
  const integrity = db.prepare('PRAGMA integrity_check').get() as Row;
  if (integrity.integrity_check !== 'ok')
    issues.push(`SQLite integrity: ${integrity.integrity_check}`);
  for (const row of rows(db, 'PRAGMA foreign_key_check'))
    issues.push(`Foreign key: ${JSON.stringify(row)}`);
  for (const row of rows(
    db,
    `WITH RECURSIVE paths(start_id, current_id) AS (
    SELECT task_id, depends_on_id FROM task_dependencies
    UNION SELECT paths.start_id, d.depends_on_id FROM task_dependencies d JOIN paths ON d.task_id = paths.current_id WHERE paths.start_id != paths.current_id
  ) SELECT DISTINCT start_id FROM paths WHERE start_id = current_id`,
  ))
    issues.push(`Dependency cycle: ${row.start_id}`);
  for (const row of rows(
    db,
    `SELECT DISTINCT t.id FROM tasks t JOIN task_dependencies d ON d.task_id = t.id
     JOIN tasks prerequisite ON prerequisite.id = d.depends_on_id
     WHERE t.status = 'done' AND prerequisite.status != 'done'
       AND NULLIF(trim(t.completion_override_reason), '') IS NULL`,
  ))
    issues.push(`Completed task has unfinished prerequisite: ${row.id}`);
  for (const row of rows(
    db,
    `SELECT DISTINCT p.id FROM projects p JOIN tasks t ON t.project_id = p.id
     WHERE p.status = 'done' AND t.status NOT IN ('done','cancelled')
       AND NULLIF(trim(p.completion_override_reason), '') IS NULL`,
  ))
    issues.push(`Completed project has open tasks: ${row.id}`);
  for (const row of rows(
    db,
    `SELECT id FROM work_sessions WHERE end_at <= start_at UNION ALL SELECT id FROM calendar_events WHERE end_at <= start_at`,
  ))
    issues.push(`Invalid interval: ${row.id}`);
  for (const row of rows(
    db,
    `SELECT o.session_id FROM session_outcomes o JOIN work_sessions s ON s.id = o.session_id
     WHERE s.status != 'scheduled' OR (o.outcome = 'completed' AND o.actual_minutes <= 0)
        OR (o.outcome = 'skipped' AND o.actual_minutes != 0)`,
  ))
    issues.push(`Invalid session outcome: ${row.session_id}`);
  for (const row of rows(
    db,
    `SELECT s.id FROM work_sessions s JOIN tasks t ON t.id = s.task_id
     LEFT JOIN projects p ON p.id = t.project_id
     WHERE s.status = 'scheduled' AND s.end_at > ?
       AND (t.status IN ('done','cancelled') OR (p.id IS NOT NULL AND p.status != 'active'))`,
    now(),
  ))
    issues.push(`Active session belongs to closed task or non-active project: ${row.id}`);
  const intervals = [
    ...rows(db, `SELECT id, start_at, end_at FROM work_sessions WHERE status = 'scheduled'`),
    ...rows(db, `SELECT id, start_at, end_at FROM calendar_events WHERE status = 'scheduled'`),
  ].sort((a, b) => String(a.start_at).localeCompare(String(b.start_at)));
  for (let i = 0; i < intervals.length; i++)
    for (
      let j = i + 1;
      j < intervals.length && String(intervals[j]?.start_at) < String(intervals[i]?.end_at);
      j++
    )
      issues.push(`Schedule overlap: ${intervals[i]?.id}, ${intervals[j]?.id}`);
  return {
    ok: issues.length === 0,
    issues,
    counts: Object.fromEntries(
      [
        'goals',
        'projects',
        'tasks',
        'work_sessions',
        'session_outcomes',
        'calendar_events',
        'habits',
        'habit_occurrences',
        'decisions',
      ].map((table) => [
        table,
        Number((db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as Row).count),
      ]),
    ),
  };
}
