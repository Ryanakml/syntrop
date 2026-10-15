import { DatabaseSync, backup } from 'node:sqlite';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  chmodSync,
  openSync,
  closeSync,
  unlinkSync,
  realpathSync,
} from 'node:fs';
import { resolve, join, dirname, basename, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export class LifeError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type Config = { schema: 1; timezone: string };
export type Context = { db: DatabaseSync; path: string; config: Config };
export const workspacePath = (value?: string) =>
  resolve(
    value ??
      process.env.SYNTROP_WORKSPACE ??
      process.env.LIFE_WORKSPACE ??
      join(homedir(), '.syntrop'),
  );
export const databasePath = (path: string) => join(path, 'data', 'life.db');
const sourceRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));

export function assertOutsideSource(path: string): void {
  let ancestor = resolve(path);
  const rest: string[] = [];
  while (!existsSync(ancestor)) {
    rest.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  const physicalPath = resolve(realpathSync(ancestor), ...rest);
  if (physicalPath === sourceRoot || physicalPath.startsWith(`${sourceRoot}${sep}`))
    throw new LifeError(
      'VALIDATION',
      'Private data path must be outside the Syntrop source repository',
    );
}

export function checkTimezone(value: string): string {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
    return value;
  } catch {
    throw new LifeError('VALIDATION', `Invalid IANA timezone: ${value}`);
  }
}

