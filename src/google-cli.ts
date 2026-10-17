import { createHash } from 'node:crypto';
import { existsSync, openSync, closeSync, unlinkSync, readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { LifeError, assertOutsideSource, type Context } from './db.ts';
import { rows } from './core.ts';
import { addDays, dateKey, localDate, timestamp } from './time.ts';
import {
  integrationHome,
  readPrivate,
  writePrivate,
  setupClient,
  status,
  connect,
  disconnect,
} from './google-auth.ts';
import { GoogleClient } from './google-client.ts';
import { projectEvents } from './google-projection.ts';
import {
  planSync,
  applySync,
  calendarPath,
  type CalendarRegistry,
  type MappingState,
} from './google-sync.ts';
import type { HabitDisplay, ProjectionConfig, Snapshot } from './google-types.ts';

type Settings = { schema: 1; provisioned: boolean; projection: ProjectionConfig };
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
  if (!['true', 'false'].includes(value))
    throw new LifeError('VALIDATION', 'Boolean option must be true or false');
  return value === 'true';
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
  };
}
const setupSteps = [
  'Create a Google Cloud project; enable Google Calendar API.',
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
  if (words.length !== 3 || words[1] !== 'google')
    throw new LifeError(
      'VALIDATION',
      'Use integration google setup|connect|status|configure|habit|preview|sync|calendars|colors|availability|recover|disconnect',
    );
  const action = words[2]!;
  const allowed: Record<string, string[]> = {
    setup: ['client'],
    connect: ['freebusy'],
    status: [],
    configure: ['title-mode', 'deadlines', 'commitments', 'categories', 'exclude-commitments'],
    habit: ['id', 'mode', 'start-date', 'time', 'duration', 'weekdays', 'reminder-minutes'],
    preview: ['from', 'through', 'offline', 'resolve'],
    sync: ['from', 'through', 'approve', 'resolve'],
    calendars: [],
    colors: [],
    availability: ['calendars', 'start', 'end'],
    recover: ['focus', 'habits'],
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
    settings.schema !== 1 ||
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
  if (action === 'status')
    return {
      ...status(home),
      configured: Boolean(savedSettings),
      managedCalendars: { focus: registry.focus ?? null, habits: registry.habits ?? null },
      uncertainCalendarCreation: registry.pending ?? null,
      titleMode: config.titleMode,
      manualSync: true,
      operationalDataChanged: false,
    };
  if (action === 'setup' && !get(options, 'client'))
    return {
      clientConfigured: status(home).clientConfigured,
      steps: setupSteps,
      guide: 'docs/integrations/google-calendar.md',
      liveGoogleTest: 'NOT COMPLETED: requires account owner authorization',
    };
  if (action === 'calendars')
    return {
      source: 'local managed-calendar registry; not all personal calendars',
      focus: registry.focus ?? null,
      habits: registry.habits ?? null,
    };
  const local = snapshot(context);
  const today = localDate(new Date(), local.timezone);
  const from = dateKey(get(options, 'from') ?? today);
  const through = dateKey(get(options, 'through') ?? addDays(from, 6));
  if (from > through || new Date(through).getTime() - new Date(from).getTime() > 89 * 86400000)
    throw new LifeError('VALIDATION', 'Choose an inclusive window of 1–90 days');
  if (get(options, 'resolve') && get(options, 'resolve') !== 'local')
    throw new LifeError(
      'VALIDATION',
      '--resolve supports local only; remote changes never modify Syntrop',
    );
  if (action === 'preview' && options.offline)
    return {
      offline: true,
      remoteChecked: false,
      approval: null,
      from,
      through,
      events: projectEvents(local, config, from, through),
      warning: 'Local projection only; authenticate and preview remote state before approving sync',
    };
  // Mutating integration operations serialize locally. Preview remains entirely
  // read-only, including access-token refresh persistence.
  let lock: number | undefined;
  const lockPath = join(home, 'operation.lock');
  const mutating = [
    'setup',
    'configure',
    'habit',
    'connect',
    'recover',
    'sync',
    'disconnect',
  ].includes(action);
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
    if (action === 'configure') {
      if (get(options, 'title-mode'))
        config.titleMode = choices(need(options, 'title-mode'), ['redacted', 'titles']);
      config.deadlines = bool(get(options, 'deadlines'), config.deadlines);
      config.commitments = bool(get(options, 'commitments'), config.commitments);
      if (get(options, 'exclude-commitments') !== undefined)
        config.excludeCommitments = get(options, 'exclude-commitments')!.split(',').filter(Boolean);
      if (get(options, 'categories')) {
        const categories: unknown = JSON.parse(readFileSync(need(options, 'categories'), 'utf8'));
        if (!categories || typeof categories !== 'object' || Array.isArray(categories))
          throw new LifeError('VALIDATION', 'Categories JSON must map project IDs to categories');
        config.categories = Object.fromEntries(
          Object.entries(categories).map(([id, category]) => {
            if (!local.projects.some((p) => p.id === id))
              throw new LifeError('NOT_FOUND', 'Category references unknown project');
            return [
              id,
              choices(String(category), ['career', 'oss', 'learning', 'review', 'default']),
            ];
          }),
        );
      }
      if (config.excludeCommitments.some((id) => !local.calendar_events.some((e) => e.id === id)))
        throw new LifeError('NOT_FOUND', 'Excluded commitment not found');
      writePrivate(home, 'config.json', settings);
      return { configuration: config, remoteWrites: 0, next: 'integration google preview' };
    }
    if (action === 'habit') {
      const id = need(options, 'id');
      if (!local.habits.some((h) => h.id === id))
        throw new LifeError('NOT_FOUND', 'Habit not found');
      const mode = choices(need(options, 'mode'), ['none', 'flexible', 'timed']);
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
      }
      config.habits[id] = display;
      projectEvents(
        local,
        config,
        display.startDate ?? today,
        addDays(display.startDate ?? today, 30),
      );
      writePrivate(home, 'config.json', settings);
      return {
        habitId: id,
        display,
        remoteWrites: 0,
        occurrenceTracking: 'unchanged; use habit log',
        next: 'integration google preview',
      };
    }
    if (action === 'connect') {
      if (!savedSettings) throw new LifeError('GOOGLE_CONFIG', 'Run setup --client FILE first');
      return await connect(home, {
        freebusy: Boolean(options.freebusy),
        onUrl: (url) => console.error(`Authorize in your system browser: ${url}`),
      });
    }
    const provider = new GoogleClient(home, {
      persistTokens: !['preview', 'colors', 'availability'].includes(action),
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
      if (!recovered)
        throw new LifeError(
          'VALIDATION',
          'Supply --focus ID or --habits ID from the managed calendar settings',
        );
      settings.provisioned = true;
      writePrivate(home, 'config.json', settings);
      writePrivate(home, 'calendars.json', registry);
      return {
        recovered,
        calendars: registry,
        remoteWrites: 0,
        next: 'integration google preview',
      };
    }
    if (
      (!savedSettings && status(home).connected) ||
      (settings.provisioned && !readPrivate(home, 'calendars.json'))
    )
      throw new LifeError(
        'GOOGLE_RECOVERY',
        'Calendar registry/configuration is missing; recover managed calendar IDs before syncing. Do not create replacement calendars blindly.',
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
    const plan = await planSync(
      provider,
      local,
      config,
      registry,
      mappings,
      from,
      through,
      get(options, 'resolve') === 'local',
    );
    if (action === 'preview')
      return {
        ...plan,
        remoteWrites: 0,
        localWrites: 0,
        next: `integration google sync --from ${from} --through ${through} --approve ${plan.approval}${get(options, 'resolve') ? ' --resolve local' : ''}`,
      };
    if (need(options, 'approve') !== plan.approval)
      throw new LifeError(
        'CONFLICT',
        'Preview approval is missing or stale; inspect a fresh preview before publishing',
      );
    if (JSON.stringify(snapshot(context)) !== JSON.stringify(local))
      throw new LifeError(
        'CONFLICT',
        'Operational state changed since preview; inspect a fresh preview',
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
    );
    if (Number(result.failed) || Number(result.conflicted)) process.exitCode = 3;
    return {
      ...result,
      operationalDataChanged: false,
      calendarUrls: Object.fromEntries(
        (['focus', 'habits'] as const)
          .filter((role) => registry[role])
          .map((role) => [
            role,
            `https://calendar.google.com/calendar/u/0/r?cid=${encodeURIComponent(registry[role]!)}`,
          ]),
      ),
    };
  } finally {
    if (lock !== undefined) {
      closeSync(lock);
      unlinkSync(lockPath);
    }
  }
}
