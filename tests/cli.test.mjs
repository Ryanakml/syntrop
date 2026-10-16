import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const cli = resolve('src/cli.ts');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'syntrop-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'private');
  function call(...args) {
    const process = spawnSync(
      globalThis.process.execPath,
      [cli, '--workspace', workspace, '--json', ...args],
      { encoding: 'utf8' },
    );
    return {
      status: process.status,
      value: process.stdout.trim() ? JSON.parse(process.stdout) : null,
      error: process.stderr.trim() ? JSON.parse(process.stderr) : null,
    };
  }
  function ok(...args) {
    const result = call(...args);
    assert.equal(result.status, 0, JSON.stringify(result));
    return result.value;
  }
  function fails(code, ...args) {
    const result = call(...args);
    assert.notEqual(result.status, 0, JSON.stringify(result));
    assert.equal(result.error?.error?.code, code, JSON.stringify(result));
    return result;
  }
  ok('init', '--timezone', 'Asia/Jakarta');
  return { root, workspace, call, ok, fails };
}

test('end-to-end private workspace and persisted CLI state', (t) => {
  const { root, workspace, ok } = fixture(t);
  const project = ok('project', 'add', '--title', 'Improve engineering');
  const task = ok(
    'task',
    'add',
    '--project',
    project.id,
    '--title',
    'Contribute upstream',
    '--status',
    'todo',
  );
  const session = ok(
    'schedule',
    'add',
    '--task',
    task.id,
    '--start',
    '2026-10-15T09:00+07:00',
    '--end',
    '2026-10-15T10:00+07:00',
  );
  const habit = ok('habit', 'add', '--name', 'Read');
  ok('habit', 'log', habit.id, '--date', '2026-10-15', '--outcome', 'completed');
  assert.equal(ok('task', 'show', task.id).title, 'Contribute upstream');
  const today = ok('today', '--date', '2026-10-15');
  assert.equal(today.sessions[0].id, session.id);
  assert.equal(today.tasks[0].id, task.id);
  assert.equal(today.habits[0].occurrences[0].outcome, 'completed');
  writeFileSync(join(workspace, 'views', 'today.md'), 'handwritten\n');
  ok('today', '--date', '2026-10-15', '--write');
  assert.match(
    readFileSync(join(workspace, 'views', 'generated', 'today.md'), 'utf8'),
    /Contribute upstream/,
  );
  assert.match(
    readFileSync(join(workspace, 'views', 'generated', 'today.md'), 'utf8'),
    /2026-10-15 09:00/,
  );
  assert.equal(readFileSync(join(workspace, 'views', 'today.md'), 'utf8'), 'handwritten\n');
  assert.equal(ok('validate').ok, true);
  const exported = ok('export');
  assert.equal(exported.data.tasks[0].id, task.id);
  assert.ok(!workspace.startsWith(resolve('.')));
  assert.ok(!readdirSync(resolve('.')).includes('my-life'));
  assert.equal(statSync(join(workspace, 'config.json')).mode & 0o777, 0o600);
  assert.equal(statSync(join(workspace, 'data', 'life.db')).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, 'private')).mode & 0o777, 0o700);
});

test('dependency readiness, cycle rejection, rollback, idempotency and stale versions', (t) => {
  const { ok, fails } = fixture(t);
  const first = ok('task', 'add', '--title', 'First', '--status', 'todo');
  const second = ok(
    'task',
    'add',
    '--title',
    'Second',
    '--status',
    'todo',
    '--depends-on',
    first.id,
  );
  assert.deepEqual(second.blocked_by, [first.id]);
  assert.equal(second.ready, false);
  fails('CYCLE', 'task', 'depends', 'add', first.id, second.id);
  assert.equal(ok('task', 'show', first.id).ready, true);
  ok('task', 'done', first.id);
  assert.equal(ok('task', 'show', second.id).ready, true);
  assert.equal(ok('task', 'next').id, second.id);
  const before = ok('task', 'list').length;
  fails('NOT_FOUND', 'task', 'add', '--title', 'Must rollback', '--depends-on', 'tsk_missing');
  assert.equal(ok('task', 'list').length, before);
  const once = ok('task', 'add', '--title', 'Exactly once', '--idempotency-key', 'create-one');
  const again = ok('task', 'add', '--title', 'Exactly once', '--idempotency-key', 'create-one');
  assert.deepEqual(once, again);
  assert.equal(ok('task', 'list').filter((row) => row.title === 'Exactly once').length, 1);
  fails(
    'IDEMPOTENCY_CONFLICT',
    'task',
    'add',
    '--title',
    'Different',
    '--idempotency-key',
    'create-one',
  );
  fails('STALE_VERSION', 'task', 'update', once.id, '--title', 'Wrong', '--expected-version', '2');
  assert.equal(ok('task', 'show', once.id).title, 'Exactly once');
});