export function init(path: string, timezone: string): { workspace: string; timezone: string } {
  assertOutsideSource(path);
  if (existsSync(path) && readdirSync(path).length)
    throw new LifeError('CONFLICT', `Path is not empty: ${path}`);
  checkTimezone(timezone);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  for (const dir of [
    'data',
    'knowledge',
    'knowledge/goals',
    'knowledge/research',
    'knowledge/decisions',
    'journal',
    'views',
  ])
    mkdirSync(join(path, dir), { recursive: true, mode: 0o700 });
  const config: Config = { schema: 1, timezone };
  writeFileSync(join(path, 'config.json'), JSON.stringify(config, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  const db = openDb(databasePath(path));
  db.close();
  chmodSync(databasePath(path), 0o600);
  return { workspace: path, timezone };
}

const migration1 = `
CREATE TABLE goals (
 id TEXT PRIMARY KEY, title TEXT NOT NULL CHECK(length(trim(title)) > 0),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','achieved','paused','cancelled')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE TABLE projects (
 id TEXT PRIMARY KEY, goal_id TEXT REFERENCES goals(id) ON DELETE RESTRICT,
 title TEXT NOT NULL CHECK(length(trim(title)) > 0), description TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','done','cancelled')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE TABLE tasks (
 id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
 title TEXT NOT NULL CHECK(length(trim(title)) > 0), description TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'inbox' CHECK(status IN ('inbox','todo','in_progress','waiting','done','cancelled')),
 priority INTEGER NOT NULL DEFAULT 3 CHECK(priority BETWEEN 1 AND 5),
 due_at TEXT, estimate_minutes INTEGER CHECK(estimate_minutes > 0),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT, version INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE TABLE task_dependencies (
 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
 PRIMARY KEY(task_id, depends_on_id), CHECK(task_id <> depends_on_id)
) STRICT;
CREATE TABLE work_sessions (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
 start_at TEXT NOT NULL, end_at TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','cancelled')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
 CHECK(end_at > start_at)
) STRICT;
CREATE TABLE calendar_events (
 id TEXT PRIMARY KEY, title TEXT NOT NULL CHECK(length(trim(title)) > 0),
 start_at TEXT NOT NULL, end_at TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
 CHECK(end_at > start_at)
) STRICT;
CREATE TABLE habits (
 id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(trim(name)) > 0),
 frequency TEXT NOT NULL DEFAULT 'daily' CHECK(frequency IN ('daily','weekly')),
 target INTEGER NOT NULL DEFAULT 1 CHECK(target > 0), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE TABLE habit_occurrences (
 id TEXT PRIMARY KEY, habit_id TEXT NOT NULL REFERENCES habits(id) ON DELETE RESTRICT,
 occurrence_key TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('completed','skipped')),
 note TEXT NOT NULL DEFAULT '', recorded_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
 UNIQUE(habit_id, occurrence_key)
) STRICT;
CREATE TABLE decisions (
 id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
 title TEXT NOT NULL CHECK(length(trim(title)) > 0), rationale TEXT NOT NULL CHECK(length(trim(rationale)) > 0),
 source_url TEXT, decided_at TEXT NOT NULL
) STRICT;
CREATE TABLE operations (key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
CREATE INDEX tasks_project ON tasks(project_id);
CREATE INDEX tasks_due ON tasks(due_at);
CREATE INDEX task_deps_parent ON task_dependencies(depends_on_id);
CREATE INDEX work_sessions_start ON work_sessions(start_at, end_at);
CREATE INDEX events_start ON calendar_events(start_at, end_at);
CREATE INDEX habit_occurrences_habit ON habit_occurrences(habit_id, occurrence_key);
PRAGMA user_version = 1;
`;

const migration2 = `
ALTER TABLE tasks ADD COLUMN completion_override_reason TEXT;
ALTER TABLE projects ADD COLUMN completion_override_reason TEXT;
ALTER TABLE calendar_events ADD COLUMN status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','cancelled'));
PRAGMA user_version = 2;
`;

const migration3 = `
CREATE TABLE session_outcomes (
 session_id TEXT PRIMARY KEY REFERENCES work_sessions(id) ON DELETE RESTRICT,
 outcome TEXT NOT NULL CHECK(outcome IN ('completed','skipped')),
 actual_minutes INTEGER NOT NULL CHECK(actual_minutes >= 0),
 note TEXT NOT NULL DEFAULT '', recorded_at TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1,
 CHECK((outcome = 'completed' AND actual_minutes > 0) OR (outcome = 'skipped' AND actual_minutes = 0))
) STRICT;
PRAGMA user_version = 3;
`;

export function openDb(file: string, readOnly = false): DatabaseSync {
  const db = new DatabaseSync(file, { readOnly });
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000');
  if (!readOnly) {
    db.exec('PRAGMA journal_mode = WAL');
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
    if (version > 3) {
      db.close();
      throw new LifeError('SCHEMA', 'Workspace schema is newer than this Syntrop version');
    }
    if (version < 3) {
      if (version > 0) {
        const backupDirectory = join(dirname(file), 'migration-backups');
        const backupFile = join(backupDirectory, `life-v${version}-${randomUUID()}.db`);
        try {
          mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
          chmodSync(backupDirectory, 0o700);
          db.prepare('VACUUM INTO ?').run(backupFile);
          chmodSync(backupFile, 0o600);
        } catch (error) {
          if (existsSync(backupFile)) unlinkSync(backupFile);
          db.close();
          throw error;
        }
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        if (version === 0) db.exec(migration1);
        if (version < 2) db.exec(migration2);
        db.exec(migration3);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        db.close();
        throw error;
      }
    }
  }
  return db;
}

export function openWorkspace(path: string): Context {
  assertOutsideSource(path);
  let config: Config;
  try {
    config = JSON.parse(readFileSync(join(path, 'config.json'), 'utf8')) as Config;
  } catch {
    throw new LifeError('WORKSPACE', `No valid workspace at ${path}; run syntrop init`);
  }
  if (config.schema !== 1) throw new LifeError('WORKSPACE', 'Unsupported workspace config schema');
  checkTimezone(config.timezone);
  if (!existsSync(databasePath(path)))
    throw new LifeError('WORKSPACE', 'Workspace database is missing');
  return { db: openDb(databasePath(path)), path, config };
}

export function mutate<T>(
  db: DatabaseSync,
  key: string | undefined,
  requestHash: string,
  operation: () => T,
): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (key) {
      const existing = db
        .prepare('SELECT request_hash, result_json FROM operations WHERE key = ?')
        .get(key);
      if (existing) {
        if (existing.request_hash !== requestHash)
          throw new LifeError(
            'IDEMPOTENCY_CONFLICT',
            'Idempotency key was used for a different operation',
          );
        db.exec('COMMIT');
        return JSON.parse(String(existing.result_json)) as T;
      }
    }
    const result = operation();
    if (key)
      db.prepare('INSERT INTO operations VALUES (?, ?, ?, ?)').run(
        key,
        requestHash,
        JSON.stringify(result),
        new Date().toISOString(),
      );
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export async function backupDb(db: DatabaseSync, target: string): Promise<string> {
  const path = resolve(target);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, 'wx', 0o600);
  closeSync(fd);
  try {
    await backup(db, path);
    chmodSync(path, 0o600);
    return path;
  } catch (error) {
    unlinkSync(path);
    throw error;
  }
}
