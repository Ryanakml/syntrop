import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { init, openWorkspace } from '../src/db.ts';
import { addDependency, addSession, get, id, now, rows } from '../src/core.ts';
import {
  desiredCalendarLabels,
  eventFingerprint,
  labelIdentity,
  nearestColorId,
  projectEvents,
  validatePresentation,
} from '../src/google-projection.ts';
import { applySync, mergeCalendarLabels, planSync } from '../src/google-sync.ts';
import {
  applyReconcile,
  applyTasksSync,
  ownedTask,
  parseTaskOwnership,
  planReconcile,
  planTasksSync,
  projectTasks,
  taskFingerprint,
} from '../src/google-tasks.ts';
import { getAccessToken, writePrivate } from '../src/google-auth.ts';
import { GoogleClient } from '../src/google-client.ts';

const clone = structuredClone;
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

class FakeGoogleV4 {
  calendars = new Map();
  calendarMeta = new Map();
  taskLists = new Map();
  calls = [];
  serial = 0;
  uncertainTaskPost = false;
  failTaskPost = false;
  supportCustomLabels = true;
  colors = { 1: {}, 2: {}, 3: {}, 5: {}, 7: {}, 8: {}, 9: {}, 10: {}, 11: {} };

  addCalendar(id, meta = {}) {
    this.calendars.set(id, new Map());
    this.calendarMeta.set(id, { id, summary: meta.summary ?? id, ...clone(meta) });
  }

  addTaskList(id, title = id) {
    this.taskLists.set(id, { id, title, items: new Map() });
  }

  putEvent(calendar, event) {
    const stored = {
      ...clone(event),
      etag: `"e${++this.serial}"`,
      status: event.status ?? 'confirmed',
    };
    this.calendars.get(calendar).set(stored.id, stored);
    return stored;
  }

  putTask(listId, item) {
    const list = this.taskLists.get(listId);
    const id = item.id ?? `gtask-${++this.serial}`;
    const stored = {
      ...clone(item),
      id,
      etag: `"t${++this.serial}"`,
      status: item.status ?? 'needsAction',
      updated: new Date('2026-10-17T12:00:00Z').toISOString(),
    };
    list.items.set(id, stored);
    return stored;
  }

