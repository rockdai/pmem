import type { SessionInfo } from '../../../packages/contracts/src/index';
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export class Api {
  constructor(
    public session: SessionInfo,
    private fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}
  async call(path: string, init: RequestInit = {}) {
    const response = await this.fetcher(`/api/v1${path}`, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'x-csrf-token': this.session.csrf, ...init.headers },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok && response.status !== 304) {
      let code = 'request_failed';
      try {
        code = (await response.json()).error ?? code;
      } catch {
        /* proxies may return HTML */
      }
      throw new HttpError(response.status, code);
    }
    return response;
  }
}