test('schedule conflict and rescheduling keep deadlines separate', (t) => {
  const { ok, fails } = fixture(t);
  const item = ok('task', 'add', '--title', 'Write', '--due', '2026-10-18T17:00+07:00');
  const session = ok(
    'schedule',
    'add',
    '--task',
    item.id,
    '--start',
    '2026-10-15T09:00+07:00',
    '--end',
    '2026-10-15T10:00+07:00',
  );
  fails(
    'SCHEDULE_CONFLICT',
    'calendar',
    'add',
    '--title',
    'Meeting',
    '--start',
    '2026-10-15T09:30+07:00',
    '--end',
    '2026-10-15T10:30+07:00',
  );
  const event = ok(
    'calendar',
    'add',
    '--title',
    'Meeting',
    '--start',
    '2026-10-15T11:00+07:00',
    '--end',
    '2026-10-15T12:00+07:00',
  );
  fails(
    'SCHEDULE_CONFLICT',
    'schedule',
    'move',
    session.id,
    '--start',
    '2026-10-15T11:15+07:00',
    '--end',
    '2026-10-15T12:15+07:00',
  );
  assert.equal(ok('schedule', 'list')[0].start_at, session.start_at);
  ok(
    'schedule',
    'move',
    session.id,
    '--start',
    '2026-10-16T09:00+07:00',
    '--end',
    '2026-10-16T10:00+07:00',
  );
  assert.equal(ok('task', 'show', item.id).due_at, '2026-10-18T10:00:00.000Z');
  assert.equal(ok('week', '--date', '2026-10-15').sessions.length, 1);
  assert.equal(ok('today', '--date', '2026-10-15').events[0].id, event.id);
});

test('finishing a task cancels its future sessions but preserves session history', (t) => {
  const { ok } = fixture(t);
  const item = ok('task', 'add', '--title', 'Finish early');
  const start = new Date(Date.now() + 3_600_000).toISOString();
  const end = new Date(Date.now() + 7_200_000).toISOString();
  const session = ok('schedule', 'add', '--task', item.id, '--start', start, '--end', end);
  const done = ok('task', 'done', item.id);
  assert.deepEqual(done.cancelled_sessions, [session.id]);
  assert.equal(ok('schedule', 'list')[0].status, 'cancelled');
  assert.equal(
    ok('calendar', 'add', '--title', 'Use released slot', '--start', start, '--end', end).title,
    'Use released slot',
  );
});

test('habit corrections preserve one occurrence and absent dates stay unrecorded', (t) => {
  const { ok, fails } = fixture(t);
  const habit = ok('habit', 'add', '--name', 'Exercise');
  ok('habit', 'log', habit.id, '--date', '2026-10-15', '--outcome', 'skipped');
  fails('CONFLICT', 'habit', 'log', habit.id, '--date', '2026-10-15', '--outcome', 'completed');
  const corrected = ok(
    'habit',
    'log',
    habit.id,
    '--date',
    '2026-10-15',
    '--outcome',
    'completed',
    '--correct',
  );
  assert.equal(corrected.version, 2);
  assert.equal(ok('habit', 'history', habit.id).length, 1);
  assert.equal(ok('habit', 'history', habit.id)[0].outcome, 'completed');
  assert.equal(ok('week', '--date', '2026-10-15').habits[0].occurrences.length, 1);
});

