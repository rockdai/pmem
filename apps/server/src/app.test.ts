import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from './app';
import { hashPassword } from './auth';
import { config } from './config';
import { LocalStore } from './local';
let root: string;
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pmem-test-'));
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  await rm(root, { recursive: true, force: true });
});
async function setup(password = 'test-password-12345') {
  const cfg = config({
    PMEM_ACCOUNT: 'me',
    PMEM_PASSWORD_HASH: await hashPassword(password),
    PMEM_SESSION_KEY: 'ab'.repeat(32),
    PMEM_ORIGIN: 'http://localhost:3000',
    PMEM_DATA_DIR: root,
  });
  const app = await createApp(cfg, await LocalStore.create(root), '/no-web');
  apps.push(app);
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: cfg.origin },
    payload: { account: 'me', password },
  });
  expect(login.statusCode).toBe(200);
  const headers = {
    origin: cfg.origin,
    cookie: String(login.headers['set-cookie']).split(';')[0],
    'x-csrf-token': login.json().csrf,
    'content-type': 'text/markdown',
  };
  expect((await app.inject({ url: '/api/v1/auth/session', headers })).statusCode).toBe(200);
  return { app, headers, cfg };
}
it('stores only raw Markdown; enforces auth, CSRF and stale-write preconditions', async () => {
  const { app, headers } = await setup();
  const id = randomUUID(),
    url = `/api/v1/notes/${id}`;
  expect((await app.inject({ url })).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        method: 'POST',
        url,
        headers: { ...headers, origin: 'https://evil.test' },
        payload: 'no',
      })
    ).statusCode,
  ).toBe(403);
  const created = await app.inject({ method: 'POST', url, headers, payload: '# 中文\n\n**内容**' });
  expect(created.statusCode).toBe(201);
  const etag = String(created.headers.etag);
  expect(await readFile(join(root, 'notes', `${id}.md`), 'utf8')).toBe('# 中文\n\n**内容**');
  expect((await app.inject({ method: 'PUT', url, headers, payload: 'no' })).statusCode).toBe(428);
  const writes = await Promise.all(
    ['phone', 'desktop'].map((payload) =>
      app.inject({ method: 'PUT', url, headers: { ...headers, 'if-match': etag }, payload }),
    ),
  );
  expect(writes.map((w) => w.statusCode).sort()).toEqual([204, 412]);
  const current = await app.inject({ url, headers });
  expect(
    (
      await app.inject({
        url,
        headers: { ...headers, 'if-none-match': String(current.headers.etag) },
      })
    ).statusCode,
  ).toBe(304);
  expect(
    (
      await app.inject({
        method: 'DELETE',
        url,
        headers: { ...headers, 'if-match': String(current.headers.etag) },
      })
    ).statusCode,
  ).toBe(204);
  expect(
    (
      await app.inject({
        method: 'PUT',
        url,
        headers: { ...headers, 'if-match': String(current.headers.etag) },
        payload: 'resurrect',
      })
    ).statusCode,
  ).toBe(404);
  expect(await readdir(join(root, 'notes'))).toEqual([]);
});
it('rejects old cookies after only the password hash changes', async () => {
  const first = await setup();
  const second = await setup('a-different-password');
  for (const url of ['/api/v1/auth/session', '/api/v1/notes', `/api/v1/notes/${randomUUID()}`])
    expect((await second.app.inject({ url, headers: first.headers })).statusCode).toBe(401);
  expect(
    (
      await second.app.inject({
        method: 'POST',
        url: `/api/v1/notes/${randomUUID()}`,
        headers: first.headers,
        payload: 'old',
      })
    ).statusCode,
  ).toBe(401);
});
it('rejects oversized, invalid UTF-8, malformed IDs and symlink notes', async () => {
  const { app, headers } = await setup();
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/api/v1/notes/${randomUUID()}`,
        headers,
        payload: Buffer.alloc(1024 * 1024 + 1),
      })
    ).statusCode,
  ).toBe(413);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/api/v1/notes/${randomUUID()}`,
        headers,
        payload: Buffer.from([0xff]),
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (await app.inject({ method: 'POST', url: '/api/v1/notes/not-an-id', headers, payload: 'x' }))
      .statusCode,
  ).toBe(400);
  const id = randomUUID();
  await symlink('/etc/passwd', join(root, 'notes', `${id}.md`));
  const result = await app.inject({ url: `/api/v1/notes/${id}`, headers });
  expect(result.statusCode).toBe(503);
  expect(result.body).not.toContain('root:');
});
it('lists by modification time and paginates without a persisted index', async () => {
  const { app, headers } = await setup();
  for (let i = 0; i < 3; i++)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/notes/${randomUUID()}`,
          headers,
          payload: `# note ${i}`,
        })
      ).statusCode,
    ).toBe(201);
  const a = (await app.inject({ url: '/api/v1/notes?limit=2', headers })).json();
  const b = (await app.inject({ url: `/api/v1/notes?limit=2&cursor=${a.cursor}`, headers })).json();
  expect(a.notes[0].title).toBe('note 2');
  expect(new Set([...a.notes, ...b.notes].map((n) => n.id)).size).toBe(3);
  expect((await readdir(join(root, 'notes'))).every((n) => n.endsWith('.md'))).toBe(true);
});
it('clearing an existing note keeps a zero-byte current file until explicit deletion', async () => {
  const { app, headers } = await setup(),
    id = randomUUID(),
    url = `/api/v1/notes/${id}`;
  const first = await app.inject({ method: 'POST', url, headers, payload: 'content' });
  const cleared = await app.inject({
    method: 'PUT',
    url,
    headers: { ...headers, 'if-match': String(first.headers.etag) },
    payload: '',
  });
  expect(cleared.statusCode).toBe(204);
  expect(await readFile(join(root, 'notes', `${id}.md`), 'utf8')).toBe('');
  const read = await app.inject({ url, headers });
  expect(read.statusCode).toBe(200);
  expect(read.body).toBe('');
});
