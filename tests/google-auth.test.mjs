import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  linkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import {
  connect,
  disconnect,
  FREEBUSY_SCOPE,
  getAccessToken,
  GOOGLE_SCOPE,
  integrationHome,
  readPrivate,
  removePrivate,
  setupClient,
  status,
  writePrivate,
} from '../src/google-auth.ts';
import { GoogleApiError, GoogleClient } from '../src/google-client.ts';
const client = {
  installed: {
    client_id: 'synthetic.apps.googleusercontent.com',
    client_secret: 'synthetic-client-secret',
    auth_uri: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
  },
};
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'syntrop-oauth-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'private');
  const clientFile = join(root, 'synthetic-client.json');
  writeFileSync(clientFile, JSON.stringify(client));
  return { root, home, clientFile };
}
function credentials(home, expires = Date.now() + 3_600_000) {
  writePrivate(home, 'tokens.json', {
    access_token: 'synthetic-access-token',
    refresh_token: 'synthetic-refresh-token',
    scope: GOOGLE_SCOPE,
    token_type: 'Bearer',
    expires_at: expires,
  });
}
function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
function responseTokens(scope = GOOGLE_SCOPE) {
  return {
    access_token: 'synthetic-new-access',
    refresh_token: 'synthetic-new-refresh',
    expires_in: 3600,
    token_type: 'Bearer',
    scope,
  };
}
test('safe empty status, Desktop setup, restrictive files and workspace/source exclusion', (t) => {
  const { root, home, clientFile } = fixture(t);
  assert.deepEqual(status(home), {
    clientConfigured: false,
    connected: false,
    scopes: [],
    expiresAt: null,
  });
  assert.equal(existsSync(home), false);
  setupClient(home, clientFile);
  assert.equal(status(home).clientConfigured, true);
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.equal(statSync(join(home, 'oauth-client.json')).mode & 0o777, 0o600);
  writeFileSync(
    clientFile,
    JSON.stringify({ installed: { ...client.installed, token_uri: 'https://example.com/steal' } }),
  );
  assert.throws(() => setupClient(home, clientFile), /unmodified Google/);
  const prior = process.env.SYNTROP_GOOGLE_HOME;
  try {
    process.env.SYNTROP_GOOGLE_HOME = join(root, 'workspace', 'secrets');
    assert.throws(() => integrationHome(join(root, 'workspace')), /outside/);
    process.env.SYNTROP_GOOGLE_HOME = process.cwd();
    assert.throws(() => integrationHome(join(root, 'workspace')), /outside/);
    process.env.SYNTROP_GOOGLE_HOME = home;
    assert.equal(integrationHome(join(root, 'workspace')), home);
  } finally {
    if (prior === undefined) delete process.env.SYNTROP_GOOGLE_HOME;
    else process.env.SYNTROP_GOOGLE_HOME = prior;
  }
});
test('private storage refuses symlinks, hard links, loose permissions, traversal', (t) => {
  const { root, home } = fixture(t);
  writePrivate(home, 'tokens.json', { synthetic: true });
  assert.throws(() => writePrivate(home, '../escape', {}), /filename/);
  chmodSync(join(home, 'tokens.json'), 0o644);
  assert.throws(() => readPrivate(home, 'tokens.json'), /permissions/);
  chmodSync(join(home, 'tokens.json'), 0o600);
  const linked = join(root, 'linked');
  symlinkSync(home, linked);
  assert.throws(() => readPrivate(linked, 'tokens.json'), /symlink/);
  symlinkSync(join(home, 'tokens.json'), join(home, 'alias.json'));
  assert.throws(() => readPrivate(home, 'alias.json'), /safely/);
  linkSync(join(home, 'tokens.json'), join(root, 'hardlink'));
  assert.throws(() => readPrivate(home, 'tokens.json'), /hard links/);
  rmSync(join(root, 'hardlink'));
  chmodSync(home, 0o755);
  assert.throws(() => readPrivate(home, 'tokens.json'), /0700/);
});
test('access token refresh handles expiry, no-write previews, missing scopes and invalid_grant safely', async (t) => {
  const { home, clientFile } = fixture(t);
  setupClient(home, clientFile);
  await assert.rejects(getAccessToken(home), /not connected/);
  credentials(home, 0);
  const before = readFileSync(join(home, 'tokens.json'), 'utf8');
  let calls = 0;
  const fetcher = async (url, opts) => {
    calls++;
    assert.equal(String(url), 'https://oauth2.googleapis.com/token');
    assert.equal(opts.body.get('grant_type'), 'refresh_token');
    return json(responseTokens());
  };
  assert.equal(
    await getAccessToken(home, { persist: false, fetch: fetcher }),
    'synthetic-new-access',
  );
  assert.equal(readFileSync(join(home, 'tokens.json'), 'utf8'), before);
  assert.equal(await getAccessToken(home, { fetch: fetcher }), 'synthetic-new-access');
  assert.equal(readPrivate(home, 'tokens.json').refresh_token, 'synthetic-new-refresh');
  assert.equal(await getAccessToken(home, { fetch: fetcher }), 'synthetic-new-access');
  assert.equal(calls, 2);
  await assert.rejects(
    getAccessToken(home, {
      forceRefresh: true,
      fetch: async () =>
        json({ error: 'invalid_grant', error_description: 'NEVER-ECHO-SECRET' }, 400),
    }),
    (e) => e.code === 'RECONNECT_REQUIRED' && !e.message.includes('NEVER-ECHO-SECRET'),
  );
  credentials(home, 0);
  await assert.rejects(
    getAccessToken(home, { fetch: async () => json(responseTokens(FREEBUSY_SCOPE)) }),
    /did not grant/,
  );
  writePrivate(home, 'tokens.json', {
    access_token: 'synthetic-access',
    refresh_token: 'synthetic-refresh',
    expires_at: Date.now() + 3_600_000,
    scope: FREEBUSY_SCOPE,
    token_type: 'Bearer',
  });
  await assert.rejects(getAccessToken(home), /missing calendar.app.created/);
});
test('Desktop connection binds random loopback, validates state and S256 PKCE, stores only granted credentials', async (t) => {
  const { home, clientFile } = fixture(t);
  setupClient(home, clientFile);
  let auth;
  const result = await connect(home, {
    freebusy: true,
    launchBrowser: false,
    timeoutMs: 2000,
    onUrl: (url) => {
      auth = new URL(url);
      assert.equal(auth.origin, 'https://accounts.google.com');
      assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(auth.searchParams.get('scope'), `${GOOGLE_SCOPE} ${FREEBUSY_SCOPE}`);
      const callback = new URL(auth.searchParams.get('redirect_uri'));
      assert.equal(callback.hostname, '127.0.0.1');
      assert.ok(Number(callback.port) > 0);
      callback.searchParams.set('state', auth.searchParams.get('state'));
      callback.searchParams.set('code', 'synthetic-code');
      void fetch(callback);
    },
    fetch: async (url, opts) => {
      assert.equal(opts.body.get('code'), 'synthetic-code');
      assert.equal(
        createHash('sha256').update(opts.body.get('code_verifier')).digest('base64url'),
        auth.searchParams.get('code_challenge'),
      );
      assert.equal(opts.redirect, 'error');
      return json(responseTokens(`${GOOGLE_SCOPE} ${FREEBUSY_SCOPE}`));
    },
  });
  assert.equal(result.connected, true);
  assert.deepEqual(result.scopes, [GOOGLE_SCOPE, FREEBUSY_SCOPE]);
  assert.ok(!JSON.stringify(result).includes('synthetic-'));
});
test('invalid OAuth state, denied consent, timeout and missing scopes never write credentials', async (t) => {
  const { home, clientFile } = fixture(t);
  setupClient(home, clientFile);
  let exchanges = 0;
  for (const mode of ['state', 'unicode', 'denied', 'timeout', 'scope']) {
    await assert.rejects(
      connect(home, {
        launchBrowser: false,
        timeoutMs: 80,
        onUrl: (url) => {
          if (mode === 'timeout') return;
          const auth = new URL(url),
            callback = new URL(auth.searchParams.get('redirect_uri'));
          callback.searchParams.set(
            'state',
            mode === 'state'
              ? 'wrong'
              : mode === 'unicode'
                ? 'é'.repeat(auth.searchParams.get('state').length)
                : auth.searchParams.get('state'),
          );
          callback.searchParams.set(
            mode === 'denied' ? 'error' : 'code',
            mode === 'denied' ? 'access_denied' : 'synthetic-code',
          );
          void fetch(callback);
        },
        fetch: async () => {
          exchanges++;
          return json(responseTokens(FREEBUSY_SCOPE));
        },
      }),
      /state|declined|timed out|did not grant/,
    );
    assert.equal(existsSync(join(home, 'tokens.json')), false);
  }
  assert.equal(exchanges, 1);
});
test('disconnect distinguishes local removal and failed remote revocation, preserves config and mappings', async (t) => {
  const { home, clientFile } = fixture(t);
  setupClient(home, clientFile);
  credentials(home);
  writePrivate(home, 'mapping.json', { calendar: 'synthetic-calendar' });
  assert.deepEqual(
    await disconnect(home, true, {
      fetch: async (url, opts) => {
        assert.equal(String(url), 'https://oauth2.googleapis.com/revoke');
        assert.equal(opts.body.get('token'), 'synthetic-refresh-token');
        return json({ error: 'synthetic-error' }, 503);
      },
    }),
    { localRemoved: true, revoked: false, revocationFailed: true },
  );
  assert.equal(status(home).connected, false);
  assert.equal(status(home).clientConfigured, true);
  assert.deepEqual(readPrivate(home, 'mapping.json'), { calendar: 'synthetic-calendar' });
  credentials(home);
  let calls = 0;
  await disconnect(home, false, {
    fetch: async () => {
      calls++;
      throw new Error('unexpected');
    },
  });
  assert.equal(calls, 0);
  removePrivate(home, 'mapping.json');
  assert.equal(readPrivate(home, 'mapping.json'), undefined);
});
test('HTTP client retries quota and backend errors, preserves pagination and If-Match, sanitizes failures', async (t) => {
  const { home } = fixture(t);
  credentials(home);
  const delays = [];
  const calls = [];
  const responses = [
    json({ error: { errors: [{ reason: 'rateLimitExceeded' }] } }, 403),
    json({ error: {} }, 429, { 'Retry-After': '0.01' }),
    json({ error: {} }, 503),
    json({ items: [{ id: 'synthetic-event' }], nextPageToken: 'synthetic-page' }),
  ];
  const api = new GoogleClient(home, {
    sleep: async (ms) => delays.push(ms),
    fetch: async (url, opts) => {
      calls.push([String(url), opts]);
      return responses.shift();
    },
  });
  const body = await api.request('GET', '/calendars/synthetic/events?pageToken=first');
  assert.equal(body.nextPageToken, 'synthetic-page');
  assert.equal(calls.length, 4);
  assert.equal(delays.length, 3);
  assert.ok(delays.every((x) => x <= 30000));
  assert.ok(calls.every((x) => x[1].headers.Authorization === 'Bearer synthetic-access-token'));
  const failed = new GoogleClient(home, {
    fetch: async (_url, options) => {
      assert.equal(options.headers['If-Match'], '"v1"');
      return json(
        { error: { message: 'NEVER-ECHO-TOKEN', errors: [{ reason: 'NEVER-ECHO-TOKEN' }] } },
        412,
      );
    },
  });
  await assert.rejects(
    failed.request(
      'PATCH',
      '/calendars/synthetic/events/event',
      { summary: 'synthetic' },
      { 'If-Match': '"v1"' },
    ),
    (e) =>
      e instanceof GoogleApiError && e.status === 412 && !e.message.includes('NEVER-ECHO-TOKEN'),
  );
  await assert.rejects(api.request('GET', '//example.com/steal'), /invalid_path/);
  await assert.rejects(api.request('GET', '/../../steal'), /invalid_path/);
});
test('HTTP client refreshes still-unexpired rejected token once; preview refresh never persists', async (t) => {
  const { home, clientFile } = fixture(t);
  setupClient(home, clientFile);
  credentials(home);
  const original = readFileSync(join(home, 'tokens.json'), 'utf8');
  let attempts = 0,
    refreshes = 0;
  const api = new GoogleClient(home, {
    persistTokens: false,
    fetch: async (url, opts) => {
      if (String(url).includes('oauth2.googleapis.com')) {
        refreshes++;
        return json(responseTokens());
      }
      attempts++;
      if (attempts === 1) return json({ error: {} }, 401);
      assert.equal(opts.headers.Authorization, 'Bearer synthetic-new-access');
      return json({ ok: true });
    },
  });
  assert.deepEqual(await api.request('GET', '/colors'), { ok: true });
  assert.equal(refreshes, 1);
  assert.equal(readFileSync(join(home, 'tokens.json'), 'utf8'), original);
});
test('HTTP client never replays uncertain calendar creation; retries stable event insert only', async (t) => {
  const { home } = fixture(t);
  credentials(home);
  let calls = 0;
  const api = new GoogleClient(home, {
    sleep: async () => {},
    fetch: async () => {
      calls++;
      return json({ error: {} }, 503);
    },
  });
  await assert.rejects(
    api.request('POST', '/calendars', { summary: 'synthetic' }),
    (e) => e.status === 503,
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    api.request('POST', '/calendars/synthetic/events', { id: 'synthetic-stable' }),
    (e) => e.status === 503,
  );
  assert.equal(calls, 5);
  calls = 0;
  await assert.rejects(
    api.request('POST', '/calendars/synthetic/events', { summary: 'no-stable-id' }),
    (e) => e.status === 503,
  );
  assert.equal(calls, 1);
  const network = new GoogleClient(home, {
    fetch: async () => {
      throw new Error('NEVER-ECHO-TOKEN');
    },
  });
  await assert.rejects(
    network.request('GET', '/colors'),
    (e) => e.status === 0 && !e.message.includes('NEVER-ECHO-TOKEN'),
  );
});

