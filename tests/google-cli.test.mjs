import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { writePrivate } from '../src/google-auth.ts';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'syntrop-google-cli-')));
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
  let preload;
  function call(...args) {
    const result = spawnSync(
      process.execPath,
      [
        ...(preload ? ['--import', preload] : []),
        resolve('src/cli.ts'),
        '--workspace',
        workspace,
        '--json',
        ...args,
      ],
      { encoding: 'utf8', env: { ...process.env, SYNTROP_GOOGLE_HOME: home } },
    );
    return {
      status: result.status,
      value: result.stdout.trim() ? JSON.parse(result.stdout) : null,
      error: (() => {
        try {
          return result.stderr.trim() ? JSON.parse(result.stderr) : null;
        } catch {
          return result.stderr;
        }
      })(),
    };
  }
  function ok(...args) {
    const r = call(...args);
    assert.equal(r.status, 0, JSON.stringify(r));
    return r.value;
  }
  ok('init', '--timezone', 'Asia/Jakarta');
  function authenticate() {
    ok('integration', 'google', 'setup', '--client', client);
    writePrivate(home, 'tokens.json', {
      access_token: 'SYNTHETIC_ACCESS_NEVER_REAL',
      refresh_token: 'SYNTHETIC_REFRESH_NEVER_REAL',
      expires_at: new Date('2099-01-01T00:00:00Z').getTime(),
      scope:
        'https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/calendar.events.freebusy',
      token_type: 'Bearer',
    });
    const remote = join(root, 'fake-remote.json');
    writeFileSync(remote, JSON.stringify({ calendars: {}, writes: 0 }));
    preload = join(root, 'fake-fetch.mjs');
    writeFileSync(
      preload,
      `import { readFileSync, writeFileSync } from 'node:fs';
const file = ${JSON.stringify(remote)};
const NativeDate=Date; globalThis.Date=class extends NativeDate { constructor(...args){super(...(args.length?args:['2026-10-17T12:00:00Z']));} static now(){return new NativeDate('2026-10-17T12:00:00Z').getTime();} };
globalThis.fetch = async (input, options = {}) => {
 const url = new URL(input); if (url.origin !== 'https://www.googleapis.com') throw Error('Unexpected external service');
 const path = url.pathname.replace('/calendar/v3', ''); const method = options.method ?? 'GET';
 const state = JSON.parse(readFileSync(file, 'utf8')); const body = options.body ? JSON.parse(options.body) : {};
 const reply = (value, status=200) => new Response(status===204?null:JSON.stringify(value), {status,headers:{'content-type':'application/json'}});
 const commit = value => {state.writes++; writeFileSync(file,JSON.stringify(state)); return reply(value);};
 if (path==='/colors') return reply({event:{'1':{},'3':{},'7':{},'8':{},'9':{},'10':{}}});
 if (path==='/freeBusy') return reply({calendars:Object.fromEntries(body.items.map(i=>[i.id,{busy:[{start:body.timeMin,end:body.timeMax}]}]))});
 if (path==='/calendars' && method==='POST') {const id='synthetic'+Object.keys(state.calendars).length+'@example.invalid';state.calendars[id]={...body,id,events:{}};return commit(state.calendars[id]);}
 const match=new RegExp('^/calendars/([^/]+)(?:/events(?:/([^/]+))?)?$').exec(path); if(!match)return reply({},404);
 const calendar=state.calendars[decodeURIComponent(match[1])];if(!calendar)return reply({},404);
 if(!path.includes('/events'))return reply(calendar);
 const id=match[2]?decodeURIComponent(match[2]):body.id;
 if(method==='GET')return reply(id?calendar.events[id]??{}:{items:Object.values(calendar.events)},id&&!calendar.events[id]?404:200);
 if(method==='POST'){if(calendar.events[id])return reply({},409);calendar.events[id]={...body,etag:'"v1"'};return commit(calendar.events[id]);}
 if(!calendar.events[id])return reply({},404);
 if(options.headers['If-Match']!==calendar.events[id].etag)return reply({},412);
 if(method==='PUT'){calendar.events[id]={...body,etag:'"v'+(state.writes+1)+'"'};return commit(calendar.events[id]);}
 if(method==='DELETE'){calendar.events[id].status='cancelled';return commit(calendar.events[id]);}
 return reply({},400);
};`,
    );
    return remote;
  }
  return { root, home, workspace, client, call, ok, authenticate };
}

