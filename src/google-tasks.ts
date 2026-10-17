import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { LifeError, mutate } from './db.ts';
import {
  assertVersion,
  cancelSession,
  get,
  logHabit,
  now,
  rows,
  task,
  validate,
  type Row,
} from './core.ts';
import { addDays, dateKey, localDate, weekStart } from './time.ts';
import { sanitizeDisplayText } from './google-projection.ts';
import type {
  GoogleTask,
  GoogleTaskList,
  GoogleTransport,
  ProjectionConfig,
  Snapshot,
  TaskListRole,
  TaskProjection,
} from './google-types.ts';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const encoded = encodeURIComponent;

export const taskListsPath = (listId?: string) =>
  `/tasks/v1/users/@me/lists${listId ? `/${encoded(listId)}` : ''}`;
export const tasksPath = (listId: string, taskId?: string) =>
  `/tasks/v1/lists/${encoded(listId)}/tasks${taskId ? `/${encoded(taskId)}` : ''}`;

export type TaskListRegistry = {
  workspaceId: string;
  tasks?: string;
  habits?: string;
  pending?: TaskListRole;
};

export type TaskMapping = {
  listId: string;
  listRole: TaskListRole;
  taskId: string;
  kind: 'task' | 'habit-task';
  entityId: string;
  occurrenceDate?: string;
  hash: string;
  etag?: string;
  lastAcceptedStatus: 'needsAction' | 'completed';
  sourceVersion: number;
  lastSync: string;
};

export type TaskMappingState = Record<string, TaskMapping>;

export type TaskSyncAction = {
  kind: 'create' | 'update' | 'cancel' | 'unchanged' | 'conflict' | 'skip';
  key: string;
  list: TaskListRole;
  entityKind: 'task' | 'habit-task';
  entityId: string;
  occurrenceDate?: string;
  remoteId?: string;
  etag?: string;
  task?: GoogleTask;
  reason?: string;
  sourceVersion?: number;
};

export type TaskSyncPlan = {
  from: string;
  through: string;
  approval: string;
  listsToCreate: TaskListRole[];
  actions: TaskSyncAction[];
  summary: Record<string, number>;
  horizonWarning?: string;
};

export type ReconcileAction = {
  kind: 'complete-task' | 'complete-habit' | 'unchanged' | 'conflict' | 'skip';
  key: string;
  entityKind: 'task' | 'habit-task';
  entityId: string;
  occurrenceDate?: string;
  remoteId?: string;
  remoteTitle?: string;
  remoteCompletedAt?: string;
  expectedVersion?: number;
  blockedBy?: string[];
  reason: string;
  resolution?: string;
};

export type ReconcilePlan = {
  approval: string;
  actions: ReconcileAction[];
  summary: Record<string, number>;
};

const statusOf = (error: unknown) => Number((error as { status?: number }).status);

export function parseTaskOwnership(item: GoogleTask): {
  key?: string;
  workspace?: string;
  hash?: string;
  userNotes: string;
} {
  const raw = String(item.notes ?? '');
  const lines = raw.split(/\r?\n/);
  let key: string | undefined;
  let workspace: string | undefined;
  let contentHash: string | undefined;
  const userLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('Syntrop source: ')) {
      key = line.slice('Syntrop source: '.length).trim();
    } else if (line.startsWith('Syntrop workspace: ')) {
      workspace = line.slice('Syntrop workspace: '.length).trim();
    } else if (line.startsWith('Syntrop hash: ')) {
      contentHash = line.slice('Syntrop hash: '.length).trim();
    } else {
      userLines.push(line);
    }
  }
  return {
    ...(key ? { key } : {}),
    ...(workspace ? { workspace } : {}),
    ...(contentHash ? { hash: contentHash } : {}),
    userNotes: userLines.join('\n').trim(),
  };
}

export function ownedTask(item: GoogleTask, workspaceId: string, key?: string): boolean {
  const parsed = parseTaskOwnership(item);
  return parsed.workspace === workspaceId && (!key || parsed.key === key);
}

/** Normalize managed Google Task fields, comparing only YYYY-MM-DD for due dates. */
export function taskFingerprint(item: GoogleTask): string {
  const parsed = parseTaskOwnership(item);
  const dueDate =
    typeof item.due === 'string' && item.due.length >= 10 ? item.due.slice(0, 10) : '';
  return hash(
    JSON.stringify({
      title: item.title ?? '',
      userNotes: parsed.userNotes,
      due: dueDate,
      status: item.status ?? 'needsAction',
    }),
  );
}

function attachTaskOwnership(
  item: GoogleTask,
  workspaceId: string,
  key: string,
  contextNote = '',
): GoogleTask {
  const draft: GoogleTask = {
    ...item,
    status: item.status ?? 'needsAction',
    notes: contextNote.trim(),
  };
  const digest = taskFingerprint(draft);
  const footer = [
    ...(contextNote.trim() ? [contextNote.trim()] : []),
    `Syntrop source: ${key}`,
    `Syntrop workspace: ${workspaceId}`,
    `Syntrop hash: ${digest}`,
  ].join('\n');
  return {
    ...draft,
    notes: footer,
  };
}

export async function listTaskLists(provider: GoogleTransport): Promise<GoogleTaskList[]> {
  const result: GoogleTaskList[] = [];
  const seen = new Set<string>();
  let token = '';
  do {
    if (seen.has(token) || seen.size >= 100)
      throw new LifeError(
        'GOOGLE_PAGINATION',
        'TaskLists pagination did not terminate within 100 pages',
      );
    seen.add(token);
    const query = new URLSearchParams({ maxResults: '100' });
    if (token) query.set('pageToken', token);
    const page = await provider.request<{ items?: GoogleTaskList[]; nextPageToken?: string }>(
      'GET',
      `${taskListsPath()}?${query}`,
    );
    result.push(...(page.items ?? []));
    token = page.nextPageToken ?? '';
  } while (token);
  return result;
}

export async function listTasks(provider: GoogleTransport, listId: string): Promise<GoogleTask[]> {
  const result: GoogleTask[] = [];
  const seen = new Set<string>();
  let token = '';
  do {
    if (seen.has(token) || seen.size >= 100)
      throw new LifeError(
        'GOOGLE_PAGINATION',
        'Tasks pagination did not terminate within 100 pages',
      );
    seen.add(token);
    const query = new URLSearchParams({
      showCompleted: 'true',
      showHidden: 'true',
      showDeleted: 'true',
      maxResults: '100',
    });
    if (token) query.set('pageToken', token);
    const page = await provider.request<{ items?: GoogleTask[]; nextPageToken?: string }>(
      'GET',
      `${tasksPath(listId)}?${query}`,
    );
    result.push(...(page.items ?? []));
    token = page.nextPageToken ?? '';
  } while (token);
  return result;
}