  async request(method, path, body, headers) {
    this.calls.push({ method, path, body: clone(body), headers: clone(headers) });
    const url = new URL(path, 'https://google.invalid');

    // Tasks API routing
    if (url.pathname === '/tasks/v1/users/@me/lists') {
      if (method === 'GET') {
        return {
          items: [...this.taskLists.values()].map((l) => ({ id: l.id, title: l.title })),
        };
      }
      if (method === 'POST') {
        const id = `tasklist-${this.taskLists.size + 1}`;
        this.addTaskList(id, body.title);
        return { id, title: body.title };
      }
    }
    const taskMatch = url.pathname.match(/^\/tasks\/v1\/lists\/([^/]+)\/tasks(?:\/([^/]+))?$/);
    if (taskMatch) {
      const listId = decodeURIComponent(taskMatch[1]);
      const taskId = taskMatch[2] && decodeURIComponent(taskMatch[2]);
      const list = this.taskLists.get(listId);
      if (!list) throw httpError(404);
      if (method === 'GET' && !taskId) {
        return { items: clone([...list.items.values()]) };
      }
      if (method === 'GET') {
        if (!list.items.has(taskId)) throw httpError(404);
        return clone(list.items.get(taskId));
      }
      if (method === 'POST') {
        if (this.failTaskPost) throw httpError(503);
        const saved = this.putTask(listId, body);
        if (this.uncertainTaskPost) {
          this.uncertainTaskPost = false;
          throw new Error('Network lost after task creation');
        }
        return clone(saved);
      }
      if (!list.items.has(taskId)) throw httpError(404);
      if (method === 'PUT') {
        return clone(
          this.putTask(listId, { ...list.items.get(taskId), ...clone(body), id: taskId }),
        );
      }
      if (method === 'DELETE') {
        const existing = list.items.get(taskId);
        list.items.set(taskId, { ...existing, deleted: true, etag: `"t${++this.serial}"` });
        return {};
      }
    }

    // Calendar API routing
    if (path === '/colors') return { event: clone(this.colors) };
    if (method === 'POST' && path === '/calendars') {
      const id = `calendar-${this.calendars.size + 1}`;
      this.addCalendar(id, body);
      return { id };
    }
    const calMetaMatch = url.pathname.match(/^\/calendars\/([^/]+)$/);
    if (calMetaMatch) {
      const calId = decodeURIComponent(calMetaMatch[1]);
      if (!this.calendarMeta.has(calId)) throw httpError(404);
      if (method === 'GET') return clone(this.calendarMeta.get(calId));
      if (method === 'PATCH') {
        if (!this.supportCustomLabels && body?.labelProperties) {
          throw httpError(400);
        }
        const updated = { ...this.calendarMeta.get(calId), ...clone(body) };
        this.calendarMeta.set(calId, updated);
        return clone(updated);
      }
    }
    const match = url.pathname.match(/^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
    if (!match) throw new Error(`Unexpected request ${method} ${path}`);
    const calendar = decodeURIComponent(match[1]);
    const id = match[2] && decodeURIComponent(match[2]);
    const events = this.calendars.get(calendar);
    if (!events) throw httpError(404);
    if (method === 'GET' && !id) {
      return { items: clone([...events.values()]) };
    }
    if (method === 'GET') {
      if (!events.has(id)) throw httpError(404);
      return clone(events.get(id));
    }
    if (method === 'POST') {
      if (events.has(body.id)) throw httpError(409);
      return clone(this.putEvent(calendar, body));
    }
    if (!events.has(id)) throw httpError(404);
    if (headers?.['If-Match'] !== events.get(id).etag) throw httpError(412);
    if (method === 'PUT') return clone(this.putEvent(calendar, { ...clone(body), id }));
    if (method === 'PATCH')
      return clone(this.putEvent(calendar, { ...events.get(id), ...clone(body) }));
    if (method === 'DELETE') {
      this.putEvent(calendar, { ...events.get(id), status: 'cancelled' });
      return {};
    }
    throw new Error(`Unexpected request ${method} ${path}`);
  }
}

test('adaptive presentation validates custom labels, short titles, and syncs custom event labels with colorId fallback', async () => {
  const rawPresentation = {
    version: 1,
    theme: {
      style: 'compact',
      sessionPrefix: 'project',
      includeDeadlines: false,
      preferTasksForActionables: true,
      preferTasksForDailyHabits: true,
    },
    labels: {
      career: { name: 'Career Sprint', backgroundColor: '#1a73e8' },
      oss: { name: 'Open Source', backgroundColor: '#0b8043' },
      editor: { name: 'Neovim Setup', backgroundColor: '#8e24aa' },
    },
    projects: {
      p1: { label: 'career', shortName: 'Career' },
    },
    tasks: {
      t1: { shortTitle: 'Ship Portfolio Site', publish: true, scheduledDate: '2026-10-18' },
    },
    commitments: { defaultLabel: 'career' },
    habits: { h1: { shortName: 'Duolingo Spanish (15m)' } },
  };
  const validated = validatePresentation(rawPresentation);
  assert.equal(validated.theme.labels.career.color, '#1a73e8');
  assert.equal(validated.theme.labels.career.colorId, nearestColorId('#1a73e8'));

  // Reject invalid hex color or oversized label name
  assert.throws(
    () =>
      validatePresentation({
        version: 1,
        labels: { bad: { name: 'TooLongLabelName Beyond16', backgroundColor: '#1a73e8' } },
      }),
    /1\.\.16 characters/,
  );
  assert.throws(
    () =>
      validatePresentation({
        version: 1,
        labels: { bad: { name: 'Valid', backgroundColor: 'blue' } },
      }),
    /#RRGGBB/,
  );

  const state = {
    timezone: 'Asia/Jakarta',
    projects: [{ id: 'p1', title: 'Job Search Sprint', status: 'active' }],
    tasks: [
      {
        id: 't1',
        title: 'Deploy portfolio website with custom domain and analytics verification',
        status: 'todo',
        project_id: 'p1',
        version: 1,
      },
    ],
    work_sessions: [
      {
        id: 's1',
        task_id: 't1',
        status: 'scheduled',
        start_at: '2026-10-18T02:00:00Z',
        end_at: '2026-10-18T03:30:00Z',
        version: 1,
      },
    ],
    calendar_events: [],
    habits: [],
  };
  const cfg = {
    workspaceId: 'ws-1',
    titleMode: 'titles',
    deadlines: false,
    commitments: true,
    habits: {},
    categories: {},
    excludeCommitments: [],
    presentation: validated,
  };

  const wantedLabels = desiredCalendarLabels(cfg);
  assert.equal(Object.keys(wantedLabels).length, 3);
  assert.equal(wantedLabels.career.id, labelIdentity('ws-1', 'career'));

  // Merge preserves unrelated remote labels while updating managed Syntrop labels
  const merged = mergeCalendarLabels(
    [{ id: 'external-user-label', name: 'Personal', backgroundColor: '#f4511e' }],
    wantedLabels,
    'ws-1',
  );
  assert.equal(merged.length, 4);
  assert.equal(merged[0].id, 'external-user-label');

  // 1. Custom labels supported
  const projectedWithLabels = projectEvents(state, cfg, '2026-10-17', '2026-10-23', undefined, {
    career: labelIdentity('ws-1', 'career'),
  });
  assert.equal(projectedWithLabels[0].event.summary, 'Career · Ship Portfolio Site');
  assert.equal(projectedWithLabels[0].event.eventLabelId, labelIdentity('ws-1', 'career'));
  assert.equal(projectedWithLabels[0].event.colorId, undefined);

  const provider = new FakeGoogleV4();
  const registry = { workspaceId: 'ws-1' };
  const mappings = {};
  const plan1 = await planSync(
    provider,
    state,
    cfg,
    registry,
    mappings,
    '2026-10-17',
    '2026-10-23',
  );
  const result1 = await applySync(
    provider,
    plan1,
    registry,
    mappings,
    'Asia/Jakarta',
    () => {},
    () => {},
    { snapshot: state, config: cfg },
  );
  assert.equal(result1.created, 1);
  assert.equal(result1.labelMode, 'custom-labels');
  assert.ok(
    provider.calls.some((c) => c.path.includes('eventLabelVersion=1')),
    'event writes pass eventLabelVersion=1 when custom labels are active',
  );

  // 2. Fallback to colorId when provider rejects labelProperties
  const providerFallback = new FakeGoogleV4();
  providerFallback.supportCustomLabels = false;
  const registry2 = { workspaceId: 'ws-1' };
  const mappings2 = {};
  const plan2 = await planSync(
    providerFallback,
    state,
    cfg,
    registry2,
    mappings2,
    '2026-10-17',
    '2026-10-23',
  );
  const result2 = await applySync(
    providerFallback,
    plan2,
    registry2,
    mappings2,
    'Asia/Jakarta',
    () => {},
    () => {},
    { snapshot: state, config: cfg },
  );
  assert.equal(result2.created, 1);
  assert.equal(result2.labelMode, 'colorId-fallback');
  const savedEvent = [...providerFallback.calendars.get('calendar-1').values()][0];
  assert.equal(savedEvent.eventLabelId, undefined);
  assert.equal(savedEvent.colorId, nearestColorId('#1a73e8'));
});

test('Google Tasks projection filters actionable vs blocked tasks, projects bounded habit occurrences, and recovers from uncertain POST', async () => {
  const state = {
    timezone: 'Asia/Jakarta',
    projects: [{ id: 'p1', title: 'Career', status: 'active' }],
    tasks: [
      {
        id: 't-ready',
        title: 'Finalize Resume PDF',
        status: 'todo',
        project_id: 'p1',
        due_at: '2026-10-19T10:00:00Z',
        version: 1,
      },
      {
        id: 't-blocked',
        title: 'Submit 5 Applications',
        status: 'todo',
        project_id: 'p1',
        due_at: '2026-10-22T10:00:00Z',
        version: 1,
      },
    ],
    task_dependencies: [{ task_id: 't-blocked', depends_on_id: 't-ready' }],
    work_sessions: [
      {
        id: 's1',
        task_id: 't-ready',
        status: 'scheduled',
        start_at: '2026-10-18T02:00:00Z',
        end_at: '2026-10-18T03:30:00Z',
        version: 1,
      },
    ],
    calendar_events: [],
    habits: [
      {
        id: 'h1',
        name: 'Duolingo Spanish (15m)',
        frequency: 'daily',
        target: 1,
        active: 1,
        version: 1,
      },
    ],
    habit_occurrences: [
      { id: 'occ-skip', habit_id: 'h1', occurrence_key: '2026-10-19', outcome: 'skipped' },
    ],
  };

  const cfg = {
    workspaceId: 'ws-tasks',
    titleMode: 'titles',
    deadlines: false,
    commitments: true,
    habits: {
      h1: { mode: 'tasks', startDate: '2026-10-17', horizonDays: 5 },
    },
    categories: {},
    excludeCommitments: [],
    presentation: validatePresentation({
      version: 1,
      projects: { p1: { shortName: 'Career' } },
    }),
    tasksPolicy: {
      enabled: true,
      mode: 'actionable',
      habitHorizonDays: 5,
    },
  };

  const projected = projectTasks(state, cfg, '2026-10-17', '2026-10-23');
  const taskKeys = projected.filter((p) => p.kind === 'task').map((p) => p.key);
  assert.deepEqual(taskKeys, ['task:t-ready'], 'blocked task is excluded from actionable mode');
  const readyTask = projected.find((p) => p.key === 'task:t-ready');
  assert.equal(readyTask.task.title, 'Career · Finalize Resume PDF');
  assert.equal(readyTask.task.due, '2026-10-18T00:00:00.000Z');
  assert.match(readyTask.task.notes, /Syntrop deadline: 2026-10-19/);
  assert.ok(ownedTask(readyTask.task, 'ws-tasks', 'task:t-ready'));

  const habitDates = projected.filter((p) => p.kind === 'habit-task').map((p) => p.occurrenceDate);
  // 5-day horizon from 2026-10-17 is Oct 17, 18, 19, 20, 21; Oct 19 is skipped locally
  assert.deepEqual(habitDates, ['2026-10-17', '2026-10-18', '2026-10-20', '2026-10-21']);

  const provider = new FakeGoogleV4();
  const registry = { workspaceId: 'ws-tasks' };
  const mappings = {};
  const plan = await planTasksSync(
    provider,
    state,
    cfg,
    registry,
    mappings,
    '2026-10-17',
    '2026-10-23',
    false,
    '2026-10-17T05:00:00Z',
  );
  assert.deepEqual(plan.listsToCreate, ['tasks', 'habits']);
  assert.equal(plan.summary.create, 5);

  // Simulate uncertain POST on first task creation, then retry safely without duplicate
  provider.uncertainTaskPost = true;
  const firstApply = await applyTasksSync(
    provider,
    plan,
    cfg,
    registry,
    mappings,
    () => {},
    () => {},
  );
  assert.equal(firstApply.failed, 1);
  assert.equal(firstApply.created, 4);

  const retryPlan = await planTasksSync(
    provider,
    state,
    cfg,
    registry,
    mappings,
    '2026-10-17',
    '2026-10-23',
    false,
    '2026-10-17T05:00:00Z',
  );
  const retryApply = await applyTasksSync(
    provider,
    retryPlan,
    cfg,
    registry,
    mappings,
    () => {},
    () => {},
  );
  assert.equal(retryApply.failed, 0);
  const allRemoteTasks = [...provider.taskLists.get(registry.tasks).items.values()];
  assert.equal(allRemoteTasks.length, 1, 'uncertain POST recovery never duplicates tasks');
});

test('completion reconciliation records ready tasks, cancels future sessions, logs post-midnight habit occurrences on local date, and blocks invalid completions', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'syntrop-reconcile-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  init(dir, 'Asia/Jakarta');
  const { db } = openWorkspace(dir);
  t.after(() => db.close());

  const at = now();
  const projId = id('prj');
  db.prepare(
    'INSERT INTO projects(id, title, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, 1)',
  ).run(projId, 'Career Sprint', 'active', at, at);

  const tReadyId = id('tsk');
  db.prepare(
    'INSERT INTO tasks(id, project_id, title, status, priority, estimate_minutes, created_at, updated_at, version) VALUES (?, ?, ?, ?, 2, 90, ?, ?, 1)',
  ).run(tReadyId, projId, 'Publish Resume & Astro Site', 'todo', at, at);

  const tBlockedId = id('tsk');
  db.prepare(
    'INSERT INTO tasks(id, project_id, title, status, priority, estimate_minutes, created_at, updated_at, version) VALUES (?, ?, ?, ?, 2, 120, ?, ?, 1)',
  ).run(tBlockedId, projId, 'Submit 5 Targeted Roles', 'todo', at, at);

  addDependency(db, tBlockedId, tReadyId);

  const pastSession = addSession(
    db,
    tReadyId,
    '2020-01-01T09:00:00+07:00',
    '2020-01-01T10:00:00+07:00',
  );
  const futureSession = addSession(
    db,
    tReadyId,
    '2099-01-01T09:00:00+07:00',
    '2099-01-01T10:30:00+07:00',
  );

  const habitId = id('hab');
  db.prepare(
    'INSERT INTO habits(id, name, frequency, target, active, created_at, updated_at, version) VALUES (?, ?, ?, 1, 1, ?, ?, 1)',
  ).run(habitId, 'Duolingo Spanish (15m)', 'daily', at, at);

  const dbSnapshot = (database) => ({
    timezone: 'Asia/Jakarta',
    projects: rows(database, 'SELECT * FROM projects ORDER BY id'),
    tasks: rows(database, 'SELECT * FROM tasks ORDER BY id'),
    task_dependencies: rows(
      database,
      'SELECT * FROM task_dependencies ORDER BY task_id, depends_on_id',
    ),
    work_sessions: rows(database, 'SELECT * FROM work_sessions ORDER BY id'),
    calendar_events: rows(database, 'SELECT * FROM calendar_events ORDER BY id'),
    habits: rows(database, 'SELECT * FROM habits ORDER BY id'),
    habit_occurrences: rows(database, 'SELECT * FROM habit_occurrences ORDER BY id'),
  });

  const cfg = {
    workspaceId: 'ws-reconcile',
    titleMode: 'titles',
    deadlines: false,
    commitments: true,
    habits: {
      [habitId]: { mode: 'tasks', startDate: '2026-10-17', horizonDays: 7 },
    },
    categories: {},
    excludeCommitments: [],
    tasksPolicy: {
      enabled: true,
      mode: 'selected',
      taskIds: [tReadyId, tBlockedId],
      habitHorizonDays: 7,
    },
  };

  const provider = new FakeGoogleV4();
  const registry = { workspaceId: 'ws-reconcile' };
  const mappings = {};
  const snap1 = dbSnapshot(db);
  const syncPlan = await planTasksSync(
    provider,
    snap1,
    cfg,
    registry,
    mappings,
    '2026-10-17',
    '2026-10-20',
    false,
    '2026-10-17T05:00:00Z',
  );
  await applyTasksSync(
    provider,
    syncPlan,
    cfg,
    registry,
    mappings,
    () => {},
    () => {},
  );

  const tasksList = provider.taskLists.get(registry.tasks);
  const habitsList = provider.taskLists.get(registry.habits);
  const readyRemote = tasksList.items.get(mappings[`task:${tReadyId}`].taskId);
  readyRemote.status = 'completed';
  readyRemote.completed = '2026-10-17T11:00:00.000Z';

  const blockedRemote = tasksList.items.get(mappings[`task:${tBlockedId}`].taskId);
  blockedRemote.status = 'completed';
  blockedRemote.completed = '2026-10-17T11:05:00.000Z';

  const habitOct17Remote = habitsList.items.get(
    mappings[`habit-task:${habitId}:2026-10-17`].taskId,
  );
  habitOct17Remote.status = 'completed';
  habitOct17Remote.completed = '2026-10-17T18:30:00.000Z';

  const reconcilePlan = await planReconcile(provider, dbSnapshot(db), cfg, registry, mappings);
  assert.equal(reconcilePlan.summary['complete-task'], 1);
  assert.equal(reconcilePlan.summary['complete-habit'], 1);
  assert.equal(reconcilePlan.summary.conflict, 1);

  const blockedConflict = reconcilePlan.actions.find((a) => a.entityId === tBlockedId);
  assert.equal(blockedConflict.kind, 'conflict');
  assert.deepEqual(blockedConflict.blockedBy, [tReadyId]);

  const result = applyReconcile(db, reconcilePlan, mappings, () => {});
  assert.equal(result.tasksCompleted, 1);
  assert.equal(result.habitsLogged, 1);
  assert.equal(result.conflicted, 1);
  assert.equal(result.operationalDataChanged, true);

  const updatedReady = get(db, 'tasks', tReadyId);
  assert.equal(updatedReady.status, 'done');
  assert.equal(get(db, 'tasks', tBlockedId).status, 'todo');
  assert.equal(get(db, 'work_sessions', String(pastSession.id)).status, 'scheduled');
  assert.equal(get(db, 'work_sessions', String(futureSession.id)).status, 'cancelled');

  const loggedOcc = result.loggedHabits[0];
  assert.equal(loggedOcc.occurrence_key, '2026-10-17');
  assert.equal(loggedOcc.outcome, 'completed');

  // Unchecking the completed habit task or completed Syntrop task in Google Tasks reports a conflict and never erases history
  // Also reset blockedRemote to needsAction so we isolate the uncheck conflict test
  blockedRemote.status = 'needsAction';
  delete blockedRemote.completed;
  readyRemote.status = 'needsAction';
  delete readyRemote.completed;
  habitOct17Remote.status = 'needsAction';
  delete habitOct17Remote.completed;

  const uncheckPlan = await planReconcile(provider, dbSnapshot(db), cfg, registry, mappings);
  assert.equal(uncheckPlan.summary.conflict, 2);
  const uncheckResult = applyReconcile(db, uncheckPlan, mappings, () => {});
  assert.equal(uncheckResult.tasksCompleted, 0);
  assert.equal(uncheckResult.habitsLogged, 0);
  assert.equal(get(db, 'tasks', tReadyId).status, 'done');
});

