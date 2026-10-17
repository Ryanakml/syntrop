import test from 'node:test';
import assert from 'node:assert/strict';
import { projectEvents, eventIdentity, eventFingerprint } from '../src/google-projection.ts';

const config = (patch = {}) => ({
  workspaceId: 'workspace-test',
  titleMode: 'redacted',
  deadlines: false,
  commitments: true,
  habits: {},
  categories: {},
  excludeCommitments: [],
  ...patch,
});
const snapshot = (patch = {}) => ({
  timezone: 'Asia/Jakarta',
  projects: [{ id: 'p', status: 'active' }],
  tasks: [
    {
      id: 't',
      title: 'Secret user@example.com',
      status: 'todo',
      project_id: 'p',
      due_at: '2026-10-18T23:00:00Z',
      version: 2,
    },
  ],
  work_sessions: [
    {
      id: 's',
      task_id: 't',
      start_at: '2026-10-18T02:00:00Z',
      end_at: '2026-10-18T03:00:00Z',
      status: 'scheduled',
      note: 'SECRET',
      version: 3,
    },
  ],
  calendar_events: [],
  habits: [],
  ...patch,
});
const project = (state = snapshot(), cfg = config(), colors) =>
  projectEvents(state, cfg, '2026-10-17', '2026-10-23', colors);
const habit = (patch = {}) => ({
  id: 'h',
  name: 'Private habit',
  frequency: 'daily',
  active: 1,
  created_at: '2026-01-01T00:00:00Z',
  version: 1,
  ...patch,
});

test('projection contains only managed, redacted session fields and stable ownership', () => {
  const [result] = project();
  assert.equal(result.key, 'session:s');
  assert.equal(result.calendar, 'focus');
  assert.equal(result.sourceVersion, 3);
  assert.equal(result.event.summary, 'Focus');
  assert.equal(result.event.visibility, 'private');
  assert.equal(result.event.transparency, 'opaque');
  assert.deepEqual(result.event.reminders, { useDefault: false });
  assert.equal(
    result.event.extendedProperties.private.syntrop_hash,
    eventFingerprint(result.event),
  );
  assert.equal(result.event.extendedProperties.private.syntrop_key, result.key);
  assert.doesNotMatch(JSON.stringify(result.event), /SECRET|Secret|user@example.com/);
  assert.match(result.event.id, /^[0-9a-v]{5,1024}$/);
  assert.equal(eventIdentity('workspace-test', 'session:s'), result.event.id);
  assert.notEqual(eventIdentity('other', 'session:s'), result.event.id);
});

test('done/cancelled tasks, paused projects, cancelled sessions and old sessions disappear', () => {
  for (const status of ['done', 'cancelled'])
    assert.deepEqual(project(snapshot({ tasks: [{ ...snapshot().tasks[0], status }] })), []);
  assert.deepEqual(project(snapshot({ projects: [{ id: 'p', status: 'paused' }] })), []);
  assert.deepEqual(
    project(snapshot({ work_sessions: [{ ...snapshot().work_sessions[0], status: 'cancelled' }] })),
    [],
  );
  assert.deepEqual(
    project(
      snapshot({
        work_sessions: [
          {
            ...snapshot().work_sessions[0],
            start_at: '2026-10-16T00:00:00Z',
            end_at: '2026-10-16T01:00:00Z',
          },
        ],
      }),
    ),
    [],
  );
  assert.deepEqual(project(snapshot({ work_sessions: [] })), []);
});

test('deadlines are optional, local all-day, free and end-exclusive', () => {
  const result = project(snapshot(), config({ deadlines: true })).find(
    (item) => item.key === 'deadline:t',
  );
  assert.deepEqual(result.event.start, { date: '2026-10-19' });
  assert.deepEqual(result.event.end, { date: '2026-10-20' });
  assert.equal(result.event.transparency, 'transparent');
});