function unresolvedPrerequisites(snapshot: Snapshot, taskId: string): string[] {
  const deps = snapshot.task_dependencies ?? [];
  const tasksById = new Map(snapshot.tasks.map((t) => [String(t.id), t]));
  const blocked: string[] = [];
  for (const dep of deps) {
    if (String(dep.task_id) !== taskId) continue;
    const prereqId = String(dep.depends_on_id);
    const prereq = tasksById.get(prereqId);
    if (!prereq || String(prereq.status) !== 'done') {
      blocked.push(prereqId);
    }
  }
  return blocked.sort();
}

function formatTaskTitle(row: Row, config: ProjectionConfig): string {
  if (config.titleMode !== 'titles') return 'Task';
  const taskId = String(row.id);
  const projectId = row.project_id ? String(row.project_id) : '';
  const taskPres = config.presentation?.tasks?.[taskId];
  const projPres = projectId ? config.presentation?.projects?.[projectId] : undefined;
  let base = sanitizeDisplayText(taskPres?.shortTitle ?? row.title ?? 'Task', 100) || 'Task';
  if (
    !taskPres?.shortTitle &&
    ['minimal', 'compact'].includes(config.presentation?.theme?.style ?? '') &&
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
  const prefixMode = config.presentation?.theme?.sessionPrefix ?? 'project';
  const prefix = prefixMode === 'project' && projPres?.shortName ? projPres.shortName : '';
  if (
    prefix &&
    !base.toLowerCase().startsWith(`${prefix.toLowerCase()} · `) &&
    !base.toLowerCase().startsWith(`${prefix.toLowerCase()}:`)
  ) {
    return `${prefix} · ${base}`.slice(0, 120);
  }
  return base.slice(0, 120);
}

function formatHabitTaskTitle(habit: Row, config: ProjectionConfig): string {
  if (config.titleMode !== 'titles') return 'Habit';
  const habitId = String(habit.id);
  const custom = config.presentation?.habits?.[habitId]?.shortName;
  if (custom) return sanitizeDisplayText(custom, 80) || 'Habit';
  return sanitizeDisplayText(habit.name ?? 'Habit', 80) || 'Habit';
}

export function defaultTasksPolicy(): NonNullable<ProjectionConfig['tasksPolicy']> {
  return {
    enabled: true,
    mode: 'actionable',
    includeBacklog: false,
    habitHorizonDays: 14,
    lists: {
      tasks: 'Syntrop · Tasks',
      habits: 'Syntrop · Habits',
    },
  };
}

export function projectTasks(
  snapshot: Snapshot,
  config: ProjectionConfig,
  from: string,
  through: string,
): TaskProjection[] {
  new Intl.DateTimeFormat('en-US', { timeZone: snapshot.timezone }).format(0);
  const fromDate = dateKey(from);
  const throughDate = dateKey(through);
  if (fromDate > throughDate) throw new LifeError('VALIDATION', 'Projection window is reversed');

  const projects = new Map(snapshot.projects.map((r) => [String(r.id), r]));
  const activeSessionsByTask = new Map<string, string[]>();
  for (const session of snapshot.work_sessions) {
    if (session.status !== 'scheduled') continue;
    const tid = String(session.task_id);
    const startDate = localDate(String(session.start_at), snapshot.timezone);
    const list = activeSessionsByTask.get(tid) ?? [];
    list.push(startDate);
    activeSessionsByTask.set(tid, list);
  }
  for (const dates of activeSessionsByTask.values()) dates.sort();

  const policy = config.tasksPolicy ?? {
    enabled: Object.values(config.habits).some((h) => h.mode === 'tasks'),
    mode: 'actionable' as const,
    habitHorizonDays: 14,
  };
  const output: TaskProjection[] = [];

  if (policy.enabled && policy.mode !== 'none') {
    const selectedIds = new Set(policy.taskIds ?? []);
    const selectedProjects = policy.projectIds?.length ? new Set(policy.projectIds) : undefined;

    for (const row of snapshot.tasks) {
      const taskId = String(row.id);
      const status = String(row.status);
      if (['done', 'cancelled'].includes(status)) continue;
      if (row.project_id && projects.get(String(row.project_id))?.status !== 'active') continue;
      if (selectedProjects && (!row.project_id || !selectedProjects.has(String(row.project_id))))
        continue;

      const taskPres = config.presentation?.tasks?.[taskId];
      if (taskPres?.publish === false) continue;

      const blockedBy = unresolvedPrerequisites(snapshot, taskId);
      const sessionDates = activeSessionsByTask.get(taskId) ?? [];
      const windowSessions = sessionDates.filter((d) => d >= fromDate && d <= throughDate);
      const upcomingSessions = sessionDates.filter((d) => d >= fromDate);
      const deadlineDate = row.due_at
        ? localDate(String(row.due_at), snapshot.timezone)
        : undefined;
      const explicitDate = taskPres?.scheduledDate ? dateKey(taskPres.scheduledDate) : undefined;

      const explicitlySelected = taskPres?.publish === true || selectedIds.has(taskId);
      let shouldPublish = false;

      if (policy.mode === 'selected') {
        shouldPublish = explicitlySelected;
      } else if (policy.mode === 'scheduled') {
        shouldPublish =
          explicitlySelected ||
          (blockedBy.length === 0 && (windowSessions.length > 0 || Boolean(explicitDate)));
      } else if (policy.mode === 'ready') {
        shouldPublish = explicitlySelected || blockedBy.length === 0;
      } else {
        // 'actionable': ready tasks that have scheduled sessions, deadlines in window, active status, or backlog opt-in
        const hasTimelySignal =
          windowSessions.length > 0 ||
          Boolean(explicitDate) ||
          Boolean(deadlineDate && deadlineDate >= fromDate && deadlineDate <= throughDate) ||
          ['todo', 'in_progress'].includes(status) ||
          Boolean(policy.includeBacklog);
        shouldPublish = explicitlySelected || (blockedBy.length === 0 && hasTimelySignal);
      }

      if (!shouldPublish) continue;

      const scheduledDate =
        explicitDate ??
        windowSessions[0] ??
        upcomingSessions[0] ??
        (deadlineDate && deadlineDate >= fromDate ? deadlineDate : undefined);

      const noteLines: string[] = [];
      if (deadlineDate && scheduledDate && deadlineDate !== scheduledDate) {
        noteLines.push(`Syntrop deadline: ${deadlineDate}`);
      } else if (deadlineDate && !scheduledDate) {
        noteLines.push(`Syntrop deadline: ${deadlineDate}`);
      }
      if (blockedBy.length > 0) {
        noteLines.push(`Prerequisite tasks: ${blockedBy.join(', ')}`);
      }

      const key = `task:${taskId}`;
      const googleTask = attachTaskOwnership(
        {
          title: formatTaskTitle(row, config),
          status: 'needsAction',
          ...(scheduledDate ? { due: `${scheduledDate}T00:00:00.000Z` } : {}),
        },
        config.workspaceId,
        key,
        noteLines.join('\n'),
      );

      output.push({
        key,
        list: 'tasks',
        kind: 'task',
        entityId: taskId,
        ...(scheduledDate ? { scheduledDate } : {}),
        sourceVersion: Number(row.version ?? 1),
        task: googleTask,
      });
    }
  }

  const occurrencesByHabit = new Map<string, Map<string, string>>();
  for (const occ of snapshot.habit_occurrences ?? []) {
    const hid = String(occ.habit_id);
    const map = occurrencesByHabit.get(hid) ?? new Map<string, string>();
    map.set(String(occ.occurrence_key), String(occ.outcome));
    occurrencesByHabit.set(hid, map);
  }

  for (const habit of snapshot.habits) {
    const habitId = String(habit.id);
    const display = config.habits[habitId];
    if (!habit.active || !display || display.mode !== 'tasks') continue;
    if (!display.startDate)
      throw new LifeError('VALIDATION', 'Habit tasks mode requires an explicit startDate');
    const anchor = dateKey(display.startDate);
    const horizonDays = display.horizonDays ?? policy.habitHorizonDays ?? 14;
    if (!Number.isSafeInteger(horizonDays) || horizonDays < 1 || horizonDays > 90)
      throw new LifeError('VALIDATION', 'Habit rolling horizon must be 1..90 days');

    const weekly = habit.frequency === 'weekly';
    const weekdays = [...new Set(display.weekdays ?? [])];
    if (weekdays.some((day) => !DAYS.includes(day)))
      throw new LifeError('VALIDATION', 'Habit weekdays must be MO,TU,WE,TH,FR,SA,SU');
    weekdays.sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b));

    const start = anchor > fromDate ? anchor : fromDate;
    const maxHorizonDate = addDays(fromDate, horizonDays - 1);
    const end = throughDate < maxHorizonDate ? throughDate : maxHorizonDate;
    if (start > end) continue;

    const logged = occurrencesByHabit.get(habitId) ?? new Map<string, string>();
    const baseTitle = formatHabitTaskTitle(habit, config);

    if (weekly && weekdays.length === 0) {
      for (let w = weekStart(start); w <= end; w = addDays(w, 7)) {
        const occDate = w < anchor ? anchor : w;
        if (occDate > end) continue;
        const outcome = logged.get(occDate);
        if (outcome === 'skipped') continue;
        const key = `habit-task:${habitId}:${occDate}`;
        const googleTask = attachTaskOwnership(
          {
            title: config.titleMode === 'titles' ? `${baseTitle} (weekly)` : 'Habit',
            status: outcome === 'completed' ? 'completed' : 'needsAction',
            due: `${occDate}T00:00:00.000Z`,
          },
          config.workspaceId,
          key,
          `Weekly target (${Number(habit.target ?? 1)}/week); week of ${w}`,
        );
        output.push({
          key,
          list: 'habits',
          kind: 'habit-task',
          entityId: habitId,
          occurrenceDate: occDate,
          scheduledDate: occDate,
          sourceVersion: Number(habit.version ?? 1),
          task: googleTask,
        });
      }
    } else {
      for (let d = start; d <= end; d = addDays(d, 1)) {
        if (weekly) {
          const day = new Date(`${d}T00:00:00Z`).getUTCDay();
          if (!weekdays.includes(DAYS[(day + 6) % 7]!)) continue;
        }
        const outcome = logged.get(d);
        if (outcome === 'skipped') continue;
        const key = `habit-task:${habitId}:${d}`;
        const googleTask = attachTaskOwnership(
          {
            title: baseTitle,
            status: outcome === 'completed' ? 'completed' : 'needsAction',
            due: `${d}T00:00:00.000Z`,
          },
          config.workspaceId,
          key,
        );
        output.push({
          key,
          list: 'habits',
          kind: 'habit-task',
          entityId: habitId,
          occurrenceDate: d,
          scheduledDate: d,
          sourceVersion: Number(habit.version ?? 1),
          task: googleTask,
        });
      }
    }
  }

  return output.sort((a, b) => a.key.localeCompare(b.key));
}

