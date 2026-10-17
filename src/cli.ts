#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  chmodSync,
  cpSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import {
  LifeError,
  init,
  openWorkspace,
  workspacePath,
  mutate,
  backupDb,
  checkTimezone,
  databasePath,
  assertOutsideSource,
} from './db.ts';
import {
  id,
  now,
  get,
  rows,
  text,
  choice,
  integer,
  maybeId,
  assertVersion,
  task,
  taskList,
  addDependency,
  addSession,
  addEvent,
  moveTime,
  cancelSession,
  cancelEvent,
  recordSession,
  logHabit,
  dateView,
  weeklyReview,
  validate,
} from './core.ts';
import { timestamp, localTime } from './time.ts';

type Options = Record<string, string | boolean>;
type Parsed = { words: string[]; options: Options };
const help = `Syntrop — deterministic operational memory

Usage: syntrop [--workspace PATH] [--json] COMMAND [SUBCOMMAND] [options]
       syn [--workspace PATH] [--json] COMMAND [SUBCOMMAND] [options]

Workspace: init [--timezone IANA], doctor, validate, export, backup --to DIRECTORY,
           restore --from DIRECTORY --workspace NEW_PATH [--timezone IANA]
Goals:     goal add --title TEXT | list | show ID | update ID [--title TEXT] [--status STATUS]
Projects:  project add --title TEXT [--goal ID] | list | show ID | update ID [--title TEXT] [--status STATUS]
           project update ID --status done --allow-open-tasks --reason TEXT (exception only)
Tasks:     task add --title TEXT [--project ID] [--status STATUS] [--priority 1..5] [--depends-on ID[,ID]]
           task list [--project ID] | next | show ID | update ID [fields] [--expected-version N]
           task done ID [--allow-blocked --reason TEXT] | cancel ID | depends add TASK PREREQUISITE | depends remove TASK PREREQUISITE
Habits:    habit add --name TEXT [--frequency daily|weekly] [--target N] | list | show ID | update ID [fields]
           habit log ID --date YYYY-MM-DD --outcome completed|skipped [--correct] | history ID
Schedule:  schedule add --task ID --start ISO_OFFSET --end ISO_OFFSET | list | move ID --start ISO_OFFSET --end ISO_OFFSET | cancel ID
           schedule record ID --outcome completed|skipped --actual-minutes N [--note TEXT] [--correct --expected-version N]
Calendar:  calendar add --title TEXT --start ISO_OFFSET --end ISO_OFFSET | list | move ID --start ISO_OFFSET --end ISO_OFFSET | cancel ID
Decisions: decision add --title TEXT --rationale TEXT [--project ID] [--source-url URL] | list | show ID
Views:     today | tomorrow | week [--date YYYY-MM-DD] [--write]
Review:    review week [--date YYYY-MM-DD] [--json]

Google (optional): integration google setup [--client FILE] | connect [--freebusy] | status
           configure [--title-mode redacted|titles] [--deadlines true|false] [--commitments true|false]
                     [--categories FILE] [--exclude-commitments ID,ID]
           habit --id ID --mode none|flexible|timed [--start-date DATE] [--time HH:MM --duration MINUTES --weekdays MO,TU]
                 [--reminder-minutes N]
           preview [--offline] [--from DATE --through DATE] [--resolve local]
           sync --approve PREVIEW_HASH [--from DATE --through DATE] [--resolve local]
           calendars | colors | availability --calendars ID,ID --start ISO_OFFSET --end ISO_OFFSET
           recover [--focus CALENDAR_ID] [--habits CALENDAR_ID] | disconnect [--revoke]
Google status/setup/configure/habit/calendars/offline-preview are local integration operations.
connect uses system-browser OAuth; colors/availability/online-preview read Google (preview never writes events).
sync writes Google only after a matching preview approval. recover reads Google and repairs local integration metadata.
disconnect removes local tokens; --revoke also revokes Google authorization. These never modify Syntrop records.
Core task/calendar/habit operations remain offline; manual Google synchronization is optional.

Database mutation commands accept --idempotency-key KEY. Times require an explicit offset,
for example 2026-10-15T09:00+07:00. --json emits one JSON value; errors use stderr
and exit codes 2 (input), 3 (conflict), 4 (workspace/storage).`;