test('v0.3.0 to v0.4.0 migration preserves Focus event IDs and only retires recurring Calendar habits after replacement habit tasks succeed', async () => {
  const provider = new FakeGoogleV4();
  const state = {
    timezone: 'Asia/Jakarta',
    projects: [{ id: 'p1', title: 'Career', status: 'active' }],
    tasks: [{ id: 't1', title: 'Resume Polish', status: 'todo', project_id: 'p1', version: 1 }],
    work_sessions: [
      {
        id: 's1',
        task_id: 't1',
        status: 'scheduled',
        start_at: '2026-10-18T02:00:00Z',
        end_at: '2026-10-18T03:30:00Z',
        version: 1,
      },
    ],
    calendar_events: [
      {
        id: 'c1',
        title: 'Weekly Review',
        status: 'scheduled',
        start_at: '2026-10-23T11:00:00Z',
        end_at: '2026-10-23T12:00:00Z',
        all_day: 0,
      },
    ],
    habits: [
      {
        id: 'h1',
        name: 'Duolingo Spanish (15m)',
        frequency: 'daily',
        target: 1,
        active: 1,
        version: 1,
      },
    ],
  };

  // Step 1: Publish v0.3.0 state (timed recurring habit on Syntrop · Habits calendar)
  const v3Config = {
    workspaceId: 'ws-migrate',
    titleMode: 'titles',
    deadlines: false,
    commitments: true,
    habits: {
      h1: { mode: 'timed', startDate: '2026-10-17', time: '07:30', duration: 15 },
    },
    categories: { p1: 'career' },
    excludeCommitments: [],
  };
  const calRegistry = { workspaceId: 'ws-migrate' };
  const calMappings = {};
  const v3Plan = await planSync(
    provider,
    state,
    v3Config,
    calRegistry,
    calMappings,
    '2026-10-17',
    '2026-10-23',
    false,
    '2026-10-17T05:00:00Z',
  );
  await applySync(
    provider,
    v3Plan,
    calRegistry,
    calMappings,
    'Asia/Jakarta',
    () => {},
    () => {},
    { snapshot: state, config: v3Config },
  );
  const originalSessionEventId = calMappings['session:s1'].eventId;
  const originalCommitmentEventId = calMappings['commitment:c1'].eventId;
  const originalHabitEventId = calMappings['habit:h1'].eventId;
  assert.equal(
    provider.calendars.get(calRegistry.habits).get(originalHabitEventId).status,
    'confirmed',
  );

  // Step 2: Upgrade config to v0.4.0 (habit h1 -> mode: 'tasks')
  const v4Config = {
    ...v3Config,
    habits: {
      h1: { mode: 'tasks', startDate: '2026-10-17', horizonDays: 7 },
    },
    tasksPolicy: {
      enabled: true,
      mode: 'actionable',
      habitHorizonDays: 7,
    },
  };
  const taskRegistry = { workspaceId: 'ws-migrate' };
  const taskMappings = {};

  const v4CalPlan = await planSync(
    provider,
    state,
    v4Config,
    calRegistry,
    calMappings,
    '2026-10-17',
    '2026-10-23',
    false,
    '2026-10-17T05:00:00Z',
  );
  // Session and commitment keep their exact remote IDs; habit:h1 is planned for cancel
  assert.equal(
    v4CalPlan.actions.find((a) => a.key === 'session:s1').remoteId,
    originalSessionEventId,
  );
  assert.equal(
    v4CalPlan.actions.find((a) => a.key === 'commitment:c1').remoteId,
    originalCommitmentEventId,
  );
  assert.equal(v4CalPlan.actions.find((a) => a.key === 'habit:h1').kind, 'cancel');

  // Simulate Tasks API failure during migration: skipHabitRetire must preserve old Calendar habit series!
  const v4TaskPlan = await planTasksSync(
    provider,
    state,
    v4Config,
    taskRegistry,
    taskMappings,
    '2026-10-17',
    '2026-10-23',
    false,
    '2026-10-17T05:00:00Z',
  );
  provider.failTaskPost = true;
  const failedTasksApply = await applyTasksSync(
    provider,
    v4TaskPlan,
    v4Config,
    taskRegistry,
    taskMappings,
    () => {},
    () => {},
  );
  assert.ok(failedTasksApply.failed > 0);

  await applySync(
    provider,
    v4CalPlan,
    calRegistry,
    calMappings,
    'Asia/Jakarta',
    () => {},
    () => {},
    { skipHabitRetire: true, snapshot: state, config: v4Config },
  );
  assert.equal(
    provider.calendars.get(calRegistry.habits).get(originalHabitEventId).status,
    'confirmed',
    'Old recurring Calendar habit event is preserved when replacement habit tasks fail',
  );

  // Step 3: Tasks API succeeds -> replacement tasks created -> old Calendar habit series retired cleanly
  provider.failTaskPost = false;
  const retryTaskPlan = await planTasksSync(
    provider,
    state,
    v4Config,
    taskRegistry,
    taskMappings,
    '2026-10-17',
    '2026-10-23',
    false,
    '2026-10-17T05:00:00Z',
  );
  const okTasksApply = await applyTasksSync(
    provider,
    retryTaskPlan,
    v4Config,
    taskRegistry,
    taskMappings,
    () => {},
    () => {},
  );
  assert.equal(okTasksApply.failed, 0);
  assert.equal(okTasksApply.created, 8); // 1 actionable task + 7 daily habit occurrences

  const retryCalPlan = await planSync(
    provider,
    state,
    v4Config,
    calRegistry,
    calMappings,
    '2026-10-17',
    '2026-10-23',
    false,
    '2026-10-17T05:00:00Z',
  );
  const okCalApply = await applySync(
    provider,
    retryCalPlan,
    calRegistry,
    calMappings,
    'Asia/Jakarta',
    () => {},
    () => {},
    { skipHabitRetire: false, snapshot: state, config: v4Config },
  );
  assert.equal(okCalApply.cancelled, 1);
  assert.equal(
    provider.calendars.get(calRegistry.habits).get(originalHabitEventId).status,
    'cancelled',
  );
  assert.equal(calMappings['session:s1'].eventId, originalSessionEventId);
  assert.equal(calMappings['commitment:c1'].eventId, originalCommitmentEventId);
});