function desiredForTrackedTask(
  snapshot: Snapshot,
  config: ProjectionConfig,
  key: string,
  map?: TaskMapping,
): TaskProjection | undefined {
  if (key.startsWith('task:')) {
    const taskId = key.slice('task:'.length);
    const row = snapshot.tasks.find((r) => String(r.id) === taskId);
    if (!row) return undefined;
    if (String(row.status) === 'done') {
      const scheduledDate = map?.occurrenceDate;
      const googleTask = attachTaskOwnership(
        {
          title: formatTaskTitle(row, config),
          status: 'completed',
          ...(scheduledDate ? { due: `${scheduledDate}T00:00:00.000Z` } : {}),
        },
        config.workspaceId,
        key,
      );
      return {
        key,
        list: 'tasks',
        kind: 'task',
        entityId: taskId,
        ...(scheduledDate ? { scheduledDate } : {}),
        sourceVersion: Number(row.version ?? 1),
        task: googleTask,
      };
    }
    return undefined;
  }
  if (key.startsWith('habit-task:')) {
    const parts = key.split(':');
    const habitId = parts[1]!;
    const occDate = parts[2]!;
    const habit = snapshot.habits.find((h) => String(h.id) === habitId);
    const display = config.habits[habitId];
    if (!habit || !habit.active || !display || display.mode !== 'tasks') return undefined;
    const occ = (snapshot.habit_occurrences ?? []).find(
      (o) => String(o.habit_id) === habitId && String(o.occurrence_key) === occDate,
    );
    if (occ?.outcome === 'skipped') return undefined;
    const baseTitle = formatHabitTaskTitle(habit, config);
    const weekly = habit.frequency === 'weekly' && !(display.weekdays ?? []).length;
    const googleTask = attachTaskOwnership(
      {
        title: weekly && config.titleMode === 'titles' ? `${baseTitle} (weekly)` : baseTitle,
        status: occ?.outcome === 'completed' ? 'completed' : 'needsAction',
        due: `${occDate}T00:00:00.000Z`,
      },
      config.workspaceId,
      key,
      weekly
        ? `Weekly target (${Number(habit.target ?? 1)}/week); week of ${weekStart(occDate)}`
        : '',
    );
    return {
      key,
      list: 'habits',
      kind: 'habit-task',
      entityId: habitId,
      occurrenceDate: occDate,
      scheduledDate: occDate,
      sourceVersion: Number(habit.version ?? 1),
      task: googleTask,
    };
  }
  return undefined;
}

