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
  for (const c of live.splice(0)) await c.shutdown();
  databases.splice(0).forEach((db) => db.close());
  vi.restoreAllMocks();
  vi.useRealTimers();
});
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
