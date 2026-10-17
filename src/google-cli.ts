import { createHash } from 'node:crypto';
import { existsSync, openSync, closeSync, unlinkSync, readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { LifeError, assertOutsideSource, type Context } from './db.ts';
import { rows } from './core.ts';
import { addDays, dateKey, localDate, timestamp } from './time.ts';
import {
  TASKS_SCOPE,
  integrationHome,
  readPrivate,
  writePrivate,
  setupClient,
  status,
  connect,
  disconnect,
} from './google-auth.ts';
import { GoogleClient } from './google-client.ts';
import {
  COLORS,
  desiredCalendarLabels,
  projectEvents,
  validatePresentation,
} from './google-projection.ts';
import {
  planSync,
  applySync,
  calendarPath,
  type CalendarRegistry,
  type MappingState,
} from './google-sync.ts';
import {
  applyReconcile,
  applyTasksSync,
  defaultTasksPolicy,
  listTasks,
  ownedTask,
  planReconcile,
  planTasksSync,
  projectTasks,
  taskListsPath,
  type TaskListRegistry,
  type TaskMappingState,
} from './google-tasks.ts';
import type { GoogleTaskList, HabitDisplay, ProjectionConfig, Snapshot } from './google-types.ts';

type Settings = {
  schema: 1 | 2;
  provisioned: boolean;
  tasksProvisioned?: boolean;
  projection: ProjectionConfig;
};
type Options = Record<string, string | boolean>;
const get = (options: Options, name: string) =>
  typeof options[name] === 'string' ? String(options[name]) : undefined;
const need = (options: Options, name: string) => {
  const value = get(options, name);
  if (!value) throw new LifeError('VALIDATION', `--${name} is required`);
  return value;
};
const bool = (value: string | undefined, fallback: boolean) => {
  if (value === undefined) return fallback;
  if (['true', 'on', 'yes'].includes(value)) return true;
  if (['false', 'off', 'no'].includes(value)) return false;
  throw new LifeError('VALIDATION', 'Boolean option must be true, false, on, or off');
};
const choices = <T extends string>(value: string, allowed: readonly T[]): T => {
  if (!allowed.includes(value as T))
    throw new LifeError('VALIDATION', `Expected one of ${allowed.join(', ')}`);
  return value as T;
};
function defaults(context: Context): Settings {
  return {
    schema: 1,
    provisioned: false,
    projection: {
      workspaceId: createHash('sha256')
        .update(realpathSync(context.path))
        .digest('hex')
        .slice(0, 24),
      titleMode: 'redacted',
      deadlines: false,
      commitments: true,
      habits: {},
      categories: {},
      excludeCommitments: [],
    },
  };
}
function snapshot(context: Context): Snapshot {
  const db = context.db;
  return {
    timezone: context.config.timezone,
    tasks: rows(db, 'SELECT * FROM tasks'),
    projects: rows(db, 'SELECT * FROM projects'),
    work_sessions: rows(db, 'SELECT * FROM work_sessions'),
    calendar_events: rows(db, 'SELECT * FROM calendar_events'),
    habits: rows(db, 'SELECT * FROM habits'),
    task_dependencies: rows(db, 'SELECT * FROM task_dependencies'),
    habit_occurrences: rows(db, 'SELECT * FROM habit_occurrences'),
  };
}
function tasksFeatureEnabled(
  config: ProjectionConfig,
  tasksRegistry: TaskListRegistry,
  taskMappings: TaskMappingState,
): boolean {
  return Boolean(
    (config.tasksPolicy && config.tasksPolicy.enabled && config.tasksPolicy.mode !== 'none') ||
    Object.values(config.habits).some((h) => h.mode === 'tasks') ||
    Object.values(config.presentation?.tasks ?? {}).some((t) => t.publish === true) ||
    tasksRegistry.tasks ||
    tasksRegistry.habits ||
    Object.keys(taskMappings).length > 0,
  );
}
const setupSteps = [
  'Create a Google Cloud project; enable Google Calendar API and Google Tasks API.',
  'Google Auth Platform: configure Branding and Audience. For External Testing, add your Google account as a test user.',
  'Clients: Create client > Desktop app. Download the JSON outside the Syntrop repository/workspace.',
  'Run integration google setup --client /absolute/path/client.json, then integration google connect. Never paste tokens into chat.',
  'Testing-mode refresh tokens may expire after seven days; production distribution/verification requirements depend on scopes and account policies.',
];
export async function googleCommand(
  context: Context,
  words: string[],
  options: Options,
): Promise<unknown> {
  if ((words.length !== 3 && words.length !== 4) || words[1] !== 'google')
    throw new LifeError(
      'VALIDATION',
      'Use integration google setup|connect|status|configure|presentation|habit|tasks|preview|sync|reconcile|migrate|diagnose|calendars|colors|availability|recover|disconnect',
    );
  const action = words[2]!;
  const subverb = words[3];
  if (words.length === 4 && !['presentation', 'tasks', 'habit'].includes(action))
    throw new LifeError(
      'VALIDATION',
      'Use integration google setup|connect|status|configure|presentation|habit|tasks|preview|sync|reconcile|migrate|diagnose|calendars|colors|availability|recover|disconnect',
    );
  const allowed: Record<string, string[]> = {
    setup: ['client'],
    connect: ['freebusy', 'calendar-only'],
    status: [],
    configure: [
      'title-mode',
      'deadlines',
      'commitments',
      'categories',
      'exclude-commitments',
      'presentation',
      'tasks-enabled',
      'tasks-mode',
      'include-backlog',
      'habit-horizon',
      'auto-sync',
      'auto-reconcile',
    ],
    presentation: ['file', 'json-body', 'reset'],
    habit: [
      'id',
      'mode',
      'start-date',
      'time',
      'duration',
      'weekdays',
      'reminder-minutes',
      'horizon-days',
      'short-name',
      'label',
    ],
    tasks: [
      'offline',
      'preview',
      'lists',
      'from',
      'through',
      'enabled',
      'mode',
      'task-ids',
      'project-ids',
      'include-backlog',
      'habit-horizon',
      'horizon-days',
      'tasks-list-title',
      'habits-list-title',
    ],
    preview: ['from', 'through', 'offline', 'resolve'],
    sync: ['from', 'through', 'approve', 'resolve', 'auto'],
    reconcile: ['preview', 'dry-run', 'approve', 'correct-habits', 'auto'],
    migrate: ['preview', 'dry-run', 'approve', 'from', 'through', 'resolve'],
    diagnose: ['offline', 'from', 'through'],
    calendars: [],
    colors: [],
    availability: ['calendars', 'start', 'end'],
    recover: ['focus', 'habits', 'tasks-list', 'habits-list'],
    disconnect: ['revoke'],
  };
  if (!allowed[action])
    throw new LifeError('VALIDATION', 'Unknown Google integration operation; run syntrop help');
  for (const key of Object.keys(options))
    if (!['workspace', 'json', ...allowed[action]!].includes(key))
      throw new LifeError('VALIDATION', `Unknown option --${key} for Google ${action}`);
  const home = integrationHome(context.path);
  const savedSettings = readPrivate<Settings>(home, 'config.json');
  const settings = savedSettings ?? defaults(context);
  if (
    ![1, 2].includes(Number(settings.schema)) ||
    settings.projection.workspaceId !== defaults(context).projection.workspaceId
  )
    throw new LifeError(
      'GOOGLE_CONFIG',
      'Unsupported integration configuration or different workspace; use explicit recovery',
    );
  const config = settings.projection;
  const registry = readPrivate<CalendarRegistry>(home, 'calendars.json') ?? {
    workspaceId: config.workspaceId,
  };
  const mappings = readPrivate<MappingState>(home, 'mappings.json') ?? {};
  const tasksRegistry = readPrivate<TaskListRegistry>(home, 'tasks-lists.json') ?? {
    workspaceId: config.workspaceId,
  };
  const taskMappings = readPrivate<TaskMappingState>(home, 'task-mappings.json') ?? {};
  const isTasksActive = tasksFeatureEnabled(config, tasksRegistry, taskMappings);

  if (action === 'status') {
    const authStatus = status(home);
    return {
      ...authStatus,
      tasksConnected: authStatus.scopes.includes(TASKS_SCOPE),
      configured: Boolean(savedSettings),
      managedCalendars: { focus: registry.focus ?? null, habits: registry.habits ?? null },
      managedTaskLists: {
        tasks: tasksRegistry.tasks ?? null,
        habits: tasksRegistry.habits ?? null,
      },
      uncertainCalendarCreation: registry.pending ?? null,
      uncertainTaskListCreation: tasksRegistry.pending ?? null,
      labelCapability: registry.labelCapability ?? 'untested',
      titleMode: config.titleMode,
      presentationConfigured: Boolean(config.presentation),
      tasksEnabled: isTasksActive,
      standingAuth: config.standingAuth ?? { autoSync: false, autoReconcile: false },
      manualSync: !config.standingAuth?.autoSync,
      operationalDataChanged: false,
    };
  }
  if (action === 'setup' && !get(options, 'client'))
    return {
      clientConfigured: status(home).clientConfigured,
      steps: setupSteps,
      guide: 'docs/integrations/google-calendar.md',
      liveGoogleTest: 'Supported via integration google connect and integration google diagnose',
    };
  if (action === 'calendars')
    return {
      source: 'local managed-calendar registry; not all personal calendars',
      focus: registry.focus ?? null,
      habits: registry.habits ?? null,
      taskLists: {
        tasks: tasksRegistry.tasks ?? null,
        habits: tasksRegistry.habits ?? null,
      },
    };
  const local = snapshot(context);
  const today = localDate(new Date(), local.timezone);
  const from = dateKey(get(options, 'from') ?? today);
  const through = dateKey(get(options, 'through') ?? addDays(from, 6));
  const horizonDays = config.tasksPolicy?.habitHorizonDays ?? 14;
  const tasksThrough = dateKey(
    get(options, 'through') ?? addDays(from, Math.max(6, horizonDays - 1)),
  );
  if (
    from > through ||
    new Date(through).getTime() - new Date(from).getTime() > 89 * 86400000 ||
    from > tasksThrough ||
    new Date(tasksThrough).getTime() - new Date(from).getTime() > 89 * 86400000
  )
    throw new LifeError('VALIDATION', 'Choose an inclusive window of 1–90 days');
  if (get(options, 'resolve') && get(options, 'resolve') !== 'local')
    throw new LifeError(
      'VALIDATION',
      '--resolve supports local only; remote changes never modify Syntrop without reconcile',
    );

  if (
    action === 'presentation' &&
    subverb !== 'apply' &&
    !get(options, 'file') &&
    !get(options, 'json-body') &&
    !options.reset
  ) {
    return {
      presentation: config.presentation ?? null,
      categories: config.categories,
      titleMode: config.titleMode,
      calendarLabels: desiredCalendarLabels(config),
      labelCapability: registry.labelCapability ?? 'untested',
      remoteWrites: 0,
    };
  }

  if (action === 'preview' && options.offline) {
    const activeLabels =
      config.presentation?.theme?.labels && registry.labelCapability !== 'unsupported'
        ? Object.fromEntries(
            Object.entries(desiredCalendarLabels(config)).map(([k, v]) => [k, v.id]),
          )
        : undefined;
    return {
      offline: true,
      remoteChecked: false,
      approval: null,
      from,
      through,
      events: projectEvents(local, config, from, through, undefined, activeLabels),
      ...(isTasksActive
        ? {
            tasksWindow: { from, through: tasksThrough },
            tasks: projectTasks(local, config, from, tasksThrough),
          }
        : {}),
      warning: 'Local projection only; authenticate and preview remote state before approving sync',
    };
  }

  if (action === 'diagnose') {
    const authStatus = status(home);
    const activeTaskHabits = local.habits.filter(
      (h) => h.active && config.habits[String(h.id)]?.mode === 'tasks',
    );
    const mappedDates = Object.values(taskMappings)
      .filter((m) => m.kind === 'habit-task' && m.occurrenceDate && m.occurrenceDate >= today)
      .map((m) => m.occurrenceDate!)
      .sort();
    const furthestHabitDate = mappedDates.at(-1) ?? null;
    const daysRemaining = furthestHabitDate
      ? Math.round(
          (new Date(`${furthestHabitDate}T00:00:00Z`).getTime() -
            new Date(`${today}T00:00:00Z`).getTime()) /
            86400000,
        ) + 1
      : 0;
    const horizonNeedsExtension = activeTaskHabits.length > 0 && daysRemaining <= 3;
    const healthy =
      authStatus.connected && !registry.pending && !tasksRegistry.pending && !horizonNeedsExtension;
    return {
      healthy,
      workspaceId: config.workspaceId,
      timezone: local.timezone,
      auth: {
        ...authStatus,
        tasksScopeGranted: authStatus.scopes.includes(TASKS_SCOPE),
        freebusyScopeGranted: authStatus.scopes.includes(
          'https://www.googleapis.com/auth/calendar.events.freebusy',
        ),
      },
      calendars: {
        focus: registry.focus ?? null,
        habits: registry.habits ?? null,
        pending: registry.pending ?? null,
        mappedEvents: Object.keys(mappings).length,
        labelCapability: registry.labelCapability ?? 'untested',
        configuredLabels: Object.keys(desiredCalendarLabels(config)).length,
      },
      tasks: {
        enabled: isTasksActive,
        lists: {
          tasks: tasksRegistry.tasks ?? null,
          habits: tasksRegistry.habits ?? null,
          pending: tasksRegistry.pending ?? null,
        },
        mappedTasks: Object.values(taskMappings).filter((m) => m.kind === 'task').length,
        mappedHabitOccurrences: Object.values(taskMappings).filter((m) => m.kind === 'habit-task')
          .length,
        activeTaskHabits: activeTaskHabits.length,
        furthestHabitDate,
        horizonDaysRemaining: activeTaskHabits.length ? daysRemaining : null,
        horizonNeedsExtension,
      },
      standingAuth: config.standingAuth ?? { autoSync: false, autoReconcile: false },
      remoteWrites: 0,
      localWrites: 0,
    };
  }

  // Mutating integration operations serialize locally. Preview remains entirely
  // read-only, including access-token refresh persistence.
  let lock: number | undefined;
  const lockPath = join(home, 'operation.lock');
  const mutating =
    [
      'setup',
      'configure',
      'presentation',
      'habit',
      'connect',
      'recover',
      'sync',
      'disconnect',
    ].includes(action) ||
    (action === 'tasks' &&
      (subverb === 'configure' ||
        [
          'enabled',
          'mode',
          'task-ids',
          'project-ids',
          'include-backlog',
          'habit-horizon',
          'horizon-days',
          'tasks-list-title',
          'habits-list-title',
        ].some((k) => k in options))) ||
    (action === 'reconcile' && !options.preview && !options['dry-run']) ||
    (action === 'migrate' &&
      !options.preview &&
      !options['dry-run'] &&
      Boolean(get(options, 'approve')));
  if (mutating) {
    writePrivate(home, 'storage-check.json', { schema: 1 });
    try {
      lock = openSync(lockPath, 'wx', 0o600);
    } catch {
      throw new LifeError(
        'CONFLICT',
        'Another Google operation is running, or operation.lock remains after interruption. Confirm no process is active before removing only that lock.',
      );
    }
  }
  try {
    if (JSON.stringify(readPrivate(home, 'config.json')) !== JSON.stringify(savedSettings))
      throw new LifeError('CONFLICT', 'Integration configuration changed; retry from fresh state');
    if (action === 'disconnect') return await disconnect(home, Boolean(options.revoke));
    if (action === 'setup') {
      const clientFile = realpathSync(need(options, 'client'));
      assertOutsideSource(clientFile);
      const operationalRoot = realpathSync(context.path);
      if (clientFile === operationalRoot || clientFile.startsWith(operationalRoot + sep))
        throw new LifeError(
          'VALIDATION',
          'Move the downloaded Desktop client JSON outside the operational workspace before setup; workspace backups include user files',
        );
      setupClient(home, clientFile);
      if (!savedSettings) writePrivate(home, 'config.json', settings);
      return { configured: true, next: 'integration google connect', steps: setupSteps };
    }
    if (action === 'presentation') {
      if (options.reset) {
        delete config.presentation;
        writePrivate(home, 'config.json', settings);
        return { presentation: null, remoteWrites: 0, next: 'integration google preview' };
      }
      const rawText = get(options, 'json-body') ?? readFileSync(need(options, 'file'), 'utf8');
      const raw: unknown = JSON.parse(rawText);
      config.presentation = validatePresentation(raw, local, config.categories);
      writePrivate(home, 'config.json', settings);
      return {
        presentation: config.presentation,
        calendarLabels: desiredCalendarLabels(config),
        remoteWrites: 0,
        next: 'integration google preview',
      };
    }
    if (action === 'configure') {
      if (get(options, 'title-mode'))
        config.titleMode = choices(need(options, 'title-mode'), ['redacted', 'titles']);
      config.deadlines = bool(get(options, 'deadlines'), config.deadlines);
      config.commitments = bool(get(options, 'commitments'), config.commitments);
      if (get(options, 'exclude-commitments') !== undefined)
        config.excludeCommitments = get(options, 'exclude-commitments')!.split(',').filter(Boolean);
      if (get(options, 'presentation')) {
        const raw: unknown = JSON.parse(readFileSync(need(options, 'presentation'), 'utf8'));
        config.presentation = validatePresentation(raw, local, config.categories);
      }
      if (get(options, 'categories')) {
        const categories: unknown = JSON.parse(readFileSync(need(options, 'categories'), 'utf8'));
        if (!categories || typeof categories !== 'object' || Array.isArray(categories))
          throw new LifeError('VALIDATION', 'Categories JSON must map project IDs to categories');
        const customLabels = config.presentation?.theme?.labels ?? {};
        const allowedCategories = [...Object.keys(COLORS), ...Object.keys(customLabels)];
        config.categories = Object.fromEntries(
          Object.entries(categories).map(([id, category]) => {
            if (!local.projects.some((p) => p.id === id))
              throw new LifeError('NOT_FOUND', 'Category references unknown project');
            return [id, choices(String(category), allowedCategories)];
          }),
        );
      }
      if (
        get(options, 'tasks-enabled') !== undefined ||
        get(options, 'tasks-mode') !== undefined ||
        get(options, 'include-backlog') !== undefined ||
        get(options, 'habit-horizon') !== undefined
      ) {
        const currentPolicy = config.tasksPolicy ?? defaultTasksPolicy();
        currentPolicy.enabled = bool(get(options, 'tasks-enabled'), currentPolicy.enabled);
        if (get(options, 'tasks-mode'))
          currentPolicy.mode = choices(need(options, 'tasks-mode'), [
            'actionable',
            'scheduled',
            'selected',
            'ready',
            'none',
          ]);
        currentPolicy.includeBacklog = bool(
          get(options, 'include-backlog'),
          Boolean(currentPolicy.includeBacklog),
        );
        if (get(options, 'habit-horizon')) {
          const h = Number(need(options, 'habit-horizon'));
          if (!Number.isSafeInteger(h) || h < 1 || h > 90)
            throw new LifeError('VALIDATION', 'Habit horizon must be 1..90 days');
          currentPolicy.habitHorizonDays = h;
        }
        config.tasksPolicy = currentPolicy;
      }
      if (get(options, 'auto-sync') !== undefined || get(options, 'auto-reconcile') !== undefined) {
        const currentAuth = config.standingAuth ?? { autoSync: false, autoReconcile: false };
        currentAuth.autoSync = bool(get(options, 'auto-sync'), currentAuth.autoSync);
        currentAuth.autoReconcile = bool(get(options, 'auto-reconcile'), currentAuth.autoReconcile);
        currentAuth.updatedAt = new Date().toISOString();
        config.standingAuth = currentAuth;
      }
      if (config.excludeCommitments.some((id) => !local.calendar_events.some((e) => e.id === id)))
        throw new LifeError('NOT_FOUND', 'Excluded commitment not found');
      writePrivate(home, 'config.json', settings);
      return { configuration: config, remoteWrites: 0, next: 'integration google preview' };
    }
    if (action === 'habit') {
      const id = subverb ?? need(options, 'id');
      if (!local.habits.some((h) => h.id === id))
        throw new LifeError('NOT_FOUND', 'Habit not found');
      const mode = choices(need(options, 'mode'), ['none', 'flexible', 'timed', 'tasks']);
      const display: HabitDisplay & { changedAt: string } = {
        mode,
        changedAt: new Date().toISOString(),
      };
      if (mode !== 'none') {
        display.startDate = dateKey(need(options, 'start-date'));
        if (get(options, 'time')) display.time = need(options, 'time');
        if (get(options, 'duration')) display.duration = Number(need(options, 'duration'));
        if (get(options, 'weekdays')) display.weekdays = need(options, 'weekdays').split(',');
        if (get(options, 'reminder-minutes'))
          display.reminderMinutes = Number(need(options, 'reminder-minutes'));
        if (get(options, 'horizon-days')) {
          const hd = Number(need(options, 'horizon-days'));
          if (!Number.isSafeInteger(hd) || hd < 1 || hd > 90)
            throw new LifeError('VALIDATION', 'Habit horizon-days must be 1..90');
          display.horizonDays = hd;
        }
      }
      if (get(options, 'short-name') || get(options, 'label')) {
        config.presentation ??= validatePresentation({ version: 1 }, local, config.categories);
        config.presentation.habits ??= {};
        config.presentation.habits[id] = {
          ...config.presentation.habits[id],
          ...(get(options, 'short-name') ? { shortName: need(options, 'short-name') } : {}),
          ...(get(options, 'label') ? { label: need(options, 'label') } : {}),
        };
        config.presentation = validatePresentation(config.presentation, local, config.categories);
      }
      config.habits[id] = display;
      if (mode === 'tasks') {
        config.tasksPolicy ??= defaultTasksPolicy();
        projectTasks(
          local,
          config,
          display.startDate ?? today,
          addDays(display.startDate ?? today, (display.horizonDays ?? 14) - 1),
        );
      } else {
        projectEvents(
          local,
          config,
          display.startDate ?? today,
          addDays(display.startDate ?? today, 30),
        );
      }
      writePrivate(home, 'config.json', settings);
      return {
        habitId: id,
        display,
        remoteWrites: 0,
        occurrenceTracking:
          mode === 'tasks'
            ? 'native Google Tasks occurrences; use integration google reconcile to import completions'
            : 'unchanged; use habit log',
        next: 'integration google preview',
      };
    }
    if (action === 'tasks' && mutating) {
      const policy = config.tasksPolicy ?? defaultTasksPolicy();
      policy.enabled = bool(get(options, 'enabled'), policy.enabled);
      if (get(options, 'mode'))
        policy.mode = choices(need(options, 'mode'), [
          'actionable',
          'scheduled',
          'selected',
          'ready',
          'none',
        ]);
      if (get(options, 'task-ids') !== undefined) {
        const ids = get(options, 'task-ids')!.split(',').filter(Boolean);
        for (const id of ids)
          if (!local.tasks.some((t) => String(t.id) === id))
            throw new LifeError('NOT_FOUND', `Unknown task ID: ${id}`);
        policy.taskIds = ids;
      }
      if (get(options, 'project-ids') !== undefined) {
        const ids = get(options, 'project-ids')!.split(',').filter(Boolean);
        for (const id of ids)
          if (!local.projects.some((p) => String(p.id) === id))
            throw new LifeError('NOT_FOUND', `Unknown project ID: ${id}`);
        policy.projectIds = ids;
      }
      policy.includeBacklog = bool(get(options, 'include-backlog'), Boolean(policy.includeBacklog));
      const horizonVal = get(options, 'habit-horizon') ?? get(options, 'horizon-days');
      if (horizonVal) {
        const hd = Number(horizonVal);
        if (!Number.isSafeInteger(hd) || hd < 1 || hd > 90)
          throw new LifeError('VALIDATION', 'Habit horizon must be 1..90 days');
        policy.habitHorizonDays = hd;
      }
      if (get(options, 'tasks-list-title') || get(options, 'habits-list-title')) {
        policy.lists ??= { tasks: 'Syntrop · Tasks', habits: 'Syntrop · Habits' };
        if (get(options, 'tasks-list-title'))
          policy.lists.tasks = need(options, 'tasks-list-title').slice(0, 80);
        if (get(options, 'habits-list-title'))
          policy.lists.habits = need(options, 'habits-list-title').slice(0, 80);
      }
      config.tasksPolicy = policy;
      projectTasks(local, config, from, tasksThrough);
      writePrivate(home, 'config.json', settings);
      return { tasksPolicy: policy, remoteWrites: 0, next: 'integration google preview' };
    }
    if (action === 'tasks' && options.offline) {
      return {
        offline: true,
        from,
        through: tasksThrough,
        tasksPolicy: config.tasksPolicy ?? defaultTasksPolicy(),
        managedTaskLists: {
          tasks: tasksRegistry.tasks ?? null,
          habits: tasksRegistry.habits ?? null,
        },
        tasks: projectTasks(local, config, from, tasksThrough),
        remoteWrites: 0,
      };
    }
    if (action === 'connect') {
      if (!savedSettings) throw new LifeError('GOOGLE_CONFIG', 'Run setup --client FILE first');
      const priorScopes = status(home).scopes;
      return await connect(home, {
        freebusy:
          Boolean(options.freebusy) ||
          priorScopes.includes('https://www.googleapis.com/auth/calendar.events.freebusy'),
        tasks: !options['calendar-only'],
        onUrl: (url) => console.error(`Authorize in your system browser: ${url}`),
      });
    }
    const readOnlyAction =
      ['preview', 'colors', 'availability', 'tasks'].includes(action) || Boolean(options.preview);
    const provider = new GoogleClient(home, {
      persistTokens: !readOnlyAction,
    });
    if (action === 'colors') return await provider.request('GET', '/colors');
    if (action === 'availability') {
      const start = timestamp(need(options, 'start')),
        end = timestamp(need(options, 'end'));
      if (end <= start || new Date(end).getTime() - new Date(start).getTime() > 90 * 86400000)
        throw new LifeError(
          'VALIDATION',
          'Availability window must be positive and at most 90 days',
        );
      const calendars = [...new Set(need(options, 'calendars').split(',').filter(Boolean))];
      if (!calendars.length || calendars.length > 50)
        throw new LifeError('VALIDATION', 'Choose 1–50 external calendar IDs');
      if (calendars.some((id) => id === registry.focus || id === registry.habits))
        throw new LifeError(
          'VALIDATION',
          'Managed Syntrop calendars cannot be counted as external busy calendars',
        );
      if (!status(home).scopes.includes('https://www.googleapis.com/auth/calendar.events.freebusy'))
        throw new LifeError('GOOGLE_SCOPE', 'Reconnect with --freebusy to authorize availability');
      const result = await provider.request<{
        calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }>;
      }>('POST', '/freeBusy', {
        timeMin: start,
        timeMax: end,
        timeZone: local.timezone,
        items: calendars.map((id) => ({ id })),
      });
      if (
        !result.calendars ||
        calendars.some((id) => !result.calendars![id] || result.calendars![id]!.errors?.length)
      )
        throw new LifeError(
          'GOOGLE_AVAILABILITY',
          'One or more external calendars could not be checked; availability is unknown',
        );
      return {
        externalBusy: Object.fromEntries(
          calendars.map((id) => [id, result.calendars![id]!.busy ?? []]),
        ),
        titlesRead: false,
        managedCalendarsExcluded: true,
        localScheduleChanged: false,
      };
    }
    if (action === 'recover') {
      let recovered = 0;
      for (const role of ['focus', 'habits'] as const)
        if (get(options, role)) {
          const id = need(options, role);
          const calendar = await provider.request<{ description?: string }>(
            'GET',
            calendarPath(id),
          );
          if (calendar.description !== `Syntrop managed projection ${config.workspaceId} ${role}`)
            throw new LifeError(
              'CONFLICT',
              'Calendar does not carry this workspace ownership marker',
            );
          registry[role] = id;
          if (registry.pending === role) delete registry.pending;
          recovered++;
        }
      for (const [optName, role] of [
        ['tasks-list', 'tasks'],
        ['habits-list', 'habits'],
      ] as const) {
        if (get(options, optName)) {
          const id = need(options, optName);
          const listMeta = await provider.request<GoogleTaskList>('GET', taskListsPath(id));
          if (!listMeta.id) throw new LifeError('NOT_FOUND', `Google Task list not found: ${id}`);
          const items = await listTasks(provider, id);
          const activeItems = items.filter((item) => !item.deleted);
          const foreign = activeItems.some((item) => !ownedTask(item, config.workspaceId));
          const expectedTitle =
            role === 'tasks'
              ? (config.tasksPolicy?.lists?.tasks ?? 'Syntrop · Tasks')
              : (config.tasksPolicy?.lists?.habits ?? 'Syntrop · Habits');
          if (foreign || (activeItems.length === 0 && listMeta.title !== expectedTitle)) {
            throw new LifeError(
              'CONFLICT',
              'Task list contains unowned tasks or does not match this workspace managed list title',
            );
          }
          tasksRegistry[role] = id;
          if (tasksRegistry.pending === role) delete tasksRegistry.pending;
          recovered++;
        }
      }
      if (!recovered)
        throw new LifeError(
          'VALIDATION',
          'Supply --focus ID, --habits ID, --tasks-list ID, or --habits-list ID',
        );
      if (registry.focus || registry.habits) settings.provisioned = true;
      if (tasksRegistry.tasks || tasksRegistry.habits) settings.tasksProvisioned = true;
      writePrivate(home, 'config.json', settings);
      writePrivate(home, 'calendars.json', registry);
      if (tasksRegistry.tasks || tasksRegistry.habits)
        writePrivate(home, 'tasks-lists.json', tasksRegistry);
      return {
        recovered,
        calendars: registry,
        taskLists: tasksRegistry,
        remoteWrites: 0,
        next: 'integration google preview',
      };
    }

    if (action === 'tasks') {
      if (options.lists) {
        const remoteLists: Record<string, GoogleTaskList | null> = { tasks: null, habits: null };
        for (const role of ['tasks', 'habits'] as const) {
          if (tasksRegistry[role]) {
            remoteLists[role] = await provider.request<GoogleTaskList>(
              'GET',
              taskListsPath(tasksRegistry[role]!),
            );
          }
        }
        return {
          source: 'local managed-task-list registry; not all personal task lists',
          managedTaskLists: remoteLists,
          remoteWrites: 0,
        };
      }
      const taskPlan = await planTasksSync(
        provider,
        local,
        config,
        tasksRegistry,
        taskMappings,
        from,
        tasksThrough,
      );
      return {
        tasksPolicy: config.tasksPolicy ?? defaultTasksPolicy(),
        managedTaskLists: {
          tasks: tasksRegistry.tasks ?? null,
          habits: tasksRegistry.habits ?? null,
        },
        ...taskPlan,
        remoteWrites: 0,
        localWrites: 0,
      };
    }

    if (action === 'reconcile') {
      if (settings.tasksProvisioned && !readPrivate(home, 'tasks-lists.json'))
        throw new LifeError(
          'GOOGLE_RECOVERY',
          'Task list registry is missing; recover managed task list IDs before reconciling.',
        );
      const reconcilePlan = await planReconcile(
        provider,
        local,
        config,
        tasksRegistry,
        taskMappings,
        { allowCorrectHabits: Boolean(options['correct-habits']) },
      );
      if (options.preview || options['dry-run']) {
        return {
          ...reconcilePlan,
          remoteWrites: 0,
          localWrites: 0,
          next: `integration google reconcile --approve ${reconcilePlan.approval}${options['correct-habits'] ? ' --correct-habits' : ''}`,
        };
      }
      if (options.auto && !config.standingAuth?.autoReconcile) {
        throw new LifeError(
          'CONFIRMATION_REQUIRED',
          'Standing auto-reconcile authorization is disabled for this workspace; run reconcile --preview and supply --approve HASH, or enable --auto-reconcile on',
        );
      }
      if (get(options, 'approve') && get(options, 'approve') !== reconcilePlan.approval) {
        throw new LifeError(
          'CONFLICT',
          'Reconcile approval hash is stale; inspect a fresh reconcile --preview before applying',
        );
      }
      if (JSON.stringify(snapshot(context)) !== JSON.stringify(local))
        throw new LifeError(
          'CONFLICT',
          'Operational state changed since reconcile inspection; retry from fresh state',
        );
      const reconcileResult = applyReconcile(
        context.db,
        reconcilePlan,
        taskMappings,
        (value) => writePrivate(home, 'task-mappings.json', value),
        { allowCorrectHabits: Boolean(options['correct-habits']) },
      );
      if (Number(reconcileResult.failed) || Number(reconcileResult.conflicted))
        process.exitCode = 3;
      return {
        ...reconcileResult,
        remoteWrites: 0,
      };
    }

    if (
      (!savedSettings && status(home).connected) ||
      (settings.provisioned && !readPrivate(home, 'calendars.json')) ||
      (settings.tasksProvisioned && !readPrivate(home, 'tasks-lists.json'))
    )
      throw new LifeError(
        'GOOGLE_RECOVERY',
        'Calendar or task list registry/configuration is missing; recover managed IDs before syncing. Do not create replacement resources blindly.',
      );
    for (const role of ['focus', 'habits'] as const)
      if (registry[role]) {
        const metadata = await provider.request<{ description?: string }>(
          'GET',
          calendarPath(registry[role]!),
        );
        if (metadata.description !== `Syntrop managed projection ${config.workspaceId} ${role}`)
          throw new LifeError(
            'CONFLICT',
            'Managed calendar ownership marker changed; inspect Google before syncing',
          );
      }

    const resolveLocal = get(options, 'resolve') === 'local';
    const plan = await planSync(
      provider,
      local,
      config,
      registry,
      mappings,
      from,
      through,
      resolveLocal,
    );

    const taskPlan = isTasksActive
      ? await planTasksSync(
          provider,
          local,
          config,
          tasksRegistry,
          taskMappings,
          from,
          tasksThrough,
          resolveLocal,
        )
      : undefined;

    const combinedApproval = taskPlan
      ? createHash('sha256')
          .update(
            JSON.stringify({ calendarApproval: plan.approval, tasksApproval: taskPlan.approval }),
          )
          .digest('hex')
      : plan.approval;

    if (action === 'migrate') {
      const existingFocusPreserved = plan.actions.filter(
        (a) =>
          a.calendar === 'focus' &&
          (a.kind === 'unchanged' || a.kind === 'update') &&
          Boolean(a.remoteId),
      );
      const eventsVisuallyUpdated = plan.actions.filter(
        (a) => a.calendar === 'focus' && a.kind === 'update',
      );
      const oldHabitsToRetire = plan.actions.filter(
        (a) => a.key.startsWith('habit:') && (a.kind === 'cancel' || a.stopped),
      );
      const newOrdinaryTasks = (taskPlan?.actions ?? []).filter(
        (a) => a.entityKind === 'task' && a.kind === 'create',
      );
      const newHabitTasks = (taskPlan?.actions ?? []).filter(
        (a) => a.entityKind === 'habit-task' && a.kind === 'create',
      );
      const conflicts = [
        ...plan.actions.filter((a) => a.kind === 'conflict'),
        ...(taskPlan?.actions.filter((a) => a.kind === 'conflict') ?? []),
      ];

      if (options.preview || options['dry-run'] || !get(options, 'approve')) {
        return {
          migrationPreview: true,
          from,
          through,
          tasksThrough,
          approval: combinedApproval,
          summary: {
            existingFocusEventsPreserved: existingFocusPreserved.length,
            focusEventsUpdatedVisually: eventsVisuallyUpdated.length,
            newOrdinaryTasksToCreate: newOrdinaryTasks.length,
            habitOccurrencesToCreate: newHabitTasks.length,
            oldHabitSeriesToRetire: oldHabitsToRetire.length,
            conflicts: conflicts.length,
          },
          calendarsToCreate: plan.calendarsToCreate,
          taskListsToCreate: taskPlan?.listsToCreate ?? [],
          labelsToSync: plan.labelsToSync ?? [],
          labelMode: plan.labelMode ?? 'palette',
          calendarActions: plan.actions,
          taskActions: taskPlan?.actions ?? [],
          privacy: {
            titleMode: config.titleMode,
            projectedFields: ['title/summary', 'scheduled times/dates', 'ownership markers'],
            excludedPrivateData: [
              'knowledge/',
              'journal/',
              'task descriptions',
              'session outcome notes',
              'decision rationales',
            ],
          },
          remoteWrites: 0,
          localWrites: 0,
          next: `integration google migrate --from ${from} --through ${through} --approve ${combinedApproval}${resolveLocal ? ' --resolve local' : ''}`,
        };
      }
    }

    if (action === 'preview')
      return {
        ...plan,
        approval: combinedApproval,
        ...(taskPlan
          ? {
              tasksPlan: {
                from: taskPlan.from,
                through: taskPlan.through,
                listsToCreate: taskPlan.listsToCreate,
                actions: taskPlan.actions,
                summary: taskPlan.summary,
                ...(taskPlan.horizonWarning ? { horizonWarning: taskPlan.horizonWarning } : {}),
              },
            }
          : {}),
        remoteWrites: 0,
        localWrites: 0,
        next: `integration google sync --from ${from} --through ${through} --approve ${combinedApproval}${get(options, 'resolve') ? ' --resolve local' : ''}`,
      };

    if (options.auto) {
      if (!config.standingAuth?.autoSync) {
        throw new LifeError(
          'CONFIRMATION_REQUIRED',
          'Standing auto-sync authorization is disabled for this workspace; run preview and supply --approve HASH, or enable --auto-sync on',
        );
      }
      const conflicts = [
        ...plan.actions.filter((a) => a.kind === 'conflict'),
        ...(taskPlan?.actions.filter((a) => a.kind === 'conflict') ?? []),
      ];
      if (conflicts.length > 0 && !resolveLocal) {
        throw new LifeError(
          'CONFLICT',
          'Remote drift or conflicts detected; standing auto-sync stops safely so conflicts can be reviewed',
        );
      }
    } else if (need(options, 'approve') !== combinedApproval) {
      throw new LifeError(
        'CONFLICT',
        'Preview approval is missing or stale; inspect a fresh preview before publishing',
      );
    }
    if (JSON.stringify(snapshot(context)) !== JSON.stringify(local))
      throw new LifeError(
        'CONFLICT',
        'Operational state changed since preview; inspect a fresh preview',
      );

    // Phase 4 safe execution ordering: create and verify new Google Tasks and daily habit
    // task occurrences BEFORE retiring redundant Calendar habit series.
    let tasksResult: Record<string, unknown> | undefined;
    if (taskPlan) {
      tasksResult = await applyTasksSync(
        provider,
        taskPlan,
        config,
        tasksRegistry,
        taskMappings,
        (value) => {
          writePrivate(home, 'tasks-lists.json', value);
          if (value.tasks || value.habits) {
            settings.tasksProvisioned = true;
            writePrivate(home, 'config.json', settings);
          }
        },
        (value) => writePrivate(home, 'task-mappings.json', value),
      );
    }

    const skipHabitRetire = Boolean(
      tasksResult && (Number(tasksResult.failed) > 0 || Number(tasksResult.conflicted) > 0),
    );

    const result = await applySync(
      provider,
      plan,
      registry,
      mappings,
      local.timezone,
      (value) => {
        writePrivate(home, 'calendars.json', value);
        if (value.focus || value.habits) {
          settings.provisioned = true;
          writePrivate(home, 'config.json', settings);
        }
      },
      (value) => writePrivate(home, 'mappings.json', value),
      { snapshot: local, config, skipHabitRetire },
    );

    const totalFailed = Number(result.failed) + Number(tasksResult?.failed ?? 0);
    const totalConflicted = Number(result.conflicted) + Number(tasksResult?.conflicted ?? 0);
    if (totalFailed || totalConflicted) process.exitCode = 3;

    return {
      ...result,
      ...(tasksResult ? { tasks: tasksResult } : {}),
      manualSync: !config.standingAuth?.autoSync,
      operationalDataChanged: false,
      calendarUrls: Object.fromEntries(
        (['focus', 'habits'] as const)
          .filter((role) => registry[role])
          .map((role) => [
            role,
            `https://calendar.google.com/calendar/u/0/r?cid=${encodeURIComponent(registry[role]!)}`,
          ]),
      ),
      ...(tasksRegistry.tasks || tasksRegistry.habits
        ? {
            taskLists: {
              tasks: tasksRegistry.tasks ?? null,
              habits: tasksRegistry.habits ?? null,
            },
          }
        : {}),
    };
  } finally {
    if (lock !== undefined) {
      closeSync(lock);
      unlinkSync(lockPath);
    }
  }
}