function retiredTask(snapshot: Snapshot, config: ProjectionConfig, key: string): boolean {
  if (key.startsWith('task:')) {
    const taskId = key.slice('task:'.length);
    const row = snapshot.tasks.find((r) => String(r.id) === taskId);
    if (!row) return false;
    if (String(row.status) === 'cancelled') return true;
    if (row.project_id) {
      const proj = snapshot.projects.find((p) => String(p.id) === String(row.project_id));
      if (proj && proj.status !== 'active') return true;
    }
    if (config.presentation?.tasks?.[taskId]?.publish === false) return true;
    if (config.tasksPolicy && (!config.tasksPolicy.enabled || config.tasksPolicy.mode === 'none'))
      return true;
    return false;
  }
  if (key.startsWith('habit-task:')) {
    const [, habitId, occDate] = key.split(':');
    const habit = snapshot.habits.find((h) => String(h.id) === habitId);
    const display = config.habits[habitId!];
    if (!habit) return false;
    const occ = (snapshot.habit_occurrences ?? []).find(
      (o) => String(o.habit_id) === habitId && String(o.occurrence_key) === occDate,
    );
    if (occ?.outcome === 'skipped') return true;
    return !habit.active || !display || display.mode !== 'tasks';
  }
  return false;
}

export async function planTasksSync(
  provider: GoogleTransport,
  snapshot: Snapshot,
  config: ProjectionConfig,
  registry: TaskListRegistry,
  mappings: TaskMappingState,
  from: string,
  through: string,
  resolveLocal = false,
  nowIso = new Date().toISOString(),
): Promise<TaskSyncPlan> {
  if (registry.workspaceId !== config.workspaceId)
    throw new LifeError('CONFLICT', 'Task list registry belongs to another workspace');
  if (registry.pending)
    throw new LifeError(
      'GOOGLE_RECOVERY',
      `Task list creation result is uncertain for ${registry.pending}; recover its task list ID before retrying`,
    );

  const desired = new Map(
    projectTasks(snapshot, config, from, through).map((item) => [item.key, item]),
  );
  const remoteByRole: Record<TaskListRole, GoogleTask[]> = { tasks: [], habits: [] };
  for (const role of ['tasks', 'habits'] as const) {
    if (registry[role]) {
      remoteByRole[role] = await listTasks(provider, registry[role]!);
    }
  }

  const today = localDate(nowIso, snapshot.timezone);
  const actions: TaskSyncAction[] = [];

  for (const role of ['tasks', 'habits'] as const) {
    const remotes = remoteByRole[role];
    const keys = new Set([...desired.values()].filter((x) => x.list === role).map((x) => x.key));
    for (const item of remotes) {
      if (ownedTask(item, config.workspaceId)) {
        const parsed = parseTaskOwnership(item);
        if (parsed.key) keys.add(parsed.key);
      }
    }
    for (const [key, map] of Object.entries(mappings)) {
      if (map.listRole === role || map.listId === registry[role]) keys.add(key);
    }

    for (const key of [...keys].sort()) {
      const map = mappings[key];
      const matches = remotes.filter((item) => ownedTask(item, config.workspaceId, key));
      const active = matches.filter((item) => !item.deleted);
      const remote =
        active.find((item) => item.id === map?.taskId) ??
        active[0] ??
        (map ? remotes.find((item) => item.id === map.taskId) : undefined) ??
        matches[0];

      let wanted = desired.get(key);
      if (!wanted) wanted = desiredForTrackedTask(snapshot, config, key, map);

      const entityKind: 'task' | 'habit-task' = key.startsWith('habit-task:')
        ? 'habit-task'
        : 'task';
      const parts = key.split(':');
      const entityId = parts[1]!;
      const occurrenceDate = entityKind === 'habit-task' ? parts[2] : wanted?.scheduledDate;

      const base: TaskSyncAction = {
        kind: 'skip',
        key,
        list: role,
        entityKind,
        entityId,
        ...(occurrenceDate ? { occurrenceDate } : {}),
        remoteId: remote?.id ?? map?.taskId,
        etag: remote?.etag,
      };

      if (active.length > 1) {
        actions.push({
          ...base,
          kind: 'conflict',
          reason: 'Multiple managed Google Tasks share this source key',
        });
        continue;
      }

      if (remote && !remote.deleted && !ownedTask(remote, config.workspaceId, key)) {
        actions.push({
          ...base,
          kind: 'conflict',
          reason: 'Remote Google Task identity is not owned by this workspace',
        });
        continue;
      }

      const baselineHash = map?.hash ?? (remote ? parseTaskOwnership(remote).hash : undefined);
      const remoteCompleted = remote && !remote.deleted && remote.status === 'completed';
      const wantedNeedsAction = wanted && wanted.task.status !== 'completed';

      if (remoteCompleted && wantedNeedsAction && !resolveLocal) {
        actions.push({
          ...base,
          kind: 'conflict',
          reason:
            'Task is marked completed in Google Tasks; run integration google reconcile first, or preview with --resolve local to reset to open',
        });
        continue;
      }

      const uncheckedCompleted =
        remote &&
        !remote.deleted &&
        remote.status === 'needsAction' &&
        (map?.lastAcceptedStatus === 'completed' || wanted?.task.status === 'completed');

      if (uncheckedCompleted && !resolveLocal) {
        actions.push({
          ...base,
          kind: 'conflict',
          reason:
            'Previously completed task was unchecked in Google Tasks; confirmed Syntrop history is preserved. Use --resolve local to restore the Google completion status',
        });
        continue;
      }

      const contentDrifted =
        remote &&
        !remote.deleted &&
        baselineHash &&
        taskFingerprint(remote) !== baselineHash &&
        !(
          remote.status === 'completed' &&
          wanted?.task.status === 'completed' &&
          taskFingerprint({ ...remote, status: 'needsAction' }) === baselineHash
        );

      if (contentDrifted && !resolveLocal) {
        actions.push({
          ...base,
          kind: 'conflict',
          reason:
            'Remote Google Task was edited; preview with --resolve local only to explicitly restore local projection',
        });
        continue;
      }

      if (wanted) {
        // Never fabricate historical Google Task completions for already-logged past habits that were never projected.
        if (wanted.kind === 'habit-task' && wanted.task.status === 'completed' && !remote && !map) {
          actions.push({
            ...base,
            kind: 'skip',
            reason:
              'Habit occurrence was already recorded locally prior to Google Tasks projection',
          });
          continue;
        }

        const taskPayload = structuredClone(wanted.task);
        if (remote?.deleted || (!remote && map)) {
          if (!resolveLocal) {
            actions.push({
              ...base,
              kind: 'conflict',
              reason:
                'Managed Google Task was deleted remotely; explicit --resolve local is required to recreate',
            });
            continue;
          }
          actions.push({
            ...base,
            kind: 'create',
            remoteId: undefined,
            etag: undefined,
            task: taskPayload,
            sourceVersion: wanted.sourceVersion,
          });
          continue;
        }

        if (!remote) {
          actions.push({
            ...base,
            kind: 'create',
            task: taskPayload,
            sourceVersion: wanted.sourceVersion,
          });
          continue;
        }

        taskPayload.id = remote.id;
        const sameContent =
          taskFingerprint(remote) === taskFingerprint(taskPayload) &&
          (remote.status ?? 'needsAction') === (taskPayload.status ?? 'needsAction');
        actions.push({
          ...base,
          kind: sameContent && !contentDrifted ? 'unchanged' : 'update',
          task: taskPayload,
          sourceVersion: wanted.sourceVersion,
        });
      } else if (remote && !remote.deleted && retiredTask(snapshot, config, key)) {
        if (remote.status === 'completed') {
          actions.push({
            ...base,
            kind: 'skip',
            reason: 'Completed Google Task history retained',
          });
          continue;
        }
        const dueDate = remote.due ? remote.due.slice(0, 10) : undefined;
        const isFutureOrUndated = !dueDate || dueDate >= today;
        actions.push({
          ...base,
          kind: isFutureOrUndated ? 'cancel' : 'skip',
          reason: isFutureOrUndated
            ? 'Local lifecycle or configuration removed future task projection'
            : 'Past task occurrence retained',
        });
      } else {
        actions.push({
          ...base,
          kind: 'skip',
          reason: 'Outside current publication window or retained history',
        });
      }
    }
  }

  const listsToCreate = (['tasks', 'habits'] as const).filter(
    (role) => !registry[role] && actions.some((a) => a.list === role && a.kind === 'create'),
  );
  const summary = Object.fromEntries(
    ['create', 'update', 'cancel', 'unchanged', 'skip', 'conflict'].map((kind) => [
      kind,
      actions.filter((a) => a.kind === kind).length,
    ]),
  );

  let horizonWarning: string | undefined;
  const activeTaskHabits = snapshot.habits.filter(
    (h) => h.active && config.habits[String(h.id)]?.mode === 'tasks',
  );
  if (activeTaskHabits.length > 0) {
    const futureHabitDates = actions
      .filter((a) => a.entityKind === 'habit-task' && a.occurrenceDate && a.occurrenceDate >= today)
      .map((a) => a.occurrenceDate!)
      .sort();
    const furthest = futureHabitDates.at(-1);
    if (!furthest || furthest <= addDays(today, 3)) {
      horizonWarning =
        'Habit task rolling horizon has 3 or fewer upcoming days projected; extend the sync window to keep upcoming habit tasks visible.';
    }
  }

  const approval = hash(
    JSON.stringify({ from, through, registry, config, actions, listsToCreate }),
  );
  return {
    from,
    through,
    approval,
    listsToCreate: [...listsToCreate],
    actions,
    summary,
    ...(horizonWarning ? { horizonWarning } : {}),
  };
}

