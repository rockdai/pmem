import type { SessionInfo } from '../../../packages/contracts/src/index';
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfterMs = 0,
  ) {
    super(code);
  }
}
export class Api {
  onSession: () => void = () => {};
  private refreshing?: Promise<void>;
  constructor(
    public session: SessionInfo,
    private fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}
  private async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('x-csrf-token', this.session.csrf);
    const response = await this.fetcher(`/api/v1${path}`, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok && response.status !== 304) {
      let code = 'request_failed';
      try {
        code = (await response.json()).error ?? code;
      } catch {
        /* proxies may return HTML */
      }
      const retry = response.headers.get('retry-after');
      const delay =
        retry === null
          ? 0
          : /^\d+$/.test(retry)
            ? Number(retry) * 1000
            : Date.parse(retry) - Date.now();
      throw new HttpError(response.status, code, Number.isFinite(delay) ? Math.max(0, delay) : 0);
    }
    return response;
  }
  async refreshSession() {
    this.refreshing ??= (async () => {
      const response = await this.request('/auth/session');
      const session: SessionInfo = await response.json();
      if (
        session.account !== this.session.account ||
        session.deployment !== this.session.deployment ||
        typeof session.csrf !== 'string'
      )
        throw new HttpError(401, 'session_changed');
      this.session = session;
      this.onSession();
    })().finally(() => {
      this.refreshing = undefined;
    });
    await this.refreshing;
  }
  async call(path: string, init: RequestInit = {}) {
    try {
      return await this.request(path, init);
    } catch (error) {
      if (
        !(error instanceof HttpError) ||
        error.status !== 403 ||
        error.code !== 'csrf_rejected' ||
        ['GET', 'HEAD'].includes(init.method ?? 'GET')
      )
        throw error;
      // This explicit rejection guarantees the mutation was not applied. Refresh once;
      // an uncertain response to the retried mutation must still go through reconciliation.
      try {
        await this.refreshSession();
      } catch (refreshError) {
        if (refreshError instanceof HttpError && [401, 429].includes(refreshError.status))
          throw refreshError;
        throw error;
      }
      return this.request(path, init);
    }
  }
}