test('backup restores database and handwritten context into a new workspace; CLI errors are structured', (t) => {
  const { root, ok, fails } = fixture(t);
  ok('project', 'add', '--title', 'Recovery test');
  const task = ok('task', 'add', '--title', 'Recover outcome');
  const session = ok(
    'schedule',
    'add',
    '--task',
    task.id,
    '--start',
    '2020-10-12T09:00+07:00',
    '--end',
    '2020-10-12T10:00+07:00',
  );
  ok('schedule', 'record', session.id, '--outcome', 'completed', '--actual-minutes', '40');
  const privateNote = join(root, 'private', 'knowledge', 'research', 'note.md');
  writeFileSync(privateNote, '# Evidence\n');
  const file = join(root, 'safe-backup');
  ok('backup', '--to', file);
  const restored = join(root, 'restored');
  const result = spawnSync(
    process.execPath,
    [cli, '--workspace', restored, '--json', 'restore', '--from', file],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const check = spawnSync(
    process.execPath,
    [cli, '--workspace', restored, '--json', 'project', 'list'],
    { encoding: 'utf8' },
  );
  assert.equal(check.status, 0, check.stderr);
  assert.equal(JSON.parse(check.stdout)[0].title, 'Recovery test');
  const restoredReview = spawnSync(
    process.execPath,
    [cli, '--workspace', restored, '--json', 'review', 'week', '--date', '2020-10-12'],
    { encoding: 'utf8' },
  );
  assert.equal(restoredReview.status, 0, restoredReview.stderr);
  assert.equal(JSON.parse(restoredReview.stdout).summary.recorded_actual_minutes, 40);
  assert.equal(
    readFileSync(join(restored, 'knowledge', 'research', 'note.md'), 'utf8'),
    '# Evidence\n',
  );
  fails('VALIDATION', 'task', 'add', '--title', 'Invalid', '--priority', '9');
  fails('NOT_FOUND', 'task', 'show', 'tsk_missing');
});

test('completion enforces dependencies and open tasks, while justified overrides remain valid history', (t) => {
  const { ok, fails } = fixture(t);
  const project = ok('project', 'add', '--title', 'Contribution');
  const prerequisite = ok('task', 'add', '--project', project.id, '--title', 'Investigate');
  const dependent = ok(
    'task',
    'add',
    '--project',
    project.id,
    '--title',
    'Implement',
    '--depends-on',
    prerequisite.id,
  );
  const start = new Date(Date.now() + 3_600_000).toISOString();
  const end = new Date(Date.now() + 7_200_000).toISOString();
  const session = ok('schedule', 'add', '--task', prerequisite.id, '--start', start, '--end', end);
  fails('CONFLICT', 'task', 'done', dependent.id);
  fails('VALIDATION', 'task', 'done', dependent.id, '--allow-blocked');
  const exceptional = ok(
    'task',
    'done',
    dependent.id,
    '--allow-blocked',
    '--reason',
    'Work was completed through a separate upstream patch',
  );
  assert.equal(exceptional.status, 'done');
  assert.match(exceptional.completion_override_reason, /upstream patch/);
  fails('CONFLICT', 'task', 'depends', 'add', dependent.id, prerequisite.id);
  fails('CONFLICT', 'project', 'update', project.id, '--status', 'done');
  fails('VALIDATION', 'project', 'update', project.id, '--status', 'done', '--allow-open-tasks');
  const completed = ok(
    'project',
    'update',
    project.id,
    '--status',
    'done',
    '--allow-open-tasks',
    '--reason',
    'Remaining investigation was superseded',
  );
  assert.match(completed.completion_override_reason, /superseded/);
  assert.deepEqual(completed.cancelled_sessions, [session.id]);
  assert.equal(ok('task', 'show', prerequisite.id).ready, false);
  assert.equal(ok('schedule', 'list')[0].status, 'cancelled');
  fails('CONFLICT', 'task', 'add', '--project', project.id, '--title', 'Too late');
  assert.equal(ok('validate').ok, true);
});

test('normal completion and cancellation preserve task history; validation catches bypassed lifecycle rules', (t) => {
  const { workspace, ok, call, fails } = fixture(t);
  const normal = ok('project', 'add', '--title', 'Normal completion');
  const finished = ok('task', 'add', '--project', normal.id, '--title', 'Delivered');
  const abandoned = ok('task', 'add', '--project', normal.id, '--title', 'No longer needed');
  ok('task', 'done', finished.id);
  ok('task', 'cancel', abandoned.id);
  fails(
    'CONFLICT',
    'task',
    'add',
    '--title',
    'Impossible dependency',
    '--depends-on',
    abandoned.id,
  );
  assert.equal(ok('project', 'update', normal.id, '--status', 'done').status, 'done');
  const cancelled = ok('project', 'add', '--title', 'Archived');
  const retained = ok('task', 'add', '--project', cancelled.id, '--title', 'Retained history');
  assert.equal(ok('project', 'update', cancelled.id, '--status', 'cancelled').status, 'cancelled');
  assert.equal(ok('task', 'show', retained.id).status, 'inbox');
  assert.equal(ok('task', 'show', retained.id).ready, false);
  fails(
    'CONFLICT',
    'schedule',
    'add',
    '--task',
    retained.id,
    '--start',
    new Date(Date.now() + 3_600_000).toISOString(),
    '--end',
    new Date(Date.now() + 7_200_000).toISOString(),
  );
  assert.equal(ok('validate').ok, true);

  const broken = ok('project', 'add', '--title', 'Corrupted state');
  const first = ok('task', 'add', '--project', broken.id, '--title', 'Prerequisite');
  const second = ok(
    'task',
    'add',
    '--project',
    broken.id,
    '--title',
    'Dependent',
    '--depends-on',
    first.id,
  );
  const db = new DatabaseSync(join(workspace, 'data', 'life.db'));
  db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(second.id);
  db.prepare("UPDATE projects SET status = 'done' WHERE id = ?").run(broken.id);
  db.close();
  const check = call('validate');
  assert.equal(check.status, 4);
  assert.ok(check.value.issues.some((issue) => issue.includes('unfinished prerequisite')));
  assert.ok(check.value.issues.some((issue) => issue.includes('open tasks')));
});

test('calendar cancellation preserves the event and releases its time', (t) => {
  const { ok, fails } = fixture(t);
  const task = ok('task', 'add', '--title', 'Use freed slot');
  const event = ok(
    'calendar',
    'add',
    '--title',
    'Meeting',
    '--start',
    '2030-10-16T09:00+07:00',
    '--end',
    '2030-10-16T10:00+07:00',
  );
  fails(
    'SCHEDULE_CONFLICT',
    'schedule',
    'add',
    '--task',
    task.id,
    '--start',
    '2030-10-16T09:00+07:00',
    '--end',
    '2030-10-16T10:00+07:00',
  );
  fails('STALE_VERSION', 'calendar', 'cancel', event.id, '--expected-version', '2');
  const cancelled = ok('calendar', 'cancel', event.id, '--expected-version', '1');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.version, 2);
  assert.equal(ok('calendar', 'list')[0].id, event.id);
  assert.equal(ok('today', '--date', '2030-10-16').events.length, 0);
  fails(
    'CONFLICT',
    'calendar',
    'move',
    event.id,
    '--start',
    '2030-10-16T11:00+07:00',
    '--end',
    '2030-10-16T12:00+07:00',
  );
  fails('CONFLICT', 'calendar', 'cancel', event.id);
  assert.equal(
    ok(
      'schedule',
      'add',
      '--task',
      task.id,
      '--start',
      '2030-10-16T09:00+07:00',
      '--end',
      '2030-10-16T10:00+07:00',
    ).task_id,
    task.id,
  );
  assert.equal(ok('validate').ok, true);
});