function parse(args: string[]): Parsed {
  const words: string[] = [],
    options: Options = {};
  const flags = new Set([
    'json',
    'write',
    'correct',
    'help',
    'allow-blocked',
    'allow-open-tasks',
    'freebusy',
    'offline',
    'revoke',
  ]);
  for (let i = 0; i < args.length; i++) {
    const value = args[i]!;
    if (!value.startsWith('--')) {
      words.push(value);
      continue;
    }
    const name = value.slice(2);
    if (!/^[a-z][a-z-]*$/.test(name)) throw new LifeError('VALIDATION', `Invalid option: ${value}`);
    if (name in options) throw new LifeError('VALIDATION', `Repeated option: --${name}`);
    if (flags.has(name)) {
      options[name] = true;
      continue;
    }
    const next = args[++i];
    if (!next || next.startsWith('--'))
      throw new LifeError('VALIDATION', `--${name} needs a value`);
    options[name] = next;
  }
  return { words, options };
}
const option = (options: Options, name: string): string | undefined =>
  typeof options[name] === 'string' ? (options[name] as string) : undefined;
const required = (options: Options, name: string): string =>
  text(option(options, name), `--${name}`);
const argument = (words: string[], index: number, name: string): string => text(words[index], name);
const assertOptions = (options: Options, allowed: string[]) => {
  for (const key of Object.keys(options))
    if (!['workspace', 'json', 'idempotency-key', ...allowed].includes(key))
      throw new LifeError('VALIDATION', `Unknown option: --${key}`);
};
const fingerprint = (words: string[], options: Options): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        words,
        options: Object.fromEntries(
          Object.entries(options)
            .filter(([key]) => !['workspace', 'json', 'idempotency-key'].includes(key))
            .sort(),
        ),
      }),
    )
    .digest('hex');