export async function applyTasksSync(
  provider: GoogleTransport,
  plan: TaskSyncPlan,
  config: ProjectionConfig,
  registry: TaskListRegistry,
  mappings: TaskMappingState,
  saveRegistry: (value: TaskListRegistry) => void,
  saveMappings: (value: TaskMappingState) => void,
): Promise<Record<string, unknown>> {
  const summary = {
    created: 0,
    updated: 0,
    cancelled: 0,
    unchanged: 0,
    skipped: 0,
    conflicted: 0,
    failed: 0,
  };
  const failures: { key: string; code: string }[] = [];

  for (const role of plan.listsToCreate) {
    registry.pending = role;
    saveRegistry(registry);
    const defaultTitle =
      role === 'tasks'
        ? (config.tasksPolicy?.lists?.tasks ?? 'Syntrop · Tasks')
        : (config.tasksPolicy?.lists?.habits ?? 'Syntrop · Habits');
    const created = await provider.request<GoogleTaskList>('POST', taskListsPath(), {
      title: defaultTitle,
    });
    if (!created.id)
      throw new LifeError(
        'GOOGLE_RECOVERY',
        'Task list creation response has no ID; inspect Google Tasks before recovery',
      );
    registry[role] = created.id;
    delete registry.pending;
    saveRegistry(registry);
  }

  // Cache initial list snapshots so uncertain POST recovery never duplicates tasks
  const listSnapshot = new Map<string, GoogleTask[]>();
  const getListItems = async (listId: string): Promise<GoogleTask[]> => {
    if (!listSnapshot.has(listId)) {
      listSnapshot.set(listId, await listTasks(provider, listId));
    }
    return listSnapshot.get(listId)!;
  };

  for (const action of plan.actions) {
    if (action.kind === 'conflict') {
      summary.conflicted++;
      continue;
    }
    if (action.kind === 'skip') {
      summary.skipped++;
      continue;
    }
    const listId = registry[action.list];
    if (!listId) {
      summary.failed++;
      failures.push({ key: action.key, code: 'MISSING_TASK_LIST' });
      continue;
    }

    try {
      if (action.kind === 'cancel') {
        const current = await provider.request<GoogleTask>(
          'GET',
          tasksPath(listId, action.remoteId!),
        );
        if (!ownedTask(current, registry.workspaceId, action.key)) {
          throw new LifeError('CONFLICT', 'Refusing to delete unowned Google Task');
        }
        if (
          (action.etag && current.etag && current.etag !== action.etag) ||
          current.status === 'completed'
        ) {
          summary.conflicted++;
          failures.push({ key: action.key, code: 'HTTP_412' });
          continue;
        }
        await provider.request('DELETE', tasksPath(listId, action.remoteId!));
        delete mappings[action.key];
        saveMappings(mappings);
        summary.cancelled++;
        continue;
      }

      let targetId = action.remoteId;
      if (action.kind === 'create') {
        const existingItems = await getListItems(listId);
        const alreadyCreated = existingItems.find(
          (item) => !item.deleted && ownedTask(item, registry.workspaceId, action.key),
        );
        if (alreadyCreated?.id) {
          if (alreadyCreated.status === 'completed' && action.task?.status !== 'completed') {
            summary.conflicted++;
            failures.push({ key: action.key, code: 'HTTP_412' });
            continue;
          }
          targetId = alreadyCreated.id;
          if (
            action.task &&
            (taskFingerprint(alreadyCreated) !== taskFingerprint(action.task) ||
              (alreadyCreated.status ?? 'needsAction') !== (action.task.status ?? 'needsAction'))
          ) {
            await provider.request('PUT', tasksPath(listId, targetId), {
              id: targetId,
              title: action.task.title ?? '',
              notes: action.task.notes ?? '',
              status: action.task.status ?? 'needsAction',
              ...(action.task.due ? { due: action.task.due } : {}),
            });
          }
        } else {
          const payload: Record<string, unknown> = {
            title: action.task?.title ?? '',
            notes: action.task?.notes ?? '',
            status: action.task?.status ?? 'needsAction',
            ...(action.task?.due ? { due: action.task.due } : {}),
          };
          const inserted = await provider.request<GoogleTask>('POST', tasksPath(listId), payload);
          if (!inserted.id)
            throw new LifeError('GOOGLE_VERIFY', 'Created Google Task returned no ID');
          targetId = inserted.id;
          existingItems.push(inserted);
        }
      } else if (action.kind === 'update') {
        const current = await provider.request<GoogleTask>(
          'GET',
          tasksPath(listId, action.remoteId!),
        );
        if (!ownedTask(current, registry.workspaceId, action.key)) {
          throw new LifeError('CONFLICT', 'Remote Google Task is not owned by this workspace');
        }
        if (
          (action.etag && current.etag && current.etag !== action.etag) ||
          (current.status === 'completed' && action.task?.status !== 'completed')
        ) {
          summary.conflicted++;
          failures.push({ key: action.key, code: 'HTTP_412' });
          continue;
        }
        const payload: Record<string, unknown> = {
          id: action.remoteId,
          title: action.task?.title ?? '',
          notes: action.task?.notes ?? '',
          status: action.task?.status ?? 'needsAction',
          ...(action.task?.due ? { due: action.task.due } : {}),
          ...(action.task?.status === 'completed'
            ? { completed: current.completed ?? new Date().toISOString() }
            : {}),
        };
        await provider.request('PUT', tasksPath(listId, action.remoteId!), payload);
      }

      const actual = await provider.request<GoogleTask>('GET', tasksPath(listId, targetId!));
      if (
        !ownedTask(actual, registry.workspaceId, action.key) ||
        actual.deleted ||
        (action.task &&
          (taskFingerprint(actual) !== taskFingerprint(action.task) ||
            (actual.status ?? 'needsAction') !== (action.task.status ?? 'needsAction')))
      ) {
        throw new LifeError(
          'GOOGLE_VERIFY',
          'Remote Google Task did not match the approved projection',
        );
      }

      mappings[action.key] = {
        listId,
        listRole: action.list,
        taskId: targetId!,
        kind: action.entityKind,
        entityId: action.entityId,
        ...(action.occurrenceDate ? { occurrenceDate: action.occurrenceDate } : {}),
        hash: taskFingerprint(actual),
        etag: actual.etag,
        lastAcceptedStatus: (actual.status as 'needsAction' | 'completed') ?? 'needsAction',
        sourceVersion: action.sourceVersion ?? mappings[action.key]?.sourceVersion ?? 1,
        lastSync: new Date().toISOString(),
      };
      saveMappings(mappings);

      if (action.kind === 'create') summary.created++;
      else if (action.kind === 'update') summary.updated++;
      else summary.unchanged++;
    } catch (error) {
      const status = statusOf(error);
      if (status === 412) summary.conflicted++;
      else summary.failed++;
      failures.push({
        key: action.key,
        code: status
          ? `HTTP_${status}`
          : error instanceof LifeError
            ? error.code
            : 'GOOGLE_NETWORK',
      });
    }
  }

  return { ...summary, failures };
}