test('commitments can be explicitly excluded to avoid external mirrors', () => {
  const row = {
    id: 'c',
    title: 'Meeting',
    start_at: '2026-10-18T02:00:00Z',
    end_at: '2026-10-18T03:00:00Z',
  };
  const state = snapshot({ work_sessions: [], calendar_events: [row] });
  assert.equal(project(state)[0].key, 'commitment:c');
  assert.deepEqual(project(state, config({ commitments: false })), []);
  assert.deepEqual(project(state, config({ excludeCommitments: ['c'] })), []);
  assert.deepEqual(
    project(snapshot({ ...state, calendar_events: [{ ...row, status: 'cancelled' }] })),
    [],
  );
});

test('colors come only from fetched catalog and explicit project category', () => {
  assert.equal(
    project(snapshot(), config({ categories: { p: 'oss' } }), { 3: {} })[0].event.colorId,
    '3',
  );
  assert.equal(
    project(snapshot(), config({ categories: { p: 'oss' } }), { 9: {} })[0].event.colorId,
    undefined,
  );
  assert.equal(project()[0].event.colorId, undefined);
  assert.equal(
    project(snapshot(), config({ titleMode: 'titles' }))[0].event.summary,
    'Secret [email]',
  );
});

test('habits require opt-in and explicit stable anchor; no logging data affects display', () => {
  const state = snapshot({ work_sessions: [], habits: [habit()] });
  assert.deepEqual(project(state), []);
  assert.throws(() => project(state, config({ habits: { h: { mode: 'flexible' } } })), /startDate/);
  const cfg = config({ habits: { h: { mode: 'flexible', startDate: '2026-10-01' } } });
  const result = project(state, cfg)[0];
  assert.deepEqual(result.event.start, { date: '2026-10-01' });
  assert.deepEqual(result.event.recurrence, ['RRULE:FREQ=DAILY']);
  assert.equal(result.event.transparency, 'transparent');
  assert.deepEqual(result.event, projectEvents(state, cfg, '2026-10-20', '2026-10-26')[0].event);
  assert.deepEqual(project(snapshot({ ...state, habits: [habit({ active: 0 })] }), cfg), []);
});

test('weekly flexible without weekdays means full-week reminder, never an invented occurrence', () => {
  const result = project(
    snapshot({ work_sessions: [], habits: [habit({ frequency: 'weekly', target: 3 })] }),
    config({ habits: { h: { mode: 'flexible', startDate: '2026-10-14' } } }),
  )[0];
  assert.deepEqual(result.event.start, { date: '2026-10-12' });
  assert.deepEqual(result.event.end, { date: '2026-10-19' });
  assert.deepEqual(result.event.recurrence, ['RRULE:FREQ=WEEKLY;WKST=MO']);
  assert.match(result.event.summary, /weekly reminder/);
  assert.match(result.event.description, /not a scheduled occurrence/);
});

test('timed habit validates duration/weekdays and retains IANA recurrence zone', () => {
  const state = snapshot({ work_sessions: [], habits: [habit({ frequency: 'weekly' })] });
  const display = { mode: 'timed', startDate: '2026-10-17', time: '09:00', duration: 30 };
  assert.throws(() => project(state, config({ habits: { h: display } })), /weekdays/);
  const result = project(
    state,
    config({ habits: { h: { ...display, weekdays: ['WE', 'MO'], reminderMinutes: 5 } } }),
  )[0];
  assert.equal(result.event.start.dateTime, '2026-10-19T02:00:00.000Z');
  assert.equal(result.event.end.dateTime, '2026-10-19T02:30:00.000Z');
  assert.equal(result.event.start.timeZone, 'Asia/Jakarta');
  assert.deepEqual(result.event.recurrence, ['RRULE:FREQ=WEEKLY;WKST=MO;BYDAY=MO,WE']);
  assert.deepEqual(result.event.reminders, {
    useDefault: false,
    overrides: [{ method: 'popup', minutes: 5 }],
  });
});