test('OAuth callback rejects mismatched Host and absolute request origin without consuming legitimate authorization', async (t) => {
  const { home, clientFile } = fixture(t);
  setupClient(home, clientFile);
  let exchanges = 0;
  let interaction;
  const callbackRequest = (url, options = {}) =>
    new Promise((resolve, reject) => {
      const req = request(url, options, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      req.on('error', reject);
      req.end();
    });
  const result = await connect(home, {
    launchBrowser: false,
    timeoutMs: 2000,
    onUrl: (url) => {
      const auth = new URL(url);
      const callback = new URL(auth.searchParams.get('redirect_uri'));
      callback.searchParams.set('state', auth.searchParams.get('state'));
      callback.searchParams.set('code', 'synthetic-legitimate-code');
      interaction = (async () => {
        assert.equal(
          await callbackRequest(callback, { headers: { Host: 'attacker.invalid' } }),
          400,
        );
        assert.equal(
          await callbackRequest(callback, {
            path: `http://attacker.invalid${callback.pathname}${callback.search}`,
          }),
          400,
        );
        assert.equal(await callbackRequest(callback), 200);
      })();
      void interaction.catch(() => {});
    },
    fetch: async (_url, options) => {
      exchanges++;
      assert.equal(options.body.get('code'), 'synthetic-legitimate-code');
      return json(responseTokens());
    },
  });
  await interaction;
  assert.equal(result.connected, true);
  assert.equal(exchanges, 1);
});
