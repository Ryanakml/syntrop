import test from 'node:test';
import assert from 'node:assert/strict';
import { planSync, applySync, listEvents } from '../src/google-sync.ts';
import { eventFingerprint } from '../src/google-projection.ts';

const clone = structuredClone;
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
const config = (patch = {}) => ({
  workspaceId: 'test-workspace',
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
  tasks: [{ id: 't', title: 'Sensitive title', status: 'todo', project_id: 'p' }],
  work_sessions: [
    {
      id: 's',
      task_id: 't',
      status: 'scheduled',
      start_at: '2026-10-18T02:00:00Z',
      end_at: '2026-10-18T03:00:00Z',
      version: 1,
    },
  ],
  calendar_events: [],
  habits: [],
  ...patch,
});

// Stateful Calendar double: PUT replaces fields, PATCH preserves omitted fields, IDs remain reserved
// after deletion, If-Match is enforced, and reads return provider-owned etags.
class FakeGoogle {
  calendars = new Map();
  calls = [];
  serial = 0;
  pageSize = 2;
  uncertain = false;
  colors = { 1: {}, 10: {} };
  addCalendar(id) {
    this.calendars.set(id, new Map());
  }
  put(calendar, event) {
    const stored = {
      ...clone(event),
      etag: `"${++this.serial}"`,
      status: event.status ?? 'confirmed',
    };
    this.calendars.get(calendar).set(stored.id, stored);
    return stored;
  }
  async request(method, path, body, headers) {
    this.calls.push({ method, path, body: clone(body), headers: clone(headers) });
    const url = new URL(path, 'https://calendar.invalid');
    if (path === '/colors') return { event: clone(this.colors) };
    if (method === 'POST' && path === '/calendars') {
      const id = `calendar-${this.calendars.size + 1}`;
      this.addCalendar(id);
      return { id };
    }
    const match = url.pathname.match(/^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
    if (!match) throw new Error(`Unexpected request ${method} ${path}`);
    const calendar = decodeURIComponent(match[1]);
    const id = match[2] && decodeURIComponent(match[2]);
    const events = this.calendars.get(calendar);
    if (!events) throw httpError(404);
    if (method === 'GET' && !id) {
      const start = Number(url.searchParams.get('pageToken') ?? 0);
      const all = [...events.values()];
      return {
        items: clone(all.slice(start, start + this.pageSize)),
        ...(start + this.pageSize < all.length
          ? { nextPageToken: String(start + this.pageSize) }
          : {}),
      };
    }
    if (method === 'GET') {
      if (!events.has(id)) throw httpError(404);
      return clone(events.get(id));
    }
    if (method === 'POST') {
      if (events.has(body.id)) throw httpError(409);
      const saved = this.put(calendar, body);
      if (this.uncertain) {
        this.uncertain = false;
        throw new Error('Connection lost after remote commit');
      }
      return clone(saved);
    }
    if (!events.has(id)) throw httpError(404);
    if (headers?.['If-Match'] !== events.get(id).etag) throw httpError(412);
    if (method === 'PUT') return clone(this.put(calendar, { ...clone(body), id }));
    if (method === 'PATCH') return clone(this.put(calendar, { ...events.get(id), ...clone(body) }));
    if (method === 'DELETE') {
      this.put(calendar, { ...events.get(id), status: 'cancelled' });
      return {};
    }
    throw new Error(`Unexpected request ${method}`);
  }
}

function harness(state = snapshot(), cfg = config()) {
  const provider = new FakeGoogle();
  const registry = { workspaceId: cfg.workspaceId };
  const mappings = {};
  const saves = { registry: [], mappings: [] };
  const plan = (resolve = false, current = state) =>
    planSync(
      provider,
      current,
      cfg,
      registry,
      mappings,
      '2026-10-17',
      '2026-10-23',
      resolve,
      '2026-10-17T00:00:00Z',
    );
  const apply = (value) =>
    applySync(
      provider,
      value,
      registry,
      mappings,
      state.timezone,
      (r) => saves.registry.push(clone(r)),
      (m) => saves.mappings.push(clone(m)),
    );
  const remote = (key = 'session:s') =>
    provider.calendars.get(mappings[key].calendarId).get(mappings[key].eventId);
  return { provider, registry, mappings, saves, plan, apply, remote, state, cfg };
}
async function published(state, cfg) {
  const h = harness(state, cfg);
  await h.apply(await h.plan());
  return h;
}
const writes = (provider) => provider.calls.filter((call) => call.method !== 'GET');

test('first publication provisions only needed secondary calendars and repeated sync has no event writes', async () => {
  const h = harness();
  const initial = await h.plan();
  assert.deepEqual(initial.calendarsToCreate, ['focus']);
  assert.equal(writes(h.provider).length, 0);
  const result = await h.apply(initial);
  assert.equal(result.created, 1);
  assert.equal(h.saves.registry[0].pending, 'focus');
  assert.equal(h.registry.pending, undefined);
  const count = writes(h.provider).length;
  for (let i = 0; i < 3; i++) {
    const plan = await h.plan();
    assert.equal(plan.summary.unchanged, 1);
    assert.equal((await h.apply(plan)).unchanged, 1);
  }
  assert.equal(writes(h.provider).length, count);
  assert.equal(h.provider.calendars.size, 1);
  assert.equal(h.provider.calendars.get(h.registry.focus).size, 1);
});

test('moving a tracked session beyond the publication window updates its same remote ID', async () => {
  const h = await published();
  const id = h.remote().id;
  h.state.work_sessions[0].start_at = '2027-01-01T02:00:00Z';
  h.state.work_sessions[0].end_at = '2027-01-01T03:00:00Z';
  h.state.work_sessions[0].version++;
  const plan = await h.plan();
  assert.equal(plan.summary.update, 1);
  assert.equal(plan.actions[0].remoteId, id);
  assert.equal((await h.apply(plan)).updated, 1);
  assert.equal(h.remote().id, id);
  assert.equal(h.remote().start.dateTime, '2027-01-01T02:00:00.000Z');
});

test('local cancellation affects only future owned projections and preserves past/unrelated events', async () => {
  const state = snapshot();
  state.work_sessions.push({
    ...state.work_sessions[0],
    id: 'past',
    start_at: '2026-10-16T02:00:00Z',
    end_at: '2026-10-16T03:00:00Z',
  });
  const h = harness(state);
  await h.apply(
    await planSync(h.provider, state, h.cfg, h.registry, h.mappings, '2026-10-15', '2026-10-23'),
  );
  const unrelated = h.provider.put(h.registry.focus, {
    id: 'personal-event',
    summary: 'Private appointment',
    start: { dateTime: '2026-10-18T04:00:00Z' },
    end: { dateTime: '2026-10-18T05:00:00Z' },
  });
  const pastId = h.mappings['session:past'].eventId;
  state.work_sessions.forEach((s) => (s.status = 'cancelled'));
  const plan = await h.plan();
  assert.equal(plan.summary.cancel, 1);
  assert.equal(plan.summary.skip, 1);
  assert.equal((await h.apply(plan)).cancelled, 1);
  assert.equal(h.provider.calendars.get(h.registry.focus).get(pastId).status, 'confirmed');
  assert.deepEqual(h.provider.calendars.get(h.registry.focus).get('personal-event'), unrelated);
  assert.equal(h.provider.calls.filter((c) => c.method === 'DELETE').length, 1);
});

test('lost mappings recover from ownership properties without duplicating existing events', async () => {
  const h = await published();
  const id = h.remote().id;
  delete h.mappings['session:s'];
  const plan = await h.plan();
  assert.equal(plan.summary.unchanged, 1);
  await h.apply(plan);
  assert.equal(h.mappings['session:s'].eventId, id);
  assert.equal(h.provider.calendars.get(h.registry.focus).size, 1);
});

test('manual remote edits conflict and require explicit local resolution', async () => {
  const h = await published();
  h.provider.put(h.registry.focus, { ...h.remote(), summary: 'Manual title' });
  const conflict = await h.plan();
  assert.equal(conflict.summary.conflict, 1);
  const count = writes(h.provider).length;
  assert.equal((await h.apply(conflict)).conflicted, 1);
  assert.equal(writes(h.provider).length, count);
  const restore = await h.plan(true);
  assert.equal(restore.summary.update, 1);
  await h.apply(restore);
  assert.equal(h.remote().summary, 'Focus');
  assert.equal((await h.plan()).summary.unchanged, 1);
});

test('remote deletion conflicts, explicit replacement gets a stable reserved-ID-safe identity', async () => {
  const h = await published();
  const old = h.remote().id;
  h.provider.put(h.registry.focus, { ...h.remote(), status: 'cancelled' });
  assert.equal((await h.plan()).summary.conflict, 1);
  const restore = await h.plan(true);
  assert.equal(restore.summary.create, 1);
  assert.notEqual(restore.actions[0].event.id, old);
  assert.equal((await h.apply(restore)).created, 1);
  const replacement = h.remote().id;
  assert.equal((await h.plan()).summary.unchanged, 1);
  await h.apply(await h.plan());
  assert.equal(h.remote().id, replacement);
});

test('lost mappings plus a minimal provider tombstone still require explicit deletion recovery', async () => {
  const h = await published();
  const oldId = h.remote().id;
  h.provider.calendars
    .get(h.registry.focus)
    .set(oldId, { id: oldId, status: 'cancelled', etag: '"deleted"' });
  delete h.mappings['session:s'];
  const preview = await h.plan();
  assert.equal(preview.summary.conflict, 1);
  assert.equal(preview.summary.create, 0);
  const restore = await h.plan(true);
  assert.equal(restore.summary.create, 1);
  assert.notEqual(restore.actions[0].event.id, oldId);
  assert.equal((await h.apply(restore)).created, 1);
  assert.equal((await h.plan()).summary.unchanged, 1);
});

test('uncertain successful remote creation is recovered without a duplicate on retry', async () => {
  const h = harness();
  h.provider.uncertain = true;
  assert.equal((await h.apply(await h.plan())).failed, 1);
  assert.deepEqual(h.mappings, {});
  const recovery = await h.plan();
  assert.equal(recovery.summary.unchanged, 1);
  await h.apply(recovery);
  assert.equal(h.provider.calendars.get(h.registry.focus).size, 1);
  assert.ok(h.mappings['session:s']);
});

test('partial apply retains verified progress and retries reconcile each source independently', async () => {
  const state = snapshot();
  state.work_sessions.push({
    ...state.work_sessions[0],
    id: 's2',
    start_at: '2026-10-19T02:00:00Z',
    end_at: '2026-10-19T03:00:00Z',
  });
  const h = harness(state);
  h.provider.uncertain = true;
  const result = await h.apply(await h.plan());
  assert.equal(result.failed, 1);
  assert.equal(result.created, 1);
  assert.deepEqual(Object.keys(h.mappings), ['session:s2']);
  assert.equal(h.provider.calendars.get(h.registry.focus).size, 2);
  const retry = await h.plan();
  assert.equal(retry.summary.unchanged, 2);
  await h.apply(retry);
  assert.equal(Object.keys(h.mappings).length, 2);
  assert.equal(h.provider.calendars.get(h.registry.focus).size, 2);
});

test('POST 409 is accepted only after ownership and body verification', async () => {
  const h = harness();
  const plan = await h.plan();
  h.provider.addCalendar('existing');
  h.registry.focus = 'existing';
  plan.calendarsToCreate = [];
  h.provider.put('existing', plan.actions[0].event);
  assert.equal((await h.apply(plan)).created, 1);
  const bad = harness();
  const badPlan = await bad.plan();
  bad.provider.addCalendar('existing');
  bad.registry.focus = 'existing';
  badPlan.calendarsToCreate = [];
  bad.provider.put('existing', { ...badPlan.actions[0].event, summary: 'Unapproved contents' });
  const result = await bad.apply(badPlan);
  assert.equal(result.failed, 1);
  assert.equal(result.failures[0].code, 'GOOGLE_VERIFY');
  assert.deepEqual(bad.mappings, {});
});

test('update 412 preserves the remote concurrent edit and old local mapping', async () => {
  const h = await published();
  const mapping = clone(h.mappings);
  h.state.work_sessions[0].end_at = '2026-10-18T04:00:00Z';
  const plan = await h.plan();
  const edited = h.provider.put(h.registry.focus, { ...h.remote(), summary: 'Concurrent edit' });
  const result = await h.apply(plan);
  assert.equal(result.conflicted, 1);
  assert.equal(result.failures[0].code, 'HTTP_412');
  assert.deepEqual(h.mappings, mapping);
  assert.deepEqual(h.remote(), edited);
});

test('unavailable provider colors reset the old managed color instead of retaining stale metadata', async () => {
  const h = await published();
  assert.equal(h.remote().colorId, '1');
  h.provider.colors = {};
  const plan = await h.plan();
  assert.equal(plan.summary.update, 1);
  assert.equal((await h.apply(plan)).updated, 1);
  assert.equal(h.remote().colorId, undefined);
  assert.equal(writes(h.provider).at(-1).method, 'PUT');
  assert.equal((await h.plan()).summary.unchanged, 1);
});

test('changing habit from timed to flexible replaces dateTime fields with dates on the same series ID', async () => {
  const state = snapshot({
    work_sessions: [],
    habits: [
      { id: 'h', name: 'Read', frequency: 'daily', active: 1, updated_at: '2026-10-17T00:00:00Z' },
    ],
  });
  const h = await published(
    state,
    config({
      habits: { h: { mode: 'timed', startDate: '2026-10-01', time: '09:00', duration: 30 } },
    }),
  );
  const id = h.remote('habit:h').id;
  h.cfg.habits.h = { mode: 'flexible', startDate: '2026-10-01' };
  const plan = await h.plan();
  assert.equal(plan.summary.update, 1);
  assert.equal((await h.apply(plan)).updated, 1);
  assert.equal(h.remote('habit:h').id, id);
  assert.deepEqual(h.remote('habit:h').start, { date: '2026-10-01' });
  assert.deepEqual(h.remote('habit:h').end, { date: '2026-10-02' });
  assert.equal(writes(h.provider).at(-1).method, 'PUT');
  assert.equal((await h.plan()).summary.unchanged, 1);
});

test('habit deactivation uses lifecycle time rather than an older display configuration timestamp', async () => {
  const state = snapshot({
    work_sessions: [],
    habits: [
      { id: 'h', name: 'Read', frequency: 'daily', active: 1, updated_at: '2026-10-01T00:00:00Z' },
    ],
  });
  const h = await published(
    state,
    config({
      habits: {
        h: {
          mode: 'timed',
          startDate: '2026-10-01',
          time: '09:00',
          duration: 30,
          changedAt: '2026-10-01T00:00:00Z',
        },
      },
    }),
  );
  state.habits[0].active = 0;
  state.habits[0].updated_at = '2026-10-17T00:00:00Z';
  const plan = await h.plan();
  assert.equal(plan.summary.update, 1);
  assert.equal(plan.summary.cancel, 0);
  assert.match(plan.actions[0].event.recurrence[0], /UNTIL=20261016T235959Z/);
  assert.equal((await h.apply(plan)).updated, 1);
  assert.equal((await h.plan()).summary.unchanged, 1);
});

test('pagination reads every page and rejects looping provider tokens', async () => {
  const provider = new FakeGoogle();
  provider.addCalendar('c');
  for (let i = 0; i < 7; i++) provider.put('c', { id: `e${i}` });
  assert.equal((await listEvents(provider, 'c')).length, 7);
  assert.equal(provider.calls.length, 4);
  await assert.rejects(
    listEvents({ request: async () => ({ items: [], nextPageToken: 'loop' }) }, 'c'),
    (e) => e.code === 'GOOGLE_PAGINATION',
  );
});

test('edited recurring instances block series changes even with explicit local resolution', async () => {
  const state = snapshot({
    work_sessions: [],
    habits: [
      { id: 'h', name: 'Read', frequency: 'daily', active: 1, updated_at: '2026-10-17T00:00:00Z' },
    ],
  });
  const h = await published(
    state,
    config({ habits: { h: { mode: 'flexible', startDate: '2026-10-01' } } }),
  );
  const parent = h.remote('habit:h');
  h.provider.put(h.registry.habits, {
    id: 'exception',
    recurringEventId: parent.id,
    summary: 'Moved occurrence',
  });
  const plan = await h.plan(true);
  assert.equal(plan.summary.conflict, 1);
  assert.match(plan.actions[0].reason, /instance/);
});

test('habit deactivation truncates recurrence, retains past series, and is idempotent', async () => {
  const state = snapshot({
    work_sessions: [],
    habits: [
      { id: 'h', name: 'Read', frequency: 'daily', active: 1, updated_at: '2026-10-17T00:00:00Z' },
    ],
  });
  const h = await published(
    state,
    config({
      habits: { h: { mode: 'timed', startDate: '2026-10-01', time: '09:00', duration: 30 } },
    }),
  );
  const original = clone(h.remote('habit:h'));
  state.habits[0].active = 0;
  const plan = await h.plan();
  assert.equal(plan.summary.update, 1);
  assert.equal(plan.summary.cancel, 0);
  assert.match(plan.actions[0].event.recurrence[0], /UNTIL=20261016T235959Z/);
  await h.apply(plan);
  assert.equal(h.remote('habit:h').id, original.id);
  assert.deepEqual(h.remote('habit:h').start, original.start);
  assert.equal(h.mappings['habit:h'].stopped, true);
  assert.equal((await h.plan()).summary.unchanged, 1);
  assert.equal(h.mappings['habit:h'].hash, eventFingerprint(h.remote('habit:h')));
});

test('uncertain calendar provisioning records pending recovery and forbids blind retries', async () => {
  const h = harness();
  const original = h.provider.request.bind(h.provider);
  h.provider.request = async (...args) => {
    const result = await original(...args);
    if (args[0] === 'POST' && args[1] === '/calendars') throw new Error('Lost calendar response');
    return result;
  };
  await assert.rejects(h.apply(await h.plan()), /Lost calendar response/);
  assert.equal(h.registry.pending, 'focus');
  await assert.rejects(h.plan(), (e) => e.code === 'GOOGLE_RECOVERY');
  assert.equal(h.provider.calendars.size, 1);
});

test('explicit local restoration clears unsupported remote extras instead of reporting a false successful resolution', async () => {
  const h = await published();
  h.provider.put(h.registry.focus, {
    ...h.remote(),
    location: 'Changed location',
    attendees: [{ email: 'someone@example.invalid' }],
  });
  assert.equal((await h.plan()).summary.conflict, 1);
  const result = await h.apply(await h.plan(true));
  assert.equal(result.updated, 1);
  assert.equal((await h.plan()).summary.conflict, 0);
  assert.equal((await h.plan()).summary.unchanged, 1);
});

test('future cancellation compares instants rather than RFC3339 offset strings', async () => {
  const h = await published();
  // Same instant and etag: the provider may return an equivalent offset spelling.
  h.remote().end.dateTime = '2026-10-17T22:00:00-05:00';
  h.state.work_sessions[0].status = 'cancelled';
  const plan = await planSync(
    h.provider,
    h.state,
    h.cfg,
    h.registry,
    h.mappings,
    '2026-10-17',
    '2026-10-23',
    false,
    '2026-10-18T02:30:00Z',
  );
  assert.equal(plan.summary.cancel, 1);
});