test('generated Markdown keeps untrusted titles on their own list lines', (t) => {
  const { workspace, ok } = fixture(t);
  const title = 'Review issue\n## Fake priority **urgent** <script>';
  const task = ok('task', 'add', '--title', title, '--due', '2030-10-17T17:00+07:00');
  ok(
    'schedule',
    'add',
    '--task',
    task.id,
    '--start',
    '2030-10-17T09:00+07:00',
    '--end',
    '2030-10-17T10:00+07:00',
  );
  ok(
    'calendar',
    'add',
    '--title',
    'Meeting\n# Fake heading',
    '--start',
    '2030-10-17T11:00+07:00',
    '--end',
    '2030-10-17T12:00+07:00',
  );
  ok('habit', 'add', '--name', 'Read\n## Fake habit');
  ok('today', '--date', '2030-10-17', '--write');
  const view = readFileSync(join(workspace, 'views', 'generated', 'today.md'), 'utf8');
  assert.equal(view.split('\n').filter((line) => line.startsWith('# ')).length, 1);
  assert.equal(view.split('\n').filter((line) => line.startsWith('## ')).length, 4);
  assert.ok(!view.includes('<script>'));
  assert.match(view, /Review issue \\#\\# Fake priority/);
  assert.match(view, /Meeting \\# Fake heading/);
  assert.match(view, /Read \\#\\# Fake habit/);
});

test('source checkout rejects private workspace, export, and backup paths', (t) => {
  const { ok, fails } = fixture(t);
  const repoWorkspace = resolve('audit-private-workspace-should-not-exist');
  const attempt = spawnSync(
    process.execPath,
    [cli, '--workspace', repoWorkspace, '--json', 'init'],
    { encoding: 'utf8' },
  );
  assert.equal(attempt.status, 2);
  assert.equal(JSON.parse(attempt.stderr).error.code, 'VALIDATION');
  assert.equal(existsSync(repoWorkspace), false);
  fails('VALIDATION', 'export', '--to', resolve('personal-export.json'));
  fails('VALIDATION', 'backup', '--to', resolve('personal-backup'));
  const restore = spawnSync(
    process.execPath,
    [cli, '--workspace', repoWorkspace, '--json', 'restore', '--from', resolve('missing-backup')],
    { encoding: 'utf8' },
  );
  assert.equal(restore.status, 2);
  assert.equal(JSON.parse(restore.stderr).error.code, 'VALIDATION');
  assert.equal(ok('validate').ok, true);
});

test('v1 workspace migrates without losing records', (t) => {
  const { workspace, ok } = fixture(t);
  const project = ok('project', 'add', '--title', 'Existing project');
  const event = ok(
    'calendar',
    'add',
    '--title',
    'Existing event',
    '--start',
    '2030-10-18T09:00+07:00',
    '--end',
    '2030-10-18T10:00+07:00',
  );
  const db = new DatabaseSync(join(workspace, 'data', 'life.db'));
  db.exec('DROP TABLE session_outcomes');
  db.exec('ALTER TABLE tasks DROP COLUMN completion_override_reason');
  db.exec('ALTER TABLE projects DROP COLUMN completion_override_reason');
  db.exec('ALTER TABLE calendar_events DROP COLUMN status');
  db.exec('PRAGMA user_version = 1');
  db.close();
  assert.equal(ok('project', 'show', project.id).title, 'Existing project');
  assert.equal(ok('calendar', 'list')[0].id, event.id);
  assert.equal(ok('calendar', 'list')[0].status, 'scheduled');
  const migrated = new DatabaseSync(join(workspace, 'data', 'life.db'), { readOnly: true });
  assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 3);
  migrated.close();
  const backups = readdirSync(join(workspace, 'data', 'migration-backups'));
  assert.equal(backups.length, 1);
  const beforeMigration = new DatabaseSync(
    join(workspace, 'data', 'migration-backups', backups[0]),
    {
      readOnly: true,
    },
  );
  assert.equal(beforeMigration.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(
    beforeMigration.prepare('SELECT title FROM projects WHERE id = ?').get(project.id).title,
    'Existing project',
  );
  beforeMigration.close();
  assert.equal(ok('validate').ok, true);
});

test('session outcomes retain evidence and weekly review separates unknown from skipped', (t) => {
  const { ok, fails } = fixture(t);
  const task = ok('task', 'add', '--title', 'Triage open source issue');
  const completed = ok(
    'schedule',
    'add',
    '--task',
    task.id,
    '--start',
    '2020-10-12T09:00+07:00',
    '--end',
    '2020-10-12T10:00+07:00',
  );
  const unknown = ok(
    'schedule',
    'add',
    '--task',
    task.id,
    '--start',
    '2020-10-13T09:00+07:00',
    '--end',
    '2020-10-13T10:00+07:00',
  );
  const skipped = ok(
    'schedule',
    'add',
    '--task',
    task.id,
    '--start',
    '2020-10-14T09:00+07:00',
    '--end',
    '2020-10-14T10:00+07:00',
  );
  const cancelled = ok(
    'schedule',
    'add',
    '--task',
    task.id,
    '--start',
    '2020-10-15T09:00+07:00',
    '--end',
    '2020-10-15T10:00+07:00',
  );
  ok('schedule', 'cancel', cancelled.id);
  fails(
    'CONFLICT',
    'schedule',
    'record',
    cancelled.id,
    '--outcome',
    'skipped',
    '--actual-minutes',
    '0',
  );
  fails(
    'VALIDATION',
    'schedule',
    'record',
    completed.id,
    '--outcome',
    'completed',
    '--actual-minutes',
    '0',
  );
  const recorded = ok(
    'schedule',
    'record',
    completed.id,
    '--outcome',
    'completed',
    '--actual-minutes',
    '45',
    '--note',
    'Found reproduction',
  );
  assert.equal(recorded.version, 1);
  fails(
    'CONFLICT',
    'schedule',
    'record',
    completed.id,
    '--outcome',
    'completed',
    '--actual-minutes',
    '45',
  );
  fails(
    'STALE_VERSION',
    'schedule',
    'record',
    completed.id,
    '--outcome',
    'completed',
    '--actual-minutes',
    '50',
    '--correct',
    '--expected-version',
    '2',
  );
  assert.equal(
    ok(
      'schedule',
      'record',
      completed.id,
      '--outcome',
      'completed',
      '--actual-minutes',
      '50',
      '--correct',
      '--expected-version',
      '1',
    ).version,
    2,
  );
  fails('CONFLICT', 'schedule', 'cancel', completed.id);
  fails(
    'CONFLICT',
    'schedule',
    'move',
    completed.id,
    '--start',
    '2020-10-16T09:00+07:00',
    '--end',
    '2020-10-16T10:00+07:00',
  );
  ok('schedule', 'record', skipped.id, '--outcome', 'skipped', '--actual-minutes', '0');
  const review = ok('review', 'week', '--date', '2020-10-14');
  assert.deepEqual(review.summary, {
    scheduled: 3,
    completed: 1,
    skipped: 1,
    unrecorded: 1,
    pending: 0,
    in_progress: 0,
    cancelled: 1,
    planned_minutes: 180,
    recorded_actual_minutes: 50,
  });
  assert.equal(review.sessions.find((row) => row.id === unknown.id).evidence, 'unrecorded');
  assert.equal(
    review.sessions.find((row) => row.id === completed.id).outcome_note,
    'Found reproduction',
  );
  assert.equal(ok('schedule', 'list').find((row) => row.id === completed.id).actual_minutes, 50);
  assert.equal(ok('export').data.session_outcomes.length, 2);
  const future = ok(
    'schedule',
    'add',
    '--task',
    task.id,
    '--start',
    '2030-10-14T09:00+07:00',
    '--end',
    '2030-10-14T10:00+07:00',
  );
  fails(
    'CONFLICT',
    'schedule',
    'record',
    future.id,
    '--outcome',
    'completed',
    '--actual-minutes',
    '60',
  );
  const futureReview = ok('review', 'week', '--date', '2030-10-14');
  assert.equal(futureReview.sessions[0].evidence, 'pending');
  assert.equal(futureReview.summary.unrecorded, 0);
  assert.equal(futureReview.summary.pending, 1);
  ok(
    'schedule',
    'move',
    future.id,
    '--start',
    '2030-10-15T09:00+07:00',
    '--end',
    '2030-10-15T10:00+07:00',
    '--expected-version',
    '1',
  );
  ok(
    'calendar',
    'add',
    '--title',
    'New commitment',
    '--start',
    '2030-10-14T09:00+07:00',
    '--end',
    '2030-10-14T10:00+07:00',
  );
  const replanned = ok('review', 'week', '--date', '2030-10-14');
  assert.equal(replanned.sessions[0].version, 2);
  assert.equal(replanned.events[0].title, 'New commitment');
  assert.equal(ok('validate').ok, true);
});

test('v2 workspace migration preserves records and keeps a v2 backup', (t) => {
  const { workspace, ok } = fixture(t);
  const task = ok('task', 'add', '--title', 'Existing task');
  const db = new DatabaseSync(join(workspace, 'data', 'life.db'));
  db.exec('DROP TABLE session_outcomes; PRAGMA user_version = 2');
  db.close();
  assert.equal(ok('task', 'show', task.id).title, 'Existing task');
  const backups = readdirSync(join(workspace, 'data', 'migration-backups'));
  assert.equal(backups.length, 1);
  const old = new DatabaseSync(join(workspace, 'data', 'migration-backups', backups[0]), {
    readOnly: true,
  });
  assert.equal(old.prepare('PRAGMA user_version').get().user_version, 2);
  old.close();
  assert.equal(ok('validate').counts.session_outcomes, 0);
});