test('fresh CLI setup/status and offline preview require no credentials or network; core backup excludes integration secrets', (t) => {
  const f = fixture(t);
  const initial = f.ok('integration', 'google', 'status');
  assert.equal(initial.connected, false);
  assert.equal(existsSync(f.home), false);
  assert.equal(f.ok('integration', 'google', 'setup').clientConfigured, false);
  const missing = f.call('integration', 'google', 'preview');
  assert.notEqual(missing.status, 0);
  assert.doesNotMatch(JSON.stringify(missing), /SYNTHETIC_REFRESH/);
  const task = f.ok('task', 'add', '--title', 'Private user@example.invalid details');
  f.ok(
    'schedule',
    'add',
    '--task',
    task.id,
    '--start',
    '2026-10-20T09:00+07:00',
    '--end',
    '2026-10-20T10:00+07:00',
  );
  const habit = f.ok('habit', 'add', '--name', 'Reading');
  f.ok(
    'integration',
    'google',
    'habit',
    '--id',
    habit.id,
    '--mode',
    'flexible',
    '--start-date',
    '2026-10-20',
  );
  const offline = f.ok(
    'integration',
    'google',
    'preview',
    '--offline',
    '--from',
    '2026-10-20',
    '--through',
    '2026-10-21',
  );
  assert.equal(offline.remoteChecked, false);
  assert.equal(offline.approval, null);
  assert.equal(offline.events.length, 2);
  assert.doesNotMatch(JSON.stringify(offline), /user@example|Private/);
  const unsafeClient = join(f.workspace, 'downloaded-client.json');
  writeFileSync(unsafeClient, readFileSync(f.client));
  assert.equal(f.call('integration', 'google', 'setup', '--client', unsafeClient).status, 2);
  unlinkSync(unsafeClient);
  f.authenticate();
  const backup = join(f.root, 'backup');
  f.ok('backup', '--to', backup);
  assert.equal(existsSync(join(backup, 'tokens.json')), false);
  assert.equal(existsSync(join(backup, 'google')), false);
  assert.doesNotMatch(
    JSON.stringify(f.ok('export')),
    /SYNTHETIC_ACCESS|SYNTHETIC_REFRESH|client_secret/,
  );
  assert.equal(f.ok('validate').ok, true);
});

