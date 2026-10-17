import { getAccessToken } from './google-auth.ts';
import type { GoogleTransport } from './google-types.ts';
const BASE = 'https://www.googleapis.com/calendar/v3';
export class GoogleApiError extends Error {
  status: number;
  reason: string;
  constructor(status: number, reason: string) {
    super(`Google Calendar request failed (HTTP ${status}; ${reason}).`);
    this.name = 'GoogleApiError';
    this.status = status;
    this.reason = reason;
  }
}
type Options = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  persistTokens?: boolean;
};
export class GoogleClient implements GoogleTransport {
  private home: string;
  private fetcher: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private persistTokens: boolean;
  private cachedToken?: string;
  constructor(home: string, options: Options = {}) {
    this.home = home;
    this.fetcher = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.persistTokens = options.persistTokens !== false;
  }
  async request<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    if (
      !path.startsWith('/') ||
      path.startsWith('//') ||
      path.includes('\\') ||
      path.includes('#') ||
      /[\r\n]/.test(path)
    )
      throw new GoogleApiError(0, 'invalid_path');
    const url = new URL(`${BASE}${path}`);
    if (url.origin !== 'https://www.googleapis.com' || !url.pathname.startsWith('/calendar/v3/'))
      throw new GoogleApiError(0, 'invalid_path');
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method))
      throw new GoogleApiError(0, 'invalid_method');
    let token =
      this.cachedToken ??
      (await getAccessToken(this.home, {
        persist: this.persistTokens,
        fetch: this.fetcher,
      }));
    this.cachedToken = token;
    let refreshed = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      let res: Response;
      try {
        res = await this.fetcher(url, {
          method,
          headers: {
            ...headers,
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(30_000),
          redirect: 'error',
        });
      } catch {
        throw new GoogleApiError(0, 'network_failure_or_timeout');
      }
      if (res.ok) {
        if (res.status === 204) return {} as T;
        try {
          return (await res.json()) as T;
        } catch {
          throw new GoogleApiError(res.status, 'invalid_response');
        }
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        token = await getAccessToken(this.home, {
          persist: this.persistTokens,
          forceRefresh: true,
          fetch: this.fetcher,
        });
        this.cachedToken = token;
        continue;
      }
      let payload: { error?: { errors?: { reason?: string }[] } } = {};
      try {
        payload = (await res.json()) as typeof payload;
      } catch {
        /* Never expose untrusted provider bodies. */
      }
      const known = new Set([
        'rateLimitExceeded',
        'userRateLimitExceeded',
        'quotaExceeded',
        'forbidden',
        'insufficientPermissions',
        'notFound',
        'gone',
        'conditionNotMet',
        'duplicate',
        'invalid',
        'invalidArgument',
        'backendError',
      ]);
      const providerReason = payload?.error?.errors?.[0]?.reason;
      const reason =
        providerReason && known.has(providerReason) ? providerReason : 'request_failed';
      const retry =
        res.status === 429 ||
        res.status >= 500 ||
        (res.status === 403 && ['rateLimitExceeded', 'userRateLimitExceeded'].includes(reason));
      // Calendar creation POST cannot be safely replayed after uncertain provider failures.
      const canRetry =
        method !== 'POST' ||
        path.startsWith('/freeBusy') ||
        (path.includes('/events') &&
          !!body &&
          typeof body === 'object' &&
          typeof (body as { id?: unknown }).id === 'string');
      if (retry && canRetry && attempt < 4) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await this.sleep(
          Math.min(
            30_000,
            Math.max(
              250,
              Number.isFinite(retryAfter) && retryAfter > 0
                ? retryAfter * 1000
                : 500 * 2 ** attempt + Math.floor(Math.random() * 250),
            ),
          ),
        );
        continue;
      }
      throw new GoogleApiError(res.status, reason);
    }
    throw new GoogleApiError(401, 'authorization_failed');
  }
}