test('CLI integration google presentation, tasks, migrate, reconcile, diagnose, and standing auto-sync work end-to-end', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'syntrop-v4-cli-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const home = join(root, 'google');
  const client = join(root, 'desktop.json');
  writeFileSync(
    client,
    JSON.stringify({
      installed: {
        client_id: 'synthetic.apps.googleusercontent.com',
        client_secret: 'synthetic-desktop-value',
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        token_uri: 'https://oauth2.googleapis.com/token',
        redirect_uris: ['http://localhost'],
      },
    }),
  );
  const remote = join(root, 'fake-remote-v4.json');
  writeFileSync(remote, JSON.stringify({ calendars: {}, taskLists: {}, writes: 0 }));
  const preload = join(root, 'fake-fetch-v4.mjs');
  writeFileSync(
    preload,
    `import { readFileSync, writeFileSync } from 'node:fs';
const file = ${JSON.stringify(remote)};
const NativeDate=Date; globalThis.Date=class extends NativeDate { constructor(...args){super(...(args.length?args:['2026-10-17T12:00:00Z']));} static now(){return new NativeDate('2026-10-17T12:00:00Z').getTime();} };
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  const method = options.method ?? 'GET';
  const state = JSON.parse(readFileSync(file, 'utf8'));
  const body = options.body ? JSON.parse(options.body) : {};
  const reply = (value, status=200) => new Response(status===204?null:JSON.stringify(value), {status,headers:{'content-type':'application/json'}});
  const commit = value => { state.writes++; writeFileSync(file, JSON.stringify(state)); return reply(value); };

  if (url.origin === 'https://tasks.googleapis.com') {
    if (url.pathname === '/tasks/v1/users/@me/lists') {
      if (method === 'GET') return reply({ items: Object.values(state.taskLists).map(l => ({ id: l.id, title: l.title })) });
      if (method === 'POST') {
        const id = 'tlist-' + (Object.keys(state.taskLists).length + 1);
        state.taskLists[id] = { id, title: body.title, tasks: {} };
        return commit({ id, title: body.title });
      }
    }
    const m = /^\\/tasks\\/v1\\/lists\\/([^/]+)\\/tasks(?:\\/([^/]+))?$/.exec(url.pathname);
    if (!m) return reply({}, 404);
    const list = state.taskLists[decodeURIComponent(m[1])];
    if (!list) return reply({}, 404);
    const tid = m[2] ? decodeURIComponent(m[2]) : undefined;
    if (method === 'GET' && !tid) return reply({ items: Object.values(list.tasks) });
    if (method === 'GET') return list.tasks[tid] ? reply(list.tasks[tid]) : reply({}, 404);
    if (method === 'POST') {
      const id = 'gtask-' + (state.writes + 1);
      list.tasks[id] = { ...body, id, etag: '"t' + (state.writes + 1) + '"', status: body.status ?? 'needsAction' };
      return commit(list.tasks[id]);
    }
    if (method === 'PUT') {
      list.tasks[tid] = { ...list.tasks[tid], ...body, id: tid, etag: '"t' + (state.writes + 1) + '"' };
      return commit(list.tasks[tid]);
    }
    if (method === 'DELETE') {
      list.tasks[tid] = { ...list.tasks[tid], deleted: true, etag: '"t' + (state.writes + 1) + '"' };
      return commit({});
    }
  }

  const path = url.pathname.replace('/calendar/v3', '');
  if (path === '/colors') return reply({ event: { '1':{}, '2':{}, '3':{}, '7':{}, '9':{}, '10':{} } });
  if (path === '/calendars' && method === 'POST') {
    const id = 'cal-' + (Object.keys(state.calendars).length + 1);
    state.calendars[id] = { ...body, id, events: {} };
    return commit(state.calendars[id]);
  }
  const match = /^\\/calendars\\/([^/]+)(?:\\/events(?:\\/([^/]+))?)?$/.exec(path);
  if (!match) return reply({}, 404);
  const cal = state.calendars[decodeURIComponent(match[1])];
  if (!cal) return reply({}, 404);
  if (!path.includes('/events')) {
    if (method === 'PATCH') {
      Object.assign(cal, body);
      return commit(cal);
    }
    return reply(cal);
  }
  const id = match[2] ? decodeURIComponent(match[2]) : body.id;
  if (method === 'GET') return reply(id ? cal.events[id] ?? {} : { items: Object.values(cal.events) }, id && !cal.events[id] ? 404 : 200);
  if (method === 'POST') {
    if (cal.events[id]) return reply({}, 409);
    cal.events[id] = { ...body, etag: '"v1"', status: body.status ?? 'confirmed' };
    return commit(cal.events[id]);
  }
  if (!cal.events[id]) return reply({}, 404);
  if (options.headers['If-Match'] !== cal.events[id].etag) return reply({}, 412);
  if (method === 'PUT' || method === 'PATCH') {
    cal.events[id] = { ...cal.events[id], ...body, etag: '"v' + (state.writes + 1) + '"' };
    return commit(cal.events[id]);
  }
  if (method === 'DELETE') {
    cal.events[id].status = 'cancelled';
    return commit(cal.events[id]);
  }
  return reply({}, 400);
};`,
  );

  function call(...args) {
    const res = spawnSync(
      process.execPath,
      ['--import', preload, resolve('src/cli.ts'), '--workspace', workspace, '--json', ...args],
      { encoding: 'utf8', env: { ...process.env, SYNTROP_GOOGLE_HOME: home } },
    );
    return {
      status: res.status,
      value: res.stdout.trim() ? JSON.parse(res.stdout) : null,
      error: res.stderr.trim() ? JSON.parse(res.stderr) : null,
    };
  }
  function ok(...args) {
    const r = call(...args);
    assert.equal(r.status, 0, JSON.stringify(r));
    return r.value;
  }

  ok('init', '--timezone', 'Asia/Jakarta');
  const proj = ok('project', 'add', '--title', 'Career Sprint');
  const t1 = ok(
    'task',
    'add',
    '--title',
    'Publish Portfolio Website',
    '--project',
    proj.id,
    '--status',
    'todo',
  );
  ok(
    'schedule',
    'add',
    '--task',
    t1.id,
    '--start',
    '2026-10-18T09:00:00+07:00',
    '--end',
    '2026-10-18T10:30:00+07:00',
  );
  const h1 = ok(
    'habit',
    'add',
    '--name',
    'Duolingo Spanish (15m)',
    '--frequency',
    'daily',
    '--target',
    '1',
  );

  ok('integration', 'google', 'setup', '--client', client);
  writePrivate(home, 'tokens.json', {
    access_token: 'SYNTHETIC_ACCESS',
    refresh_token: 'SYNTHETIC_REFRESH',
    expires_at: new Date('2099-01-01T00:00:00Z').getTime(),
    scope:
      'https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/tasks',
    token_type: 'Bearer',
  });

  ok(
    'integration',
    'google',
    'configure',
    '--title-mode',
    'titles',
    '--auto-sync',
    'on',
    '--auto-reconcile',
    'on',
  );
  ok(
    'integration',
    'google',
    'presentation',
    'apply',
    '--json-body',
    JSON.stringify({
      version: 1,
      theme: { style: 'compact', sessionPrefix: 'project' },
      labels: { career: { name: 'Career', backgroundColor: '#1a73e8' } },
      projects: { [proj.id]: { label: 'career', shortName: 'Career' } },
      tasks: { [t1.id]: { shortTitle: 'Publish Portfolio', publish: true } },
    }),
  );
  ok(
    'integration',
    'google',
    'tasks',
    'configure',
    '--enabled',
    'on',
    '--mode',
    'actionable',
    '--horizon-days',
    '5',
  );
  ok(
    'integration',
    'google',
    'habit',
    h1.id,
    '--mode',
    'tasks',
    '--start-date',
    '2026-10-17',
    '--horizon-days',
    '5',
  );

  // Sync using standing authorization (--auto)
  const synced = ok(
    'integration',
    'google',
    'sync',
    '--from',
    '2026-10-17',
    '--through',
    '2026-10-23',
    '--auto',
  );
  assert.equal(synced.created, 1);
  assert.equal(synced.tasks.created, 6); // 1 task + 5 habit occurrences

  // Mark task completed in fake remote and run reconcile --auto
  const stateData = JSON.parse(readFileSync(remote, 'utf8'));
  const tasksList = Object.values(stateData.taskLists).find((l) => l.title === 'Syntrop · Tasks');
  const remoteTask = Object.values(tasksList.tasks)[0];
  remoteTask.status = 'completed';
  remoteTask.completed = '2026-10-18T03:00:00.000Z';
  writeFileSync(remote, JSON.stringify(stateData));

  const reconciled = ok('integration', 'google', 'reconcile', '--auto');
  assert.equal(reconciled.tasksCompleted, 1);
  assert.equal(ok('task', 'show', t1.id).status, 'done');

  // Diagnose reports healthy state
  const diag = ok(
    'integration',
    'google',
    'diagnose',
    '--from',
    '2026-10-17',
    '--through',
    '2026-10-23',
  );
  assert.equal(diag.healthy, true);

  // Revoking standing auto-sync rejects --auto
  ok('integration', 'google', 'configure', '--auto-sync', 'off');
  const rejectedAuto = call(
    'integration',
    'google',
    'sync',
    '--from',
    '2026-10-17',
    '--through',
    '2026-10-23',
    '--auto',
  );
  assert.notEqual(rejectedAuto.status, 0);
  assert.equal(rejectedAuto.error.error.code, 'CONFIRMATION_REQUIRED');
});