function output(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value));
    return;
  }
  if (typeof value === 'string') {
    console.log(value);
    return;
  }
  if (Array.isArray(value)) {
    if (!value.length) {
      console.log('(none)');
      return;
    }
    for (const item of value) {
      if (typeof item === 'object' && item !== null) {
        const row = item as Record<string, unknown>;
        console.log(
          [row.id, row.status ?? row.outcome ?? '', row.title ?? row.name ?? row.start_at ?? '']
            .filter(Boolean)
            .join('  '),
        );
      } else console.log(String(item));
    }
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}
function safeMarkdown(value: unknown): string {
  return String(value)
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/([`*_{}\[\]()#+.!|<>-])/g, '\\$1');
}
function renderView(view: ReturnType<typeof dateView>): string {
  const lines = [
    `# ${view.from === view.through ? view.from : `${view.from} to ${view.through}`} (${view.timezone})`,
    '',
    '## Sessions',
  ];
  lines.push(
    ...(view.sessions.length
      ? view.sessions.map(
          (row) =>
            `- ${localTime(String(row.start_at), view.timezone)} → ${localTime(String(row.end_at), view.timezone)}: ${safeMarkdown(row.task_title)} (${row.task_id})`,
        )
      : ['- None']),
  );
  lines.push(
    '',
    '## Commitments',
    ...(view.events.length
      ? view.events.map(
          (row) =>
            `- ${localTime(String(row.start_at), view.timezone)} → ${localTime(String(row.end_at), view.timezone)}: ${safeMarkdown(row.title)}`,
        )
      : ['- None']),
  );
  lines.push(
    '',
    '## Open tasks',
    ...(view.tasks.length
      ? view.tasks.map(
          (row) =>
            `- ${safeMarkdown(row.title)} (${row.id}, ${row.status}, ${row.ready ? 'ready' : `blocked by ${row.blocked_by.join(', ')}`})${row.due_at ? ` due ${row.due_at}` : ''}`,
        )
      : ['- None']),
  );
  lines.push(
    '',
    '## Habits',
    ...(view.habits.length
      ? view.habits.map((row) => `- ${safeMarkdown(row.name)} (${row.id})`)
      : ['- None']),
    '',
  );
  return lines.join('\n');
}

async function main(): Promise<void> {
  const { words, options } = parse(process.argv.slice(2));
  const [noun, verb] = words;
  if (!noun || noun === 'help' || options.help) {
    console.log(help);
    return;
  }
  const arity: Record<string, number> = {
    init: 1,
    restore: 1,
    doctor: 1,
    validate: 1,
    export: 1,
    backup: 1,
    today: 1,
    tomorrow: 1,
    week: 1,
    'goal add': 2,
    'goal list': 2,
    'goal show': 3,
    'goal update': 3,
    'project add': 2,
    'project list': 2,
    'project show': 3,
    'project update': 3,
    'task add': 2,
    'task list': 2,
    'task next': 2,
    'task show': 3,
    'task update': 3,
    'task done': 3,
    'task cancel': 3,
    'task depends': 5,
    'habit add': 2,
    'habit list': 2,
    'habit show': 3,
    'habit update': 3,
    'habit log': 3,
    'habit history': 3,
    'schedule add': 2,
    'schedule list': 2,
    'schedule move': 3,
    'schedule cancel': 3,
    'schedule record': 3,
    'calendar add': 2,
    'calendar list': 2,
    'calendar move': 3,
    'calendar cancel': 3,
    'decision add': 2,
    'decision list': 2,
    'decision show': 3,
    'review week': 2,
  };
  const expectedWords = arity[noun] ?? arity[`${noun} ${verb}`];
  if (expectedWords && words.length !== expectedWords)
    throw new LifeError(
      'VALIDATION',
      `Unexpected arguments for ${noun}${verb ? ` ${verb}` : ''}; run syntrop help`,
    );
  const json = Boolean(options.json),
    path = workspacePath(option(options, 'workspace'));
  if (noun === 'integration') {
    const context = openWorkspace(path);
    try {
      const { googleCommand } = await import('./google-cli.ts');
      output(await googleCommand(context, words, options), json);
    } catch (error) {
      if (error instanceof LifeError) throw error;
      const safe = error as {
        name?: string;
        code?: string;
        status?: number;
        reason?: string;
        message?: string;
      };
      if (safe.name === 'GoogleAuthError' || safe.name === 'GoogleApiError')
        throw new LifeError(safe.code ?? 'GOOGLE_API', safe.message ?? 'Google operation failed');
      throw new LifeError(
        'GOOGLE_INTEGRATION',
        'Google integration operation failed; inspect configuration and retry. No operational records were changed.',
      );
    } finally {
      context.db.close();
    }
    return;
  }
  if (noun === 'init') {
    assertOptions(options, ['timezone']);
    const defaultTimezone =
      typeof Intl !== 'undefined' && Intl.DateTimeFormat
        ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
        : 'UTC';
    output(init(path, option(options, 'timezone') ?? defaultTimezone), json);
    return;
  }
  if (noun === 'restore') {
    assertOptions(options, ['from', 'timezone']);
    if (!option(options, 'workspace'))
      throw new LifeError('VALIDATION', 'restore requires --workspace NEW_PATH');
    assertOutsideSource(path);
    const from = resolve(required(options, 'from'));
    if (!existsSync(join(from, 'config.json')) || !existsSync(databasePath(from)))
      throw new LifeError('NOT_FOUND', `Backup bundle is missing files: ${from}`);
    if (existsSync(path))
      throw new LifeError('CONFLICT', `Restore needs a new workspace path: ${path}`);
    const source = new DatabaseSync(databasePath(from), { readOnly: true });
    try {
      const integrity = source.prepare('PRAGMA integrity_check').get();
      if (
        integrity?.integrity_check !== 'ok' ||
        ![1, 2, 3].includes(Number(source.prepare('PRAGMA user_version').get()?.user_version))
      )
        throw new LifeError('VALIDATION', 'Backup is invalid or uses an unsupported schema');
      const savedConfig = JSON.parse(readFileSync(join(from, 'config.json'), 'utf8')) as {
        schema: number;
        timezone: string;
      };
      if (savedConfig.schema !== 1)
        throw new LifeError('VALIDATION', 'Backup config is unsupported');
      const timezone = checkTimezone(option(options, 'timezone') ?? savedConfig.timezone);
      mkdirSync(join(path, 'data'), { recursive: true, mode: 0o700 });
      chmodSync(path, 0o700);
      for (const entry of readdirSync(from))
        if (entry !== 'data' && entry !== 'config.json')
          cpSync(join(from, entry), join(path, entry), {
            recursive: true,
            errorOnExist: true,
            force: false,
          });
      writeFileSync(
        join(path, 'config.json'),
        JSON.stringify({ schema: 1, timezone }, null, 2) + '\n',
        { mode: 0o600, flag: 'wx' },
      );
      await backup(source, databasePath(path));
      chmodSync(databasePath(path), 0o600);
      output({ workspace: path, restored_from: from, timezone }, json);
    } finally {
      source.close();
    }
    return;
  }
  const context = openWorkspace(path),
    db = context.db;
  const run = <T>(fn: () => T): T =>
    mutate(db, option(options, 'idempotency-key'), fingerprint(words, options), fn);
  try {
    let result: unknown;
    switch (noun) {
      case 'doctor': {
        assertOptions(options, []);
        result = {
          node: process.version,
          workspace: path,
          timezone: context.config.timezone,
          ...validate(db),
        };
        if (!(result as { ok: boolean }).ok) process.exitCode = 4;
        break;
      }
      case 'validate': {
        assertOptions(options, []);
        result = validate(db);
        if (!(result as { ok: boolean }).ok) process.exitCode = 4;
        break;
      }
      case 'goal': {
        if (verb === 'add') {
          assertOptions(options, ['title']);
          result = run(() => {
            const key = id('goal'),
              at = now();
            db.prepare('INSERT INTO goals VALUES (?, ?, ?, ?, ?, 1)').run(
              key,
              required(options, 'title'),
              'active',
              at,
              at,
            );
            return get(db, 'goals', key);
          });
        } else if (verb === 'list') {
          assertOptions(options, []);
          result = rows(db, 'SELECT * FROM goals ORDER BY created_at');
        } else if (verb === 'show') {
          assertOptions(options, []);
          const key = argument(words, 2, 'goal ID');
          result = {
            ...get(db, 'goals', key),
            projects: rows(db, 'SELECT * FROM projects WHERE goal_id = ? ORDER BY created_at', key),
          };
        } else if (verb === 'update') {
          assertOptions(options, ['title', 'status', 'expected-version']);
          result = run(() => {
            const key = argument(words, 2, 'goal ID'),
              row = get(db, 'goals', key);
            assertVersion(row, option(options, 'expected-version'));
            db.prepare(
              'UPDATE goals SET title = ?, status = ?, updated_at = ?, version = version + 1 WHERE id = ?',
            ).run(
              option(options, 'title') ? required(options, 'title') : String(row.title),
              option(options, 'status')
                ? choice(
                    required(options, 'status'),
                    ['active', 'achieved', 'paused', 'cancelled'],
                    'status',
                  )
                : String(row.status),
              now(),
              key,
            );
            return get(db, 'goals', key);
          });
        } else throw new LifeError('VALIDATION', 'Use goal add|list|show|update');
        break;
      }
      case 'project': {
        if (verb === 'add') {
          assertOptions(options, ['title', 'goal', 'description']);
          result = run(() => {
            const key = id('prj'),
              at = now();
            db.prepare(
              'INSERT INTO projects(id, goal_id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
            ).run(
              key,
              maybeId(db, 'goals', option(options, 'goal')),
              required(options, 'title'),
              option(options, 'description') ?? '',
              'active',
              at,
              at,
            );
            return get(db, 'projects', key);
          });
        } else if (verb === 'list') {
          assertOptions(options, []);
          result = rows(db, 'SELECT * FROM projects ORDER BY created_at');
        } else if (verb === 'show') {
          assertOptions(options, []);
          const key = argument(words, 2, 'project ID');
          result = { ...get(db, 'projects', key), tasks: taskList(db, key) };
        } else if (verb === 'update') {
          assertOptions(options, [
            'title',
            'description',
            'status',
            'expected-version',
            'allow-open-tasks',
            'reason',
          ]);
          result = run(() => {
            const key = argument(words, 2, 'project ID'),
              row = get(db, 'projects', key);
            assertVersion(row, option(options, 'expected-version'));
            if (['done', 'cancelled'].includes(String(row.status)))
              throw new LifeError('CONFLICT', 'Completed and cancelled projects are historical');
            const title = option(options, 'title') ? required(options, 'title') : String(row.title);
            const status = option(options, 'status')
              ? choice(
                  required(options, 'status'),
                  ['active', 'paused', 'done', 'cancelled'],
                  'status',
                )
              : String(row.status);
            const openTasks = rows(
              db,
              "SELECT id FROM tasks WHERE project_id = ? AND status NOT IN ('done','cancelled')",
              key,
            );
            const override = Boolean(options['allow-open-tasks']);
            if (status !== 'done' && (override || option(options, 'reason')))
              throw new LifeError(
                'VALIDATION',
                'Completion override is only valid when finishing a project',
              );
            if (status === 'done' && openTasks.length && !override)
              throw new LifeError(
                'CONFLICT',
                'Finish or cancel open tasks before completing the project, or use --allow-open-tasks --reason',
              );
            if (status === 'done' && !openTasks.length && override)
              throw new LifeError('VALIDATION', 'No open tasks require a completion override');
            const reason = override ? required(options, 'reason') : null;
            if (!override && option(options, 'reason'))
              throw new LifeError('VALIDATION', '--reason requires --allow-open-tasks');
            db.prepare(
              'UPDATE projects SET title = ?, description = ?, status = ?, completion_override_reason = ?, updated_at = ?, version = version + 1 WHERE id = ?',
            ).run(
              title,
              option(options, 'description') ?? String(row.description),
              status,
              reason,
              now(),
              key,
            );
            const cancelledSessions =
              status === 'active'
                ? []
                : rows(
                    db,
                    `SELECT s.id FROM work_sessions s JOIN tasks t ON t.id = s.task_id
                   WHERE t.project_id = ? AND s.status = 'scheduled' AND s.end_at > ?`,
                    key,
                    now(),
                  ).map((item) => String(item.id));
            for (const sessionId of cancelledSessions) cancelSession(db, sessionId);
            return { ...get(db, 'projects', key), cancelled_sessions: cancelledSessions };
          });
        } else throw new LifeError('VALIDATION', 'Use project add|list|show|update');
        break;
      }
      case 'task': {
        if (verb === 'add') {
          assertOptions(options, [
            'title',
            'project',
            'description',
            'status',
            'priority',
            'due',
            'estimate',
            'depends-on',
          ]);
          result = run(() => {
            const key = id('tsk'),
              at = now();
            const project = maybeId(db, 'projects', option(options, 'project'));
            if (
              project &&
              ['done', 'cancelled'].includes(String(get(db, 'projects', project).status))
            )
              throw new LifeError(
                'CONFLICT',
                'Cannot add work to a completed or cancelled project',
              );
            db.prepare(
              'INSERT INTO tasks(id, project_id, title, description, status, priority, due_at, estimate_minutes, created_at, updated_at, completed_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
            ).run(
              key,
              project,
              required(options, 'title'),
              option(options, 'description') ?? '',
              choice(
                option(options, 'status') ?? 'inbox',
                ['inbox', 'todo', 'in_progress', 'waiting'],
                'status',
              ),
              option(options, 'priority')
                ? integer(option(options, 'priority'), 'priority', 1, 5)
                : 3,
              option(options, 'due') ? timestamp(required(options, 'due')) : null,
              option(options, 'estimate')
                ? integer(option(options, 'estimate'), 'estimate', 1)
                : null,
              at,
              at,
              null,
            );
            for (const prerequisite of option(options, 'depends-on')?.split(',') ?? [])
              addDependency(db, key, text(prerequisite, 'prerequisite ID'));
            return task(db, key);
          });
        } else if (verb === 'list') {
          assertOptions(options, ['project']);
          result = taskList(db, option(options, 'project'));
        } else if (verb === 'next') {
          assertOptions(options, []);
          result = taskList(db).find((row) => row.ready) ?? null;
        } else if (verb === 'show') {
          assertOptions(options, []);
          result = task(db, argument(words, 2, 'task ID'));
        } else if (verb === 'update' || verb === 'done' || verb === 'cancel') {
          assertOptions(options, [
            'title',
            'description',
            'status',
            'project',
            'priority',
            'due',
            'estimate',
            'expected-version',
            'allow-blocked',
            'reason',
          ]);
          result = run(() => {
            const key = argument(words, 2, 'task ID'),
              row = get(db, 'tasks', key);
            assertVersion(row, option(options, 'expected-version'));
            if (['done', 'cancelled'].includes(String(row.status)))
              throw new LifeError(
                'CONFLICT',
                'Completed and cancelled tasks are historical; create a new task',
              );
            const status =
              verb === 'done'
                ? 'done'
                : verb === 'cancel'
                  ? 'cancelled'
                  : option(options, 'status')
                    ? choice(
                        required(options, 'status'),
                        ['inbox', 'todo', 'in_progress', 'waiting', 'done', 'cancelled'],
                        'status',
                      )
                    : String(row.status);
            const blockedBy = task(db, key).blocked_by;
            const override = Boolean(options['allow-blocked']);
            if (status !== 'done' && (override || option(options, 'reason')))
              throw new LifeError(
                'VALIDATION',
                'Completion override is only valid when finishing a task',
              );
            if (status === 'done' && blockedBy.length && !override)
              throw new LifeError(
                'CONFLICT',
                'Finish prerequisites before completing this task, or use --allow-blocked --reason',
              );
            if (status === 'done' && !blockedBy.length && override)
              throw new LifeError(
                'VALIDATION',
                'No unfinished prerequisite requires a completion override',
              );
            const reason = override ? required(options, 'reason') : null;
            if (!override && option(options, 'reason'))
              throw new LifeError('VALIDATION', '--reason requires --allow-blocked');
            const project =
              option(options, 'project') === 'none'
                ? null
                : option(options, 'project')
                  ? maybeId(db, 'projects', option(options, 'project'))
                  : row.project_id;
            if (
              project &&
              ['done', 'cancelled'].includes(String(get(db, 'projects', String(project)).status)) &&
              project !== row.project_id
            )
              throw new LifeError(
                'CONFLICT',
                'Cannot move work into a completed or cancelled project',
              );
            const due =
              option(options, 'due') === 'none'
                ? null
                : option(options, 'due')
                  ? timestamp(required(options, 'due'))
                  : row.due_at;
            const estimate =
              option(options, 'estimate') === 'none'
                ? null
                : option(options, 'estimate')
                  ? integer(option(options, 'estimate'), 'estimate', 1)
                  : row.estimate_minutes;
            db.prepare(
              'UPDATE tasks SET project_id = ?, title = ?, description = ?, status = ?, priority = ?, due_at = ?, estimate_minutes = ?, updated_at = ?, completed_at = ?, completion_override_reason = ?, version = version + 1 WHERE id = ?',
            ).run(
              project ?? null,
              option(options, 'title') ? required(options, 'title') : String(row.title),
              option(options, 'description') ?? String(row.description),
              status,
              option(options, 'priority')
                ? integer(option(options, 'priority'), 'priority', 1, 5)
                : Number(row.priority),
              due ?? null,
              estimate ?? null,
              now(),
              status === 'done' ? now() : null,
              reason,
              key,
            );
            const cancelledSessions = ['done', 'cancelled'].includes(status)
              ? rows(
                  db,
                  `SELECT id FROM work_sessions WHERE task_id = ? AND status = 'scheduled' AND end_at > ?`,
                  key,
                  now(),
                ).map((row) => String(row.id))
              : [];
            for (const sessionId of cancelledSessions) cancelSession(db, sessionId);
            return { ...task(db, key), cancelled_sessions: cancelledSessions };
          });
        } else if (verb === 'depends') {
          assertOptions(options, []);
          const action = argument(words, 2, 'dependency action'),
            taskId = argument(words, 3, 'task ID'),
            prerequisite = argument(words, 4, 'prerequisite ID');
          if (action === 'add') result = run(() => addDependency(db, taskId, prerequisite));
          else if (action === 'remove')
            result = run(() => {
              const dependent = get(db, 'tasks', taskId);
              if (['done', 'cancelled'].includes(String(dependent.status)))
                throw new LifeError(
                  'CONFLICT',
                  'Dependencies of completed or cancelled tasks are historical',
                );
              db.prepare(
                'DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_id = ?',
              ).run(taskId, prerequisite);
              return task(db, taskId);
            });
          else throw new LifeError('VALIDATION', 'Use task depends add|remove TASK PREREQUISITE');
        } else
          throw new LifeError(
            'VALIDATION',
            'Use task add|list|next|show|update|done|cancel|depends',
          );
        break;
      }
      case 'habit': {
        if (verb === 'add') {
          assertOptions(options, ['name', 'frequency', 'target']);
          result = run(() => {
            const key = id('hab'),
              at = now();
            db.prepare('INSERT INTO habits VALUES (?, ?, ?, ?, 1, ?, ?, 1)').run(
              key,
              required(options, 'name'),
              choice(option(options, 'frequency') ?? 'daily', ['daily', 'weekly'], 'frequency'),
              option(options, 'target') ? integer(option(options, 'target'), 'target', 1) : 1,
              at,
              at,
            );
            return get(db, 'habits', key);
          });
        } else if (verb === 'list') {
          assertOptions(options, []);
          result = rows(db, 'SELECT * FROM habits ORDER BY name');
        } else if (verb === 'show') {
          assertOptions(options, []);
          result = get(db, 'habits', argument(words, 2, 'habit ID'));
        } else if (verb === 'log') {
          assertOptions(options, ['date', 'outcome', 'note', 'correct']);
          result = run(() =>
            logHabit(
              db,
              argument(words, 2, 'habit ID'),
              required(options, 'date'),
              required(options, 'outcome'),
              option(options, 'note'),
              Boolean(options.correct),
            ),
          );
        } else if (verb === 'history') {
          assertOptions(options, []);
          const key = argument(words, 2, 'habit ID');
          get(db, 'habits', key);
          result = rows(
            db,
            'SELECT * FROM habit_occurrences WHERE habit_id = ? ORDER BY occurrence_key',
            key,
          );
        } else if (verb === 'update') {
          assertOptions(options, ['name', 'frequency', 'target', 'active', 'expected-version']);
          result = run(() => {
            const key = argument(words, 2, 'habit ID'),
              row = get(db, 'habits', key);
            assertVersion(row, option(options, 'expected-version'));
            const active =
              option(options, 'active') === undefined
                ? Number(row.active)
                : choice(required(options, 'active'), ['yes', 'no'], 'active') === 'yes'
                  ? 1
                  : 0;
            db.prepare(
              'UPDATE habits SET name = ?, frequency = ?, target = ?, active = ?, updated_at = ?, version = version + 1 WHERE id = ?',
            ).run(
              option(options, 'name') ? required(options, 'name') : String(row.name),
              option(options, 'frequency')
                ? choice(required(options, 'frequency'), ['daily', 'weekly'], 'frequency')
                : String(row.frequency),
              option(options, 'target')
                ? integer(option(options, 'target'), 'target', 1)
                : Number(row.target),
              active,
              now(),
              key,
            );
            return get(db, 'habits', key);
          });
        } else throw new LifeError('VALIDATION', 'Use habit add|list|show|update|log|history');
        break;
      }
      case 'schedule':
      case 'calendar': {
        const table = noun === 'schedule' ? 'work_sessions' : 'calendar_events';
        if (verb === 'add') {
          assertOptions(
            options,
            noun === 'schedule'
              ? ['task', 'start', 'end', 'note']
              : ['title', 'start', 'end', 'note'],
          );
          result = run(() =>
            noun === 'schedule'
              ? addSession(
                  db,
                  required(options, 'task'),
                  required(options, 'start'),
                  required(options, 'end'),
                  option(options, 'note') ?? '',
                )
              : addEvent(
                  db,
                  required(options, 'title'),
                  required(options, 'start'),
                  required(options, 'end'),
                  option(options, 'note') ?? '',
                ),
          );
        } else if (verb === 'list') {
          assertOptions(options, []);
          result = rows(
            db,
            noun === 'schedule'
              ? `SELECT s.*, o.outcome, o.actual_minutes, o.note AS outcome_note, o.recorded_at,
                        o.version AS outcome_version FROM work_sessions s
                 LEFT JOIN session_outcomes o ON o.session_id = s.id ORDER BY s.start_at`
              : `SELECT * FROM ${table} ORDER BY start_at`,
          );
        } else if (verb === 'move') {
          assertOptions(options, ['start', 'end', 'expected-version']);
          result = run(() =>
            moveTime(
              db,
              table,
              argument(words, 2, `${noun} ID`),
              required(options, 'start'),
              required(options, 'end'),
              option(options, 'expected-version'),
            ),
          );
        } else if (noun === 'schedule' && verb === 'cancel') {
          assertOptions(options, ['expected-version']);
          result = run(() =>
            cancelSession(
              db,
              argument(words, 2, 'session ID'),
              option(options, 'expected-version'),
            ),
          );
        } else if (noun === 'schedule' && verb === 'record') {
          assertOptions(options, [
            'outcome',
            'actual-minutes',
            'note',
            'correct',
            'expected-version',
          ]);
          result = run(() =>
            recordSession(
              db,
              argument(words, 2, 'session ID'),
              required(options, 'outcome'),
              option(options, 'actual-minutes'),
              option(options, 'note'),
              Boolean(options.correct),
              option(options, 'expected-version'),
            ),
          );
        } else if (noun === 'calendar' && verb === 'cancel') {
          assertOptions(options, ['expected-version']);
          result = run(() =>
            cancelEvent(db, argument(words, 2, 'event ID'), option(options, 'expected-version')),
          );
        } else throw new LifeError('VALIDATION', `Use ${noun} add|list|move|cancel|record`);
        break;
      }
      case 'decision': {
        if (verb === 'add') {
          assertOptions(options, ['title', 'rationale', 'project', 'source-url']);
          result = run(() => {
            const key = id('dec');
            db.prepare('INSERT INTO decisions VALUES (?, ?, ?, ?, ?, ?)').run(
              key,
              maybeId(db, 'projects', option(options, 'project')),
              required(options, 'title'),
              required(options, 'rationale'),
              option(options, 'source-url') ?? null,
              now(),
            );
            return get(db, 'decisions', key);
          });
        } else if (verb === 'list') {
          assertOptions(options, ['project']);
          const project = option(options, 'project') ?? null;
          result = rows(
            db,
            'SELECT * FROM decisions WHERE (? IS NULL OR project_id = ?) ORDER BY decided_at DESC',
            project,
            project,
          );
        } else if (verb === 'show') {
          assertOptions(options, []);
          result = get(db, 'decisions', argument(words, 2, 'decision ID'));
        } else throw new LifeError('VALIDATION', 'Use decision add|list|show');
        break;
      }
      case 'today':
      case 'tomorrow':
      case 'week': {
        assertOptions(options, ['date', 'write']);
        const data = dateView(db, context.config.timezone, noun, option(options, 'date'));
        if (options.write) {
          const generated = join(path, 'views', 'generated');
          mkdirSync(generated, { recursive: true, mode: 0o700 });
          const file = join(generated, `${noun}.md`),
            temp = `${file}.tmp-${process.pid}`;
          writeFileSync(temp, renderView(data), { mode: 0o600 });
          renameSync(temp, file);
        }
        result = json ? data : renderView(data);
        break;
      }
      case 'review': {
        if (verb !== 'week') throw new LifeError('VALIDATION', 'Use review week');
        assertOptions(options, ['date']);
        result = weeklyReview(db, context.config.timezone, option(options, 'date'));
        break;
      }
      case 'export': {
        assertOptions(options, ['to']);
        result = {
          schema: 1,
          timezone: context.config.timezone,
          exported_at: now(),
          data: Object.fromEntries(
            [
              'goals',
              'projects',
              'tasks',
              'task_dependencies',
              'work_sessions',
              'session_outcomes',
              'calendar_events',
              'habits',
              'habit_occurrences',
              'decisions',
            ].map((table) => [table, rows(db, `SELECT * FROM ${table}`)]),
          ),
        };
        if (option(options, 'to')) {
          const file = resolve(required(options, 'to'));
          assertOutsideSource(file);
          mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
          writeFileSync(file, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
          result = { exported_to: file };
        }
        break;
      }
      case 'backup': {
        assertOptions(options, ['to']);
        const target = resolve(required(options, 'to'));
        assertOutsideSource(target);
        if (
          target === path ||
          target.startsWith(`${path}${sep}`) ||
          path.startsWith(`${target}${sep}`)
        )
          throw new LifeError('VALIDATION', 'Backup directory must be separate from the workspace');
        if (existsSync(target))
          throw new LifeError('CONFLICT', `Backup path already exists: ${target}`);
        const temp = `${target}.tmp-${process.pid}`;
        if (existsSync(temp))
          throw new LifeError('CONFLICT', `Temporary backup path already exists: ${temp}`);
        mkdirSync(join(temp, 'data'), { recursive: true, mode: 0o700 });
        for (const entry of readdirSync(path))
          if (entry !== 'data')
            cpSync(join(path, entry), join(temp, entry), {
              recursive: true,
              errorOnExist: true,
              force: false,
            });
        await backupDb(db, databasePath(temp));
        renameSync(temp, target);
        result = { backup: target };
        break;
      }
      default:
        throw new LifeError('VALIDATION', `Unknown command: ${noun}. Run life help`);
    }
    output(result, json);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  const code = error instanceof LifeError ? error.code : 'INTERNAL';
  const exit = ['VALIDATION', 'NOT_FOUND'].includes(code)
    ? 2
    : ['CONFLICT', 'CYCLE', 'SCHEDULE_CONFLICT', 'STALE_VERSION', 'IDEMPOTENCY_CONFLICT'].includes(
          code,
        )
      ? 3
      : 4;
  const json = process.argv.includes('--json');
  console.error(
    json
      ? JSON.stringify({ error: { code, message: error.message } })
      : `Error [${code}]: ${error.message}`,
  );
  process.exitCode = exit;
});