export async function planReconcile(
  provider: GoogleTransport,
  snapshot: Snapshot,
  config: ProjectionConfig,
  registry: TaskListRegistry,
  mappings: TaskMappingState,
  options: { allowCorrectHabits?: boolean } = {},
): Promise<ReconcilePlan> {
  if (registry.workspaceId !== config.workspaceId)
    throw new LifeError('CONFLICT', 'Task list registry belongs to another workspace');

  const remoteByRole: Record<TaskListRole, GoogleTask[]> = { tasks: [], habits: [] };
  for (const role of ['tasks', 'habits'] as const) {
    if (registry[role]) {
      remoteByRole[role] = await listTasks(provider, registry[role]!);
    }
  }

  const tasksById = new Map(snapshot.tasks.map((t) => [String(t.id), t]));
  const projectsById = new Map(snapshot.projects.map((p) => [String(p.id), p]));
  const habitsById = new Map(snapshot.habits.map((h) => [String(h.id), h]));
  const occurrences = new Map<string, Row>();
  for (const occ of snapshot.habit_occurrences ?? []) {
    occurrences.set(`${occ.habit_id}:${occ.occurrence_key}`, occ);
  }

  const actions: ReconcileAction[] = [];
  for (const role of ['tasks', 'habits'] as const) {
    const remotes = remoteByRole[role];
    const keys = new Set<string>();
    for (const item of remotes) {
      if (ownedTask(item, config.workspaceId)) {
        const parsed = parseTaskOwnership(item);
        if (parsed.key) keys.add(parsed.key);
      }
    }
    for (const [key, map] of Object.entries(mappings)) {
      if (map.listRole === role || map.listId === registry[role]) keys.add(key);
    }

    for (const key of [...keys].sort()) {
      const map = mappings[key];
      const matches = remotes.filter((item) => ownedTask(item, config.workspaceId, key));
      const active = matches.filter((item) => !item.deleted);
      const remote = active.find((item) => item.id === map?.taskId) ?? active[0] ?? matches[0];
      const entityKind: 'task' | 'habit-task' = key.startsWith('habit-task:')
        ? 'habit-task'
        : 'task';
      const parts = key.split(':');
      const entityId = parts[1]!;
      const occurrenceDate = entityKind === 'habit-task' ? parts[2] : map?.occurrenceDate;

      if (active.length > 1) {
        actions.push({
          kind: 'conflict',
          key,
          entityKind,
          entityId,
          ...(occurrenceDate ? { occurrenceDate } : {}),
          remoteId: remote?.id,
          remoteTitle: remote?.title,
          reason: 'Multiple managed Google Tasks share this source key',
          resolution: 'Remove or resolve duplicate tasks in Google Tasks before reconciling',
        });
        continue;
      }

      if (!remote || remote.deleted) {
        continue;
      }

      if (entityKind === 'habit-task') {
        const habit = habitsById.get(entityId);
        const occDate = occurrenceDate ? dateKey(occurrenceDate) : undefined;
        if (!habit || !occDate) {
          actions.push({
            kind: 'conflict',
            key,
            entityKind,
            entityId,
            ...(occDate ? { occurrenceDate: occDate } : {}),
            remoteId: remote.id,
            remoteTitle: remote.title,
            reason: 'Habit or mapped occurrence date not found in Syntrop',
          });
          continue;
        }
        const existingOcc = occurrences.get(`${entityId}:${occDate}`);
        if (remote.status === 'completed') {
          if (existingOcc?.outcome === 'completed') {
            actions.push({
              kind: 'unchanged',
              key,
              entityKind,
              entityId,
              occurrenceDate: occDate,
              remoteId: remote.id,
              remoteTitle: remote.title,
              remoteCompletedAt: remote.completed,
              reason: 'Habit occurrence already recorded as completed in Syntrop',
            });
            continue;
          }
          if (!habit.active) {
            actions.push({
              kind: 'conflict',
              key,
              entityKind,
              entityId,
              occurrenceDate: occDate,
              remoteId: remote.id,
              remoteTitle: remote.title,
              remoteCompletedAt: remote.completed,
              reason: `Habit "${habit.name}" is inactive in Syntrop`,
              resolution: `Activate the habit first ('syntrop habit update ${entityId} --active yes') or restore Google state`,
            });
            continue;
          }
          if (existingOcc?.outcome === 'skipped' && !options.allowCorrectHabits) {
            actions.push({
              kind: 'conflict',
              key,
              entityKind,
              entityId,
              occurrenceDate: occDate,
              remoteId: remote.id,
              remoteTitle: remote.title,
              remoteCompletedAt: remote.completed,
              reason: `Habit occurrence for ${occDate} is recorded as skipped in Syntrop`,
              resolution: `Run 'syntrop integration google reconcile --correct-habits' or 'syntrop habit log ${entityId} --date ${occDate} --outcome completed --correct'`,
            });
            continue;
          }
          actions.push({
            kind: 'complete-habit',
            key,
            entityKind,
            entityId,
            occurrenceDate: occDate,
            remoteId: remote.id,
            remoteTitle: remote.title,
            remoteCompletedAt: remote.completed,
            reason: `Record habit completion for local occurrence date ${occDate} (${snapshot.timezone})`,
          });
        } else if (
          existingOcc?.outcome === 'completed' ||
          map?.lastAcceptedStatus === 'completed'
        ) {
          actions.push({
            kind: 'conflict',
            key,
            entityKind,
            entityId,
            occurrenceDate: occDate,
            remoteId: remote.id,
            remoteTitle: remote.title,
            reason: `Habit occurrence for ${occDate} was unchecked in Google Tasks after being confirmed completed in Syntrop`,
            resolution: `Confirmed Syntrop history is preserved. Use 'syntrop habit log ${entityId} --date ${occDate} --outcome skipped --correct' to amend local history, or 'syntrop integration google sync --resolve local' to re-check in Google Tasks`,
          });
        }
        continue;
      }

      // Ordinary Syntrop task
      const taskRow = tasksById.get(entityId);
      if (!taskRow) {
        if (remote.status === 'completed') {
          actions.push({
            kind: 'conflict',
            key,
            entityKind,
            entityId,
            remoteId: remote.id,
            remoteTitle: remote.title,
            reason: 'Syntrop task not found locally',
          });
        }
        continue;
      }

      const localStatus = String(taskRow.status);
      if (remote.status === 'completed') {
        if (localStatus === 'done') {
          actions.push({
            kind: 'unchanged',
            key,
            entityKind,
            entityId,
            remoteId: remote.id,
            remoteTitle: remote.title,
            remoteCompletedAt: remote.completed,
            reason: 'Task is already done in Syntrop',
          });
          continue;
        }
        if (localStatus === 'cancelled') {
          actions.push({
            kind: 'conflict',
            key,
            entityKind,
            entityId,
            remoteId: remote.id,
            remoteTitle: remote.title,
            remoteCompletedAt: remote.completed,
            reason: `Task "${taskRow.title}" is cancelled in Syntrop and cannot be marked done`,
            resolution: `Run 'syntrop integration google sync --resolve local' to remove the cancelled task from Google Tasks`,
          });
          continue;
        }
        if (taskRow.project_id) {
          const project = projectsById.get(String(taskRow.project_id));
          if (project && project.status !== 'active') {
            actions.push({
              kind: 'conflict',
              key,
              entityKind,
              entityId,
              remoteId: remote.id,
              remoteTitle: remote.title,
              remoteCompletedAt: remote.completed,
              reason: `Task belongs to ${project.status} project "${project.title}"`,
              resolution: `Activate project ${project.id} before completing this task, or restore local projection`,
            });
            continue;
          }
        }
        if (map?.sourceVersion !== undefined && Number(taskRow.version) !== map.sourceVersion) {
          actions.push({
            kind: 'conflict',
            key,
            entityKind,
            entityId,
            remoteId: remote.id,
            remoteTitle: remote.title,
            remoteCompletedAt: remote.completed,
            expectedVersion: map.sourceVersion,
            reason: `Local task version (${taskRow.version}) changed since last Google sync (${map.sourceVersion})`,
            resolution: `Inspect 'syntrop task show ${entityId}' and run 'syntrop task done ${entityId} --expected-version ${taskRow.version}' if intended`,
          });
          continue;
        }
        const blockedBy = unresolvedPrerequisites(snapshot, entityId);
        if (blockedBy.length > 0) {
          actions.push({
            kind: 'conflict',
            key,
            entityKind,
            entityId,
            remoteId: remote.id,
            remoteTitle: remote.title,
            remoteCompletedAt: remote.completed,
            blockedBy,
            reason: `Task has unfinished prerequisites: ${blockedBy.join(', ')}`,
            resolution: `Complete prerequisites (${blockedBy.join(', ')}) first, run 'syntrop task done ${entityId} --allow-blocked --reason "..."' if legitimately finished out of order, or run 'syntrop integration google sync --resolve local' to uncheck the Google Task`,
          });
          continue;
        }
        actions.push({
          kind: 'complete-task',
          key,
          entityKind,
          entityId,
          remoteId: remote.id,
          remoteTitle: remote.title,
          remoteCompletedAt: remote.completed,
          expectedVersion: Number(taskRow.version),
          reason: 'Completed in Google Tasks; prerequisites and project lifecycle verified',
        });
      } else if (localStatus === 'done' || map?.lastAcceptedStatus === 'completed') {
        actions.push({
          kind: 'conflict',
          key,
          entityKind,
          entityId,
          remoteId: remote.id,
          remoteTitle: remote.title,
          reason: `Task "${taskRow.title}" is done in Syntrop but unchecked in Google Tasks`,
          resolution: `Completed Syntrop tasks are historical. Run 'syntrop integration google sync --resolve local' to restore completed status in Google Tasks`,
        });
      }
    }
  }

  const summary = Object.fromEntries(
    ['complete-task', 'complete-habit', 'unchanged', 'conflict', 'skip'].map((kind) => [
      kind,
      actions.filter((a) => a.kind === kind).length,
    ]),
  );
  const approval = hash(JSON.stringify({ registry, actions }));
  return { approval, actions, summary };
}