test('OAuth Tasks scope upgrade enforces requireTasks, and GoogleClient routes /tasks/v1/ without retrying POST', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'syntrop-tasks-auth-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writePrivate(dir, 'client.json', {
    client_id: 'cid.apps.googleusercontent.com',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
  });
  writePrivate(dir, 'tokens.json', {
    access_token: 'CAL_ONLY_TOKEN',
    refresh_token: 'REFRESH_TOKEN',
    expires_at: new Date('2099-01-01T00:00:00Z').getTime(),
    scope: 'https://www.googleapis.com/auth/calendar.app.created',
    token_type: 'Bearer',
  });

  // Calendar-only token works for Calendar but rejects Tasks requests with GOOGLE_SCOPE
  const calToken = await getAccessToken(dir, { persist: false, requireTasks: false });
  assert.equal(calToken, 'CAL_ONLY_TOKEN');
  await assert.rejects(
    () => getAccessToken(dir, { persist: false, requireTasks: true }),
    (err) => err.code === 'MISSING_SCOPE',
  );

  // Grant Tasks scope and verify GoogleClient routes /tasks/v1/ to tasks.googleapis.com and does not retry POST 503
  writePrivate(dir, 'tokens.json', {
    access_token: 'CAL_AND_TASKS_TOKEN',
    refresh_token: 'REFRESH_TOKEN',
    expires_at: new Date('2099-01-01T00:00:00Z').getTime(),
    scope:
      'https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/tasks',
    token_type: 'Bearer',
  });

  const seenUrls = [];
  let postCalls = 0;
  let getCalls = 0;
  const client = new GoogleClient(dir, {
    sleep: async () => {},
    fetch: async (input, init) => {
      seenUrls.push(String(input));
      if ((init?.method ?? 'GET') === 'POST') {
        postCalls++;
        return new Response(JSON.stringify({ error: { message: 'unavailable' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      getCalls++;
      if (getCalls === 1) {
        return new Response(JSON.stringify({ error: { message: 'unavailable' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const listRes = await client.request('GET', '/tasks/v1/users/@me/lists');
  assert.deepEqual(listRes, { items: [] });
  assert.equal(getCalls, 2, 'GET /tasks/v1/ retries transient 503');
  assert.ok(seenUrls[0].startsWith('https://tasks.googleapis.com/tasks/v1/'));

  await assert.rejects(
    () => client.request('POST', '/tasks/v1/lists/list-1/tasks', { title: 'Test' }),
    (err) => err.status === 503,
  );
  assert.equal(
    postCalls,
    1,
    'POST /tasks/v1/ never replays automatically because server assigns task IDs',
  );
});

test('weekly habit task projection, redacted privacy titles, pre-existing local log skip, and horizon warning', async () => {
  const state = {
    timezone: 'Asia/Jakarta',
    projects: [{ id: 'p1', title: 'Secret Project', status: 'active' }],
    tasks: [{ id: 't1', title: 'Top Secret Task', status: 'todo', project_id: 'p1', version: 1 }],
    work_sessions: [],
    calendar_events: [],
    habits: [
      {
        id: 'h-daily',
        name: 'Private Daily Habit',
        frequency: 'daily',
        target: 1,
        active: 1,
        version: 1,
      },
      {
        id: 'h-weekly',
        name: 'Weekly Deep Synthesis',
        frequency: 'weekly',
        target: 2,
        active: 1,
        version: 1,
      },
    ],
    habit_occurrences: [
      { id: 'occ-1', habit_id: 'h-daily', occurrence_key: '2026-10-17', outcome: 'completed' },
    ],
  };

  const redactedCfg = {
    workspaceId: 'ws-privacy',
    titleMode: 'redacted',
    deadlines: false,
    commitments: true,
    habits: {
      'h-daily': { mode: 'tasks', startDate: '2026-10-17', horizonDays: 2 },
      'h-weekly': { mode: 'tasks', startDate: '2026-10-17', horizonDays: 14 },
    },
    categories: {},
    excludeCommitments: [],
    tasksPolicy: { enabled: true, mode: 'actionable', habitHorizonDays: 2 },
  };

  const projected = projectTasks(state, redactedCfg, '2026-10-17', '2026-10-25');
  const taskProj = projected.find((p) => p.key === 'task:t1');
  assert.equal(taskProj.task.title, 'Task', 'redacted mode hides task title');
  const habitProj = projected.find((p) => p.key === 'habit-task:h-daily:2026-10-18');
  assert.equal(habitProj.task.title, 'Habit', 'redacted mode hides habit title');
  const weeklyProj = projected.filter((p) => p.entityId === 'h-weekly');
  assert.ok(weeklyProj.length >= 2, 'weekly habit projects weekly task occurrences');

  // Plan sync: 2026-10-17 was already completed locally before projection -> skipped (not fabricated remotely),
  // and 2-day horizon triggers horizonWarning (<= 3 days remaining)
  const provider = new FakeGoogleV4();
  const plan = await planTasksSync(
    provider,
    state,
    {
      ...redactedCfg,
      habits: { 'h-daily': { mode: 'tasks', startDate: '2026-10-17', horizonDays: 2 } },
    },
    { workspaceId: 'ws-privacy' },
    {},
    '2026-10-17',
    '2026-10-23',
    false,
    '2026-10-17T05:00:00Z',
  );
  const oct17Action = plan.actions.find((a) => a.key === 'habit-task:h-daily:2026-10-17');
  assert.equal(oct17Action.kind, 'skip');
  assert.ok(plan.horizonWarning, 'warns when <= 3 upcoming habit days are projected');
});

test('v0.3.0 events with Google auto-assigned eventLabelId UUIDs do not trigger false drift conflicts', () => {
  const v3Event = {
    summary: 'Weekly Review & Sprint 2 Planning',
    description: 'Syntrop source: commitment:evt_1',
    start: { dateTime: '2026-10-23T15:00:00+07:00', timeZone: 'Asia/Jakarta' },
    end: { dateTime: '2026-10-23T16:00:00+07:00', timeZone: 'Asia/Jakarta' },
    visibility: 'private',
    colorId: '1',
    reminders: { useDefault: false },
  };
  const v3Hash = eventFingerprint(v3Event);
  const googleReturnedEvent = {
    ...v3Event,
    eventLabelId: 'a4a64050-988d-4a72-a7f6-519ce54c137f',
    extendedProperties: {
      private: {
        syntrop_workspace: 'ws-1',
        syntrop_projection: '1',
        syntrop_hash: v3Hash,
        syntrop_key: 'commitment:evt_1',
      },
    },
  };
  assert.equal(
    eventFingerprint(googleReturnedEvent),
    v3Hash,
    'Google built-in eventLabelId mirror must not alter v0.3.0 colorId fingerprint',
  );

  // Verify 24 built-in unnamed Google Calendar label entries + 5 custom Syntrop labels merge cleanly
  const builtIn24 = Array.from({ length: 24 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    backgroundColor: '#7986cb',
  }));
  const wanted5 = Object.fromEntries(
    ['career', 'oss', 'editor', 'review', 'habit'].map((key) => [
      key,
      { id: labelIdentity('ws-1', key), name: key, backgroundColor: '#1d4ed8' },
    ]),
  );
  const merged = mergeCalendarLabels(builtIn24, wanted5, 'ws-1');
  assert.equal(merged.length, 29);
});