test('DST gap and overlap are rejected rather than shifted or arbitrarily selected', () => {
  const state = snapshot({ timezone: 'America/New_York', work_sessions: [], habits: [habit()] });
  for (const [date, time] of [
    ['2026-03-08', '02:30'],
    ['2026-11-01', '01:30'],
  ]) {
    const cfg = config({ habits: { h: { mode: 'timed', startDate: date, time, duration: 30 } } });
    assert.throws(() => projectEvents(state, cfg, date, date), /nonexistent|ambiguous/);
  }
  const cfg = config({
    habits: { h: { mode: 'timed', startDate: '2026-03-07', time: '02:30', duration: 30 } },
  });
  assert.throws(() => projectEvents(state, cfg, '2026-03-07', '2026-03-09'), /nonexistent/);
  const valid = config({
    habits: { h: { mode: 'timed', startDate: '2026-03-07', time: '09:00', duration: 30 } },
  });
  assert.equal(
    projectEvents(state, valid, '2026-03-07', '2026-03-09')[0].event.start.dateTime,
    '2026-03-07T14:00:00.000Z',
  );
});

test('fingerprint ignores provider and ownership metadata but detects managed changes', () => {
  const event = project()[0].event;
  const response = {
    ...event,
    id: 'provider',
    etag: 'abc',
    status: 'confirmed',
    transparency: undefined,
    start: { dateTime: '2026-10-18T09:00:00+07:00' },
    end: { dateTime: '2026-10-18T10:00:00+07:00' },
    extendedProperties: { private: { syntrop_hash: 'changed' } },
    reminders: { useDefault: false, overrides: [] },
  };
  assert.equal(eventFingerprint(response), eventFingerprint(event));
  for (const patch of [
    { summary: 'Changed' },
    { visibility: 'public' },
    { transparency: 'transparent' },
    { reminders: { useDefault: true } },
  ])
    assert.notEqual(eventFingerprint({ ...event, ...patch }), eventFingerprint(event));
});

test('separate sessions never deduplicate by title; explicit project palettes and midnight overlap survive projection', () => {
  const base = snapshot();
  const state = snapshot({
    projects: [
      { id: 'p', status: 'active' },
      { id: 'q', status: 'active' },
    ],
    tasks: [base.tasks[0], { ...base.tasks[0], id: 'other', project_id: 'q' }],
    work_sessions: [
      {
        ...base.work_sessions[0],
        id: 'night',
        start_at: '2026-10-17T16:30:00Z',
        end_at: '2026-10-17T17:30:00Z',
      },
      {
        ...base.work_sessions[0],
        id: 'second',
        start_at: '2026-10-19T02:00:00Z',
        end_at: '2026-10-19T03:00:00Z',
      },
      { ...base.work_sessions[0], id: 'other-session', task_id: 'other' },
    ],
  });
  const cfg = config({ categories: { p: 'career', q: 'oss' } });
  const all = projectEvents(state, cfg, '2026-10-17', '2026-10-23', { 9: {}, 3: {} });
  assert.equal(new Set(all.map((item) => item.event.id)).size, 3);
  assert.deepEqual(Object.fromEntries(all.map((item) => [item.key, item.event.colorId])), {
    'session:night': '9',
    'session:second': '9',
    'session:other-session': '3',
  });
  const overlap = projectEvents(
    { ...state, work_sessions: [state.work_sessions[0]] },
    cfg,
    '2026-10-18',
    '2026-10-18',
  );
  assert.equal(overlap.length, 1);
  assert.equal(
    new Date(overlap[0].event.end.dateTime) - new Date(overlap[0].event.start.dateTime),
    3600000,
  );
  for (const status of ['done', 'cancelled'])
    assert.deepEqual(
      projectEvents(
        { ...state, work_sessions: [], tasks: [{ ...base.tasks[0], status }] },
        config({ deadlines: true }),
        '2026-10-17',
        '2026-10-23',
      ),
      [],
    );
});
