import { expect, it, vi } from 'vitest';
import { Api } from './api';
const session = { account: 'me', deployment: 'test', csrf: 'old' };
const rejection = (code = 'csrf_rejected', status = 403) =>
  new Response(JSON.stringify({ error: code }), { status });
it('renews CSRF once after explicit rejection and retries the same conditional mutation', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(rejection())
    .mockResolvedValueOnce(Response.json({ ...session, csrf: 'new' }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  const api = new Api(session, fetcher);
  api.onSession = vi.fn();
  await api.call('/notes/id', {
    method: 'PUT',
    body: 'retained body',
    headers: { 'if-match': '"base"' },
  });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    '/api/v1/notes/id',
    '/api/v1/auth/session',
    '/api/v1/notes/id',
  ]);
  const [, retry] = fetcher.mock.calls[2];
  expect(retry?.body).toBe('retained body');
  expect(new Headers(retry?.headers).get('if-match')).toBe('"base"');
  expect(new Headers(retry?.headers).get('x-csrf-token')).toBe('new');
  expect(api.onSession).toHaveBeenCalledOnce();
});
it.each(['origin_rejected', 'invalid_request'])(
  'does not retry other 403 errors: %s',
  async (code) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(rejection(code));
    await expect(
      new Api(session, fetcher).call('/notes/id', { method: 'POST' }),
    ).rejects.toMatchObject({ status: 403, code });
    expect(fetcher).toHaveBeenCalledOnce();
  },
);
it('bounds repeated CSRF rejection and never retries an uncertain mutation', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(rejection())
    .mockResolvedValueOnce(Response.json(session))
    .mockResolvedValueOnce(rejection());
  await expect(
    new Api(session, fetcher).call('/notes/id', { method: 'DELETE' }),
  ).rejects.toMatchObject({ code: 'csrf_rejected' });
  expect(fetcher).toHaveBeenCalledTimes(3);
  fetcher.mockReset().mockRejectedValue(new Error('connection lost'));
  await expect(new Api(session, fetcher).call('/notes/id', { method: 'PUT' })).rejects.toThrow(
    'connection lost',
  );
  expect(fetcher).toHaveBeenCalledOnce();
});
it('failed session reads preserve the known rejection and forbid crossing a deployment', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(rejection())
    .mockRejectedValueOnce(new Error('GET timeout'));
  await expect(
    new Api(session, fetcher).call('/notes/id', { method: 'PUT' }),
  ).rejects.toMatchObject({ code: 'csrf_rejected' });
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher
    .mockReset()
    .mockResolvedValueOnce(rejection())
    .mockResolvedValueOnce(Response.json({ ...session, deployment: 'other' }));
  await expect(
    new Api(session, fetcher).call('/notes/id', { method: 'PUT' }),
  ).rejects.toMatchObject({ status: 401 });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('coalesces session refresh and interprets Retry-After seconds and dates', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(session));
  const api = new Api(session, fetcher);
  await Promise.all([api.refreshSession(), api.refreshSession()]);
  expect(fetcher).toHaveBeenCalledOnce();
  for (const retry of ['3', new Date(Date.now() + 10_000).toUTCString()]) {
    fetcher.mockResolvedValueOnce(
      new Response('{"error":"rate_limited"}', { status: 429, headers: { 'Retry-After': retry } }),
    );
    await expect(api.call('/notes/id')).rejects.toMatchObject({
      status: 429,
      retryAfterMs: expect.any(Number),
    });
  }
  fetcher.mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '3' } }));
  await expect(api.call('/notes/id')).rejects.toMatchObject({ retryAfterMs: 3000 });
});
