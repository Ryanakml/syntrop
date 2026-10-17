import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
export const FREEBUSY_SCOPE = 'https://www.googleapis.com/auth/calendar.events.freebusy';
export const TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks';
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const REVOKE = 'https://oauth2.googleapis.com/revoke';
type Client = { client_id: string; client_secret?: string; auth_uri: string; token_uri: string };
type Tokens = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
  token_type: 'Bearer';
};
export class GoogleAuthError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'GoogleAuthError';
    this.code = code;
  }
}
function fail(code: string, message: string): never {
  throw new GoogleAuthError(code, message);
}
function within(path: string, root: string) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
function canonical(path: string): string {
  const p = resolve(path);
  if (existsSync(p)) return realpathSync(p);
  return join(canonical(dirname(p)), basename(p));
}
export function integrationHome(workspace: string): string {
  const ws = canonical(workspace);
  const source = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
  const home = process.env.SYNTROP_GOOGLE_HOME
    ? resolve(process.env.SYNTROP_GOOGLE_HOME)
    : join(
        homedir(),
        '.syntrop-google',
        createHash('sha256').update(ws).digest('hex').slice(0, 24),
      );
  const actual = canonical(home);
  if (within(actual, ws) || within(actual, source))
    fail(
      'UNSAFE_STORAGE',
      'Google integration storage must be outside the source repository and operational workspace.',
    );
  return home;
}
function assertDirectory(home: string, create = false) {
  const path = resolve(home);
  // Refuse redirected directories; do not follow links when opening secrets.
  for (let p = path; dirname(p) !== p; p = dirname(p)) {
    if (!existsSync(p)) {
      try {
        lstatSync(p);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw e;
      }
    }
    const stat = lstatSync(p);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      fail('UNSAFE_STORAGE', 'Google storage path contains a symlink or non-directory.');
  }
  if (!existsSync(path)) {
    if (!create) return false;
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const st = lstatSync(path);
  if ((process.getuid && st.uid !== process.getuid()) || st.mode & 0o077)
    fail(
      'UNSAFE_STORAGE',
      'Google storage must be owned by the current user with directory permissions 0700.',
    );
  return true;
}
function privatePath(home: string, name: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name.includes('..'))
    fail('UNSAFE_STORAGE', 'Invalid private filename.');
  return join(resolve(home), name);
}
export function readPrivate<T>(home: string, name: string): T | undefined {
  const path = privatePath(home, name);
  if (!assertDirectory(home)) return undefined;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    fail('UNSAFE_STORAGE', 'Cannot safely open Google private data.');
  }
  try {
    const st = fstatSync(fd);
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      (process.getuid && st.uid !== process.getuid()) ||
      st.mode & 0o077
    )
      fail(
        'UNSAFE_STORAGE',
        'Google private files require ownership, no hard links, and permissions 0600.',
      );
    if (st.size > 4 * 1024 * 1024)
      fail('UNSAFE_STORAGE', 'Google private file exceeds size limit.');
    try {
      return JSON.parse(readFileSync(fd, 'utf8')) as T;
    } catch {
      fail(
        'INVALID_PRIVATE_DATA',
        'Google integration data is invalid JSON; restore configuration or reconnect.',
      );
    }
  } finally {
    closeSync(fd);
  }
}
export function writePrivate(home: string, name: string, value: unknown): void {
  const path = privatePath(home, name);
  assertDirectory(home, true);
  // Existing unsafe files are rejected instead of overwritten.
  readPrivate(home, name);
  const temp = join(home, `${name}.${randomBytes(12).toString('hex')}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
  }
}
export function removePrivate(home: string, name: string) {
  const path = privatePath(home, name);
  if (readPrivate(home, name) !== undefined) unlinkSync(path);
}
function validateClient(value: unknown): Client {
  const raw = value as { installed?: Partial<Client> };
  const c = raw?.installed;
  if (
    !c ||
    typeof c.client_id !== 'string' ||
    !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(c.client_id) ||
    ![AUTH, 'https://accounts.google.com/o/oauth2/auth'].includes(String(c.auth_uri)) ||
    c.token_uri !== TOKEN ||
    (c.client_secret !== undefined && typeof c.client_secret !== 'string')
  )
    fail(
      'INVALID_CLIENT',
      'Use an unmodified Google OAuth Desktop app client JSON with official Google endpoints.',
    );
  return {
    client_id: c.client_id,
    ...(c.client_secret ? { client_secret: c.client_secret } : {}),
    auth_uri: AUTH,
    token_uri: TOKEN,
  };
}
export function setupClient(home: string, file: string): void {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    fail('INVALID_CLIENT', 'Cannot read Google OAuth Desktop client JSON.');
  }
  const client = validateClient(raw);
  const prior = readPrivate<{ installed: Client }>(home, 'oauth-client.json');
  if (prior && prior.installed.client_id !== client.client_id && readPrivate(home, 'tokens.json'))
    fail('CLIENT_CHANGED', 'Disconnect before replacing a connected OAuth client.');
  writePrivate(home, 'oauth-client.json', { installed: client });
}
function getClient(home: string) {
  const c = readPrivate(home, 'oauth-client.json');
  if (!c)
    fail(
      'CLIENT_MISSING',
      'Run integration google setup with a Google Desktop app client JSON first.',
    );
  return validateClient(c);
}
function getTokens(home: string, requireTasks = false): Tokens {
  const t = readPrivate<Tokens>(home, 'tokens.json');
  if (!t) fail('NOT_CONNECTED', 'Google is not connected. Run integration google connect.');
  if (
    typeof t.access_token !== 'string' ||
    !t.access_token ||
    typeof t.refresh_token !== 'string' ||
    !t.refresh_token ||
    !Number.isFinite(t.expires_at) ||
    t.token_type !== 'Bearer' ||
    typeof t.scope !== 'string'
  )
    fail('INVALID_TOKENS', 'Google credentials are invalid. Reconnect.');
  const granted = t.scope.split(' ');
  if (!granted.includes(GOOGLE_SCOPE))
    fail('MISSING_SCOPE', 'Google authorization is missing calendar.app.created; reconnect.');
  if (requireTasks && !granted.includes(TASKS_SCOPE))
    fail(
      'MISSING_SCOPE',
      'Google authorization is missing https://www.googleapis.com/auth/tasks; run integration google connect to grant Tasks permission.',
    );
  return t;
}
export function status(home: string) {
  const clientConfigured = !!readPrivate(home, 'oauth-client.json');
  const t = readPrivate<Tokens>(home, 'tokens.json');
  return {
    clientConfigured,
    connected:
      !!t &&
      typeof t.refresh_token === 'string' &&
      typeof t.scope === 'string' &&
      t.scope.split(' ').includes(GOOGLE_SCOPE),
    scopes:
      typeof t?.scope === 'string'
        ? t.scope
            .split(' ')
            .filter((s) => s === GOOGLE_SCOPE || s === FREEBUSY_SCOPE || s === TASKS_SCOPE)
        : [],
    expiresAt: t && Number.isFinite(t.expires_at) ? new Date(t.expires_at).toISOString() : null,
  };
}
async function tokenRequest(
  params: URLSearchParams,
  fetcher: typeof fetch,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetcher(TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
  } catch {
    fail(
      'OAUTH_NETWORK',
      'Google token request failed or timed out. Check connectivity and retry.',
    );
  }
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    fail('OAUTH_RESPONSE', 'Google token endpoint returned an invalid response.');
  }
  if (!res.ok) {
    if (body.error === 'invalid_grant')
      fail(
        'RECONNECT_REQUIRED',
        'Google authorization expired or was revoked (invalid_grant). Reconnect; external Testing-mode refresh tokens can expire after seven days.',
      );
    fail(
      'OAUTH_FAILED',
      `Google token request failed (HTTP ${res.status}). Check OAuth setup or reconnect.`,
    );
  }
  return body;
}
function tokensFrom(body: Record<string, unknown>, previous?: Tokens): Tokens {
  if (
    typeof body.access_token !== 'string' ||
    !body.access_token ||
    typeof body.expires_in !== 'number' ||
    !Number.isFinite(body.expires_in) ||
    body.expires_in <= 0 ||
    body.token_type !== 'Bearer'
  )
    fail('OAUTH_RESPONSE', 'Google returned an invalid token response.');
  const scope = typeof body.scope === 'string' ? body.scope : previous?.scope;
  const refresh =
    typeof body.refresh_token === 'string' ? body.refresh_token : previous?.refresh_token;
  if (!scope?.split(' ').includes(GOOGLE_SCOPE))
    fail(
      'MISSING_SCOPE',
      'Google did not grant calendar.app.created; reconnect and grant the required permission.',
    );
  if (!refresh)
    fail(
      'REFRESH_MISSING',
      'Google did not return offline authorization. Reconnect and consent again.',
    );
  return {
    access_token: body.access_token,
    refresh_token: refresh,
    scope,
    expires_at: Date.now() + body.expires_in * 1000,
    token_type: 'Bearer',
  };
}
export async function getAccessToken(
  home: string,
  options: {
    persist?: boolean;
    forceRefresh?: boolean;
    requireTasks?: boolean;
    fetch?: typeof fetch;
  } = {},
): Promise<string> {
  const t = getTokens(home, options.requireTasks);
  if (!options.forceRefresh && t.expires_at > Date.now() + 60_000) return t.access_token;
  const c = getClient(home);
  const params = new URLSearchParams({
    client_id: c.client_id,
    refresh_token: t.refresh_token,
    grant_type: 'refresh_token',
  });
  if (c.client_secret) params.set('client_secret', c.client_secret);
  const next = tokensFrom(await tokenRequest(params, options.fetch ?? fetch), t);
  if (options.requireTasks && !next.scope.split(' ').includes(TASKS_SCOPE))
    fail(
      'MISSING_SCOPE',
      'Google authorization is missing https://www.googleapis.com/auth/tasks; run integration google connect to grant Tasks permission.',
    );
  if (options.persist !== false) writePrivate(home, 'tokens.json', next);
  return next.access_token;
}
function openBrowser(url: string) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}
export async function connect(
  home: string,
  options: {
    freebusy?: boolean;
    tasks?: boolean;
    onUrl?: (url: string) => void;
    timeoutMs?: number;
    launchBrowser?: boolean;
    fetch?: typeof fetch;
  } = {},
) {
  const c = getClient(home);
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  let finish: (code: string) => void = () => {};
  let rejectCode: (err: Error) => void = () => {};
  const codePromise = new Promise<string>((resolve, reject) => {
    finish = resolve;
    rejectCode = reject;
  });
  // Attach a rejection handler while browser launch is pending.
  void codePromise.catch(() => {});
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const address = server.address();
    const expectedHost = address && typeof address !== 'string' ? `127.0.0.1:${address.port}` : '';
    const expectedOrigin = `http://${expectedHost}`;
    if (!expectedHost || req.headers.host !== expectedHost) {
      res.writeHead(400).end('Invalid callback host.');
      return;
    }
    let u: URL;
    try {
      u = new URL(req.url ?? '/', expectedOrigin);
    } catch {
      res.writeHead(400).end('Invalid callback.');
      return;
    }
    if (u.origin !== expectedOrigin || u.username || u.password) {
      res.writeHead(400).end('Invalid callback origin.');
      return;
    }
    if (req.method !== 'GET' || u.pathname !== '/oauth2callback') {
      res.writeHead(404).end('Not found.');
      return;
    }
    const received = u.searchParams.get('state') ?? '';
    if (
      Buffer.byteLength(received) !== Buffer.byteLength(state) ||
      !timingSafeEqual(Buffer.from(received), Buffer.from(state))
    ) {
      res.writeHead(400).end('Invalid OAuth state.');
      rejectCode(
        new GoogleAuthError(
          'STATE_MISMATCH',
          'OAuth state validation failed; no token exchange was performed.',
        ),
      );
      return;
    }
    const code = u.searchParams.get('code');
    if (u.searchParams.has('error') || !code || code.length > 8192) {
      res.writeHead(400).end('Authorization declined.');
      rejectCode(
        new GoogleAuthError('CONSENT_DENIED', 'Google authorization was declined or incomplete.'),
      );
      return;
    }
    res.end('Authorization received. Return to Syntrop in your terminal.');
    finish(code);
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', () =>
      reject(
        new GoogleAuthError('LOOPBACK_FAILED', 'Cannot start the local OAuth callback listener.'),
      ),
    );
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    fail('LOOPBACK_FAILED', 'Cannot start OAuth listener.');
  const redirect = `http://127.0.0.1:${address.port}/oauth2callback`;
  const url = new URL(AUTH);
  const existing = readPrivate<Tokens>(home, 'tokens.json');
  for (const [key, val] of Object.entries({
    client_id: c.client_id,
    redirect_uri: redirect,
    response_type: 'code',
    scope: [
      GOOGLE_SCOPE,
      ...(options.tasks ? [TASKS_SCOPE] : []),
      ...(options.freebusy ? [FREEBUSY_SCOPE] : []),
    ].join(' '),
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
    ...(options.tasks ? { include_granted_scopes: 'true' } : {}),
  }))
    url.searchParams.set(key, val);
  const timer = setTimeout(
    () =>
      rejectCode(
        new GoogleAuthError('OAUTH_TIMEOUT', 'Google authorization timed out. Run connect again.'),
      ),
    Math.min(Math.max(options.timeoutMs ?? 180_000, 50), 600_000),
  );
  try {
    if (options.onUrl) options.onUrl(url.toString());
    if (options.launchBrowser !== false) openBrowser(url.toString());
    const code = await codePromise;
    const params = new URLSearchParams({
      client_id: c.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: redirect,
      grant_type: 'authorization_code',
    });
    if (c.client_secret) params.set('client_secret', c.client_secret);
    const t = tokensFrom(await tokenRequest(params, options.fetch ?? fetch), existing);
    if (options.freebusy && !t.scope.split(' ').includes(FREEBUSY_SCOPE))
      fail('MISSING_SCOPE', 'Google did not grant requested free/busy permission; reconnect.');
    if (options.tasks && !t.scope.split(' ').includes(TASKS_SCOPE))
      fail('MISSING_SCOPE', 'Google did not grant requested Tasks permission; reconnect.');
    writePrivate(home, 'tokens.json', t);
    return status(home);
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
}
export async function disconnect(
  home: string,
  revoke = false,
  options: { fetch?: typeof fetch } = {},
) {
  const t = readPrivate<Tokens>(home, 'tokens.json');
  let revoked = false;
  let revocationFailed = false;
  if (revoke && t) {
    try {
      const res = await (options.fetch ?? fetch)(REVOKE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: t.refresh_token || t.access_token }),
        signal: AbortSignal.timeout(30_000),
        redirect: 'error',
      });
      revoked = res.ok;
      revocationFailed = !res.ok;
    } catch {
      revocationFailed = true;
    }
  }
  removePrivate(home, 'tokens.json');
  return { localRemoved: true, revoked, revocationFailed };
}
