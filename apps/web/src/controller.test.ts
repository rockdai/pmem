import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from './api';
import { Drafts, type Draft } from './drafts';
import { NoteController } from './controller';
const live: NoteController[] = [],
  databases: Drafts[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(async () => {
  for (const c of live.splice(0)) await stop(c);
  databases.splice(0).forEach((db) => db.close());
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function stop(c: NoteController) {
  let closed = false;
  const closing = c.shutdown().then(() => {
    closed = true;
  });
  for (let i = 0; i < 1000 && !closed; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(10);
  }
  await closing;
}
async function make(fetcher: typeof fetch, base: string | null = null) {
  const db = await Drafts.open(crypto.randomUUID());
  databases.push(db);
  const id = crypto.randomUUID(),
    draft: Draft = {
      key: `test:slot:${id}`,
      id,
      namespace: 'test',
      slot: 'slot',
      body: '',
      base,
      rev: 0,
      modified: Date.now(),
      meaningful: false,
    };
  const api = new Api({ account: 'me', deployment: 'test', csrf: 'test' }, fetcher);
  const c = new NoteController(db, api, draft);
  live.push(c);
  return { db, c, api };
}
async function spin(check: () => boolean) {
  for (let i = 0; i < 1000 && !check(); i++) await new Promise((resolve) => setImmediate(resolve));
  expect(check()).toBe(true);
}
it('late save acknowledgment preserves and persists a newer draft with the new baseline', async () => {
  let finish!: (r: Response) => void,
    calls = 0;
  const { c, db } = await make(async () => {
    calls++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  c.change('first', true);
  await c.durable();
  const saving = c.save();
  await spin(() => calls === 1);
  c.change('new input', true);
  await c.durable();
  finish(new Response(null, { status: 201, headers: { etag: '"first"' } }));
  await saving;
  expect(c.view().body).toBe('new input');
  expect(c.view().dirty).toBe(true);
  const persisted = await db.get(c.draft.key);
  expect(persisted?.body).toBe('new input');
  expect(persisted?.base).toBe('"first"');
  expect(persisted?.pending).toBeUndefined();
});
it('oversized drafts are retained without submitting, and shrinkage resumes saving', async () => {
  const fetcher = vi.fn(async () => new Response(null, { status: 201, headers: { etag: '"ok"' } }));
  const { c, db } = await make(fetcher);
  c.change('中'.repeat(700_000), true);
  await c.durable();
  await c.save();
  expect(fetcher).not.toHaveBeenCalled();
  expect(c.view().block).toBe('oversize');
  expect((await db.get(c.draft.key))?.body.length).toBe(700_000);
  c.change('short', true);
  await c.durable();
  await c.save();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(c.view().dirty).toBe(false);
  expect(await db.get(c.draft.key)).toBeUndefined();
});
it('invalid requests stay stopped after draft reload', async () => {
  const fetcher = vi.fn(async () => new Response('{"error":"invalid_id"}', { status: 400 }));
  const { c, db, api } = await make(fetcher);
  c.change('keep', true);
  await c.durable();
  await c.save();
  expect(c.view().block).toBe('invalid');
  const restored = new NoteController(db, api, (await db.get(c.draft.key))!, true);
  live.push(restored);
  await restored.save();
  expect(fetcher).toHaveBeenCalledOnce();
});
it('never retries an uncertain create when a read returns 404', async () => {
  const methods: string[] = [];
  const { c } = await make(async (_url, init) => {
    methods.push(init?.method ?? 'GET');
    if (init?.method === 'POST') throw new Error('lost connection');
    return new Response('{"error":"not_found"}', { status: 404 });
  });
  c.change('keep my draft', true);
  await c.durable();
  await c.save();
  await c.refresh();
  await c.save();
  expect(methods).toEqual(['POST', 'GET']);
  expect(c.view().body).toBe('keep my draft');
  expect(c.view().block).toBe('pending');
});
it('quota failure is not labeled saved and blocks dispatch until persistence is retried', async () => {
  const fetcher = vi.fn(async () => new Response(null, { status: 201, headers: { etag: '"ok"' } }));
  const { c, db } = await make(fetcher);
  vi.spyOn(db, 'put').mockRejectedValueOnce(new DOMException('Quota', 'QuotaExceededError'));
  c.change('keep in memory', true);
  await c.durable().catch(() => {});
  await spin(() => c.view().localFailed);
  await c.save();
  expect(fetcher).not.toHaveBeenCalled();
  await c.retryLocal();
  expect(c.view().localFailed).toBe(false);
  expect(fetcher).toHaveBeenCalledOnce();
});
it('composition and blank new notes do not create files', async () => {
  const fetcher = vi.fn(async () => new Response(null, { status: 201, headers: { etag: '"ok"' } }));
  const { c } = await make(fetcher);
  c.change('', false);
  await c.durable();
  await c.save();
  expect(fetcher).not.toHaveBeenCalled();
  c.composition(true);
  c.change('中文', true);
  await c.durable();
  await c.save();
  expect(fetcher).not.toHaveBeenCalled();
  c.composition(false);
  await c.save();
  expect(fetcher).toHaveBeenCalledOnce();
});
it('a remote conflict never replaces the locally persisted text', async () => {
  const { c, db } = await make(
    async (_url, init) =>
      init?.method === 'PUT'
        ? new Response('{"error":"conflict"}', { status: 412 })
        : new Response('phone', { headers: { etag: '"phone"' } }),
    '"base"',
  );
  c.change('desktop', true);
  await c.durable();
  await c.save();
  await c.refresh();
  expect(c.view().block).toBe('conflict');
  expect(c.view().body).toBe('desktop');
  expect((await db.get(c.draft.key))?.body).toBe('desktop');
});
it('a read started before a successful save cannot restore its stale body', async () => {
  let finish!: (r: Response) => void;
  const { c } = await make(
    async (_url, init) =>
      init?.method === 'PUT'
        ? new Response(null, { status: 204, headers: { etag: '"new"' } })
        : new Promise((resolve) => {
            finish = resolve;
          }),
    '"base"',
  );
  const reading = c.refresh();
  await spin(() => Boolean(finish));
  c.change('new', true);
  await c.durable();
  await c.save();
  finish(new Response('stale', { headers: { etag: '"stale"' } }));
  await reading;
  expect(c.view().body).toBe('new');
  expect(c.draft.base).toBe('"new"');
  expect(c.view().dirty).toBe(false);
});
it('choosing remote content does not discard typing that arrives during the read', async () => {
  let finish!: (r: Response) => void;
  const { c, db } = await make(
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    '"base"',
  );
  c.change('draft', true);
  c.draft.block = 'conflict';
  await c.durable();
  const reading = c.useRemote();
  await spin(() => Boolean(finish));
  c.change('new typing', true);
  await c.durable();
  finish(new Response('remote', { headers: { etag: '"remote"' } }));
  await expect(reading).rejects.toThrow('Draft changed');
  expect(c.view().body).toBe('new typing');
  expect((await db.get(c.draft.key))?.body).toBe('new typing');
});

it('refreshes the session before releasing an auth-blocked draft, including new notes', async () => {
  const methods: string[] = [];
  let expired = true;
  const { c } = await make(async (url, init) => {
    methods.push(`${init?.method ?? 'GET'} ${url}`);
    if (expired) return new Response('{"error":"unauthorized"}', { status: 401 });
    if (String(url).endsWith('/auth/session'))
      return Response.json({ account: 'me', deployment: 'test', csrf: 'renewed' });
    expect(new Headers(init?.headers).get('x-csrf-token')).toBe('renewed');
    return new Response(null, { status: 201, headers: { etag: '"saved"' } });
  });
  c.change('local after expiry', true);
  await c.durable();
  await c.save();
  expect(c.view().block).toBe('auth');
  await c.refresh();
  expect(c.view().block).toBe('auth');
  expired = false;
  await c.refresh();
  await spin(() => !c.view().dirty);
  expect(methods.map((m) => m.split(' ')[0])).toEqual(['POST', 'GET', 'GET', 'POST']);
  expect(c.view().body).toBe('local after expiry');
});
it('repeated csrf rejection remains recoverable and keeps input arriving during renewal', async () => {
  let renew!: (r: Response) => void,
    reject = true;
  const { c, db } = await make(async (url, init) => {
    if (String(url).endsWith('/auth/session'))
      return new Promise((resolve) => {
        renew = resolve;
      });
    if (reject) return new Response('{"error":"csrf_rejected"}', { status: 403 });
    return new Response(null, { status: 204, headers: { etag: '"saved"' } });
  }, '"base"');
  c.change('sent', true);
  await c.durable();
  const saving = c.save();
  await spin(() => Boolean(renew));
  c.change('new typing', true);
  await c.durable();
  renew(Response.json({ account: 'me', deployment: 'test', csrf: 'renewed' }));
  await saving;
  expect(c.view().block).toBe('auth');
  expect((await db.get(c.draft.key))?.body).toBe('new typing');
  expect(c.draft.pending).toBeUndefined();
});
it('persists rate-limit deadlines across reload, backs off, and eventually saves the latest input', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  let attempts = 0;
  const fetcher = vi.fn<typeof fetch>(async () => {
    attempts++;
    return attempts < 3
      ? new Response('{"error":"rate_limited"}', {
          status: 429,
          headers: attempts === 1 ? { 'Retry-After': '3' } : {},
        })
      : new Response(null, { status: 201, headers: { etag: '"saved"' } });
  });
  const { c, db, api } = await make(fetcher);
  c.change('first', true);
  await c.durable();
  await c.save();
  expect(c.view().block).toBe('rate_limit');
  expect(c.draft.pending).toBeUndefined();
  await stop(c);
  const restored = new NoteController(db, api, (await db.get(c.draft.key))!, true);
  live.push(restored);
  restored.change('latest', true);
  await restored.durable();
  await restored.refresh();
  await restored.save();
  await vi.advanceTimersByTimeAsync(2999);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await spin(() => restored.draft.retry?.attempts === 2);
  await restored.durable();
  expect(restored.draft.retry!.at - Date.now()).toBe(2000);
  await stop(restored);
  const again = new NoteController(db, api, (await db.get(c.draft.key))!, true);
  live.push(again);
  await again.refresh();
  await vi.advanceTimersByTimeAsync(1999);
  expect(fetcher).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  await spin(() => !again.view().dirty);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls[2][1]?.body).toBe('latest');
  expect(again.draft.retry).toBeUndefined();
  expect(await db.get(c.draft.key)).toBeUndefined();
});
it.each([false, true])(
  'retries a rejected delete only if no new input arrived (%s)',
  async (edit) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const methods: string[] = [];
    const { c } = await make(async (_url, init) => {
      methods.push(init?.method ?? 'GET');
      if (methods.length === 1) return new Response('{"error":"rate_limited"}', { status: 429 });
      return new Response(null, { status: 204, headers: { etag: '"saved"' } });
    }, '"base"');
    await c.remove();
    expect(c.view().block).toBe('rate_limit');
    if (edit) {
      c.change('keep new typing', true);
      await c.durable();
    }
    await c.remove();
    expect(methods).toEqual(['DELETE']);
    await vi.advanceTimersByTimeAsync(1000);
    await spin(() => methods.length === 2);
    await spin(() => (edit ? !c.view().dirty : c.view().deleted));
    expect(methods).toEqual(['DELETE', edit ? 'PUT' : 'DELETE']);
    expect(c.view().deleted).toBe(!edit);
  },
);

it('keeps oversize protection when a rate-limit response arrives after newer large input', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  let finish!: (r: Response) => void;
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(new Response(null, { status: 201, headers: { etag: '"saved"' } }));
  const { c } = await make(fetcher);
  c.change('first', true);
  await c.durable();
  const saving = c.save();
  await spin(() => Boolean(finish));
  c.change('中'.repeat(400_000), true);
  await c.durable();
  finish(new Response('{"error":"rate_limited"}', { status: 429 }));
  await saving;
  await vi.advanceTimersByTimeAsync(1000);
  await c.durable();
  expect(c.view().block).toBe('oversize');
  expect(fetcher).toHaveBeenCalledOnce();
  c.change('within the limit again', true);
  await c.durable();
  await c.save();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(c.view().dirty).toBe(false);
});