export function applyReconcile(
  db: DatabaseSync,
  plan: ReconcilePlan,
  mappings: TaskMappingState,
  saveMappings: (value: TaskMappingState) => void,
  options: { allowCorrectHabits?: boolean } = {},
): Record<string, unknown> {
  const summary = {
    tasksCompleted: 0,
    habitsLogged: 0,
    unchanged: 0,
    conflicted: 0,
    failed: 0,
  };
  const completedTasks: Record<string, unknown>[] = [];
  const loggedHabits: Row[] = [];
  const failures: { key: string; code: string; message: string }[] = [];

  for (const action of plan.actions) {
    if (action.kind === 'conflict') {
      summary.conflicted++;
      continue;
    }
    if (action.kind === 'unchanged') {
      if (mappings[action.key]) {
        mappings[action.key]!.lastAcceptedStatus = 'completed';
        saveMappings(mappings);
      }
      summary.unchanged++;
      continue;
    }
    if (action.kind === 'skip') continue;

    try {
      if (action.kind === 'complete-habit') {
        const idempotencyKey = `google-reconcile:${action.key}:${action.remoteCompletedAt ?? 'done'}`;
        const recorded = mutate(db, idempotencyKey, idempotencyKey, () =>
          logHabit(
            db,
            action.entityId,
            action.occurrenceDate!,
            'completed',
            'Reconciled from Google Tasks',
            Boolean(options.allowCorrectHabits),
          ),
        );
        const validation = validate(db);
        if (!validation.ok)
          throw new LifeError(
            'VALIDATION',
            'Database validation failed after habit reconciliation',
          );
        const readBack = get(db, 'habit_occurrences', String(recorded.id));
        loggedHabits.push(readBack);
        if (mappings[action.key]) {
          mappings[action.key]!.lastAcceptedStatus = 'completed';
          mappings[action.key]!.lastSync = new Date().toISOString();
          saveMappings(mappings);
        }
        summary.habitsLogged++;
      } else if (action.kind === 'complete-task') {
        const idempotencyKey = `google-reconcile:${action.key}:v${action.expectedVersion ?? 1}`;
        const updated = mutate(db, idempotencyKey, idempotencyKey, () => {
          const row = get(db, 'tasks', action.entityId);
          assertVersion(row, String(action.expectedVersion ?? row.version));
          if (['done', 'cancelled'].includes(String(row.status)))
            throw new LifeError('CONFLICT', 'Task is already completed or cancelled');
          const details = task(db, action.entityId);
          if (details.blocked_by.length > 0)
            throw new LifeError(
              'CONFLICT',
              `Finish prerequisites before completing this task: ${details.blocked_by.join(', ')}`,
            );
          const at = now();
          db.prepare(
            `UPDATE tasks SET status = 'done', updated_at = ?, completed_at = ?, version = version + 1 WHERE id = ?`,
          ).run(at, at, action.entityId);
          const cancelledSessions = rows(
            db,
            `SELECT id FROM work_sessions WHERE task_id = ? AND status = 'scheduled' AND end_at > ?`,
            action.entityId,
            at,
          ).map((s) => String(s.id));
          for (const sessionId of cancelledSessions) cancelSession(db, sessionId);
          return { ...task(db, action.entityId), cancelled_sessions: cancelledSessions };
        });
        const validation = validate(db);
        if (!validation.ok)
          throw new LifeError('VALIDATION', 'Database validation failed after task reconciliation');
        completedTasks.push(updated as Record<string, unknown>);
        if (mappings[action.key]) {
          mappings[action.key]!.lastAcceptedStatus = 'completed';
          mappings[action.key]!.sourceVersion = Number(
            (updated as Record<string, unknown>).version,
          );
          mappings[action.key]!.lastSync = new Date().toISOString();
          saveMappings(mappings);
        }
        summary.tasksCompleted++;
      }
    } catch (error) {
      summary.failed++;
      failures.push({
        key: action.key,
        code: error instanceof LifeError ? error.code : 'RECONCILE_ERROR',
        message: error instanceof Error ? error.message : 'Reconciliation failed',
      });
    }
  }

  return {
    ...summary,
    operationalDataChanged: summary.tasksCompleted > 0 || summary.habitsLogged > 0,
    completedTasks,
    loggedHabits,
    failures,
  };
}