test('real CLI parser to mocked HTTP: preview zero writes, approval, repeat, move, cancellation, external availability and disconnect', (t) => {
  const f = fixture(t);
  const remote = f.authenticate();
  const task = f.ok('task', 'add', '--title', 'Write fix');
  const session = f.ok(
    'schedule',
    'add',
    '--task',
    task.id,
    '--start',
    '2026-10-20T09:00+07:00',
    '--end',
    '2026-10-20T10:00+07:00',
  );
  const before = Object.fromEntries(
    readdirSync(f.home).map((name) => [name, readFileSync(join(f.home, name), 'utf8')]),
  );
  const preview = f.ok(
    'integration',
    'google',
    'preview',
    '--from',
    '2026-10-20',
    '--through',
    '2026-10-21',
  );
  assert.equal(preview.summary.create, 1);
  assert.equal(JSON.parse(readFileSync(remote)).writes, 0);
  assert.deepEqual(
    Object.fromEntries(
      readdirSync(f.home).map((name) => [name, readFileSync(join(f.home, name), 'utf8')]),
    ),
    before,
  );
  const stale = f.call(
    'integration',
    'google',
    'sync',
    '--from',
    '2026-10-20',
    '--through',
    '2026-10-21',
    '--approve',
    'wrong',
  );
  assert.equal(stale.status, 3);
  assert.equal(JSON.parse(readFileSync(remote)).writes, 0);
  let result = f.ok(
    'integration',
    'google',
    'sync',
    '--from',
    '2026-10-20',
    '--through',
    '2026-10-21',
    '--approve',
    preview.approval,
  );
  assert.equal(result.created, 1);
  let next = f.ok(
    'integration',
    'google',
    'preview',
    '--from',
    '2026-10-20',
    '--through',
    '2026-10-21',
  );
  result = f.ok(
    'integration',
    'google',
    'sync',
    '--from',
    '2026-10-20',
    '--through',
    '2026-10-21',
    '--approve',
    next.approval,
  );
  assert.equal(result.unchanged, 1);
  assert.equal(result.created, 0);
  const first = JSON.parse(readFileSync(remote));
  const calendar = Object.keys(first.calendars)[0];
  const eventId = Object.keys(first.calendars[calendar].events)[0];
  f.ok(
    'schedule',
    'move',
    session.id,
    '--start',
    '2026-10-20T11:00+07:00',
    '--end',
    '2026-10-20T12:00+07:00',
    '--expected-version',
    '1',
  );
  next = f.ok(
    'integration',
    'google',
    'preview',
    '--from',
    '2026-10-20',
    '--through',
    '2026-10-21',
  );
  result = f.ok(
    'integration',
    'google',
    'sync',
    '--from',
    '2026-10-20',
    '--through',
    '2026-10-21',
    '--approve',
    next.approval,
  );
  assert.equal(result.updated, 1);
  assert.equal(
    Object.keys(JSON.parse(readFileSync(remote)).calendars[calendar].events)[0],
    eventId,
  );
  const busy = f.ok(
    'integration',
    'google',
    'availability',
    '--calendars',
    'primary',
    '--start',
    '2026-10-20T09:00+07:00',
    '--end',
    '2026-10-20T12:00+07:00',
  );
  assert.equal(busy.titlesRead, false);
  assert.equal(busy.externalBusy.primary.length, 1);
  assert.notEqual(
    f.call(
      'integration',
      'google',
      'availability',
      '--calendars',
      calendar,
      '--start',
      '2026-10-20T09:00+07:00',
      '--end',
      '2026-10-20T12:00+07:00',
    ).status,
    0,
  );
  f.ok('schedule', 'cancel', session.id, '--expected-version', '2');
  next = f.ok(
    'integration',
    'google',
    'preview',
    '--from',
    '2026-10-20',
    '--through',
    '2026-10-21',
  );
  result = f.ok(
    'integration',
    'google',
    'sync',
    '--from',
    '2026-10-20',
    '--through',
    '2026-10-21',
    '--approve',
    next.approval,
  );
  assert.equal(result.cancelled, 1);
  const operational = f.ok('export').data;
  f.ok('integration', 'google', 'disconnect');
  assert.equal(f.ok('integration', 'google', 'status').connected, false);
  assert.deepEqual(f.ok('export').data, operational);
});

test('CLI integration disconnect respects active lock, and lost registry never blindly reprovisions calendars', (t) => {
  const f = fixture(t);
  f.authenticate();
  writeFileSync(join(f.home, 'operation.lock'), 'synthetic active operation', { mode: 0o600 });
  assert.equal(f.call('integration', 'google', 'disconnect').status, 3);
  assert.equal(f.ok('integration', 'google', 'status').connected, true);
  unlinkSync(join(f.home, 'operation.lock'));
  const settings = JSON.parse(readFileSync(join(f.home, 'config.json')));
  settings.provisioned = true;
  writePrivate(f.home, 'config.json', settings);
  const lost = f.call('integration', 'google', 'preview');
  assert.notEqual(lost.status, 0);
  assert.match(lost.error.error.message, /recover/i);
});
