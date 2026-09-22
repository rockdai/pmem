import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkStateMount,
  OssStore,
  type ObjectData,
  type ObjectGateway,
  type ObjectInfo,
} from './oss';
import { Notes, digest } from './storage';
import * as files from './files';
import { createApp } from './app';
import { config } from './config';
import { hashPassword } from './auth';
import type { RuntimeDiagnostic } from './diagnostics';
class MemoryGateway implements ObjectGateway {
  objects = new Map<string, ObjectData>();
  heads = 0;
  gets = 0;
  bytesRead = 0;
  puts = 0;
  version: string | undefined;
  headFailure = false;
  delayed: (() => void) | undefined;
  loseNext = false;
  async versioning() {
    return this.version;
  }
  async list(prefix: string) {
    return [...this.objects.values()].map((o) => o.info).filter((o) => o.key.startsWith(prefix));
  }
  async get(key: string, limit?: number) {
    this.gets++;
    const o = this.objects.get(key);
    this.bytesRead += o ? o.body.subarray(0, limit).length : 0;
    return o ? { body: Buffer.from(o.body.subarray(0, limit)), info: { ...o.info } } : null;
  }
  async head(key: string): Promise<ObjectInfo | null> {
    this.heads++;
    if (this.headFailure) throw new Error('head failed');
    return this.objects.get(key)?.info ?? null;
  }
  async put(key: string, body: Buffer, exclusive = false) {
    this.puts++;
    if (exclusive && this.objects.has(key))
      throw Object.assign(new Error('already exists'), { code: 'FileAlreadyExists', status: 409 });
    const commit = () =>
      this.objects.set(key, {
        body: Buffer.from(body),
        info: { key, modified: Date.now(), size: body.length, validator: digest(body) },
      });
    if (this.loseNext) {
      this.loseNext = false;
      this.delayed = commit;
      throw new Error('response lost');
    }
    commit();
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}
const dirs: string[] = [];
async function temp() {
  const p = await mkdtemp(join(tmpdir(), 'pmem-oss-'));
  dirs.push(p);
  return p;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
it('persists uncertainty across restart and blocks later writes until the late write is observed', async () => {
  const gateway = new MemoryGateway(),
    root = await temp(),
    id = randomUUID();
  const store = await OssStore.open(gateway, root, 'test', 'pmem/', { initialize: true });
  const notes = new Notes(store);
  const first = await notes.write(id, Buffer.from('first'), 'create');
  gateway.loseNext = true;
  await expect(notes.write(id, Buffer.from('late'), 'replace', first)).rejects.toMatchObject({
    code: 'write_pending',
  });
  const count = gateway.puts;
  const restarted = new Notes(await OssStore.open(gateway, root, 'test', 'pmem/'));
  await expect(restarted.write(id, Buffer.from('new'), 'replace', first)).rejects.toMatchObject({
    code: 'write_pending',
  });
  expect(gateway.puts).toBe(count);
  gateway.delayed!();
  const late = await restarted.get(id);
  expect(late.body?.toString()).toBe('late');
  await restarted.write(id, Buffer.from('new'), 'replace', late.etag);
  expect((await restarted.get(id)).body?.toString()).toBe('new');
});
it('uses HEAD for unchanged warm polling, and fails closed on HEAD errors', async () => {
  const gateway = new MemoryGateway(),
    root = await temp(),
    id = randomUUID();
  const notes = new Notes(
    await OssStore.open(gateway, root, 'test', 'pmem/', { initialize: true }),
  );
  await notes.write(id, Buffer.alloc(1024 * 1024, 'a'), 'create');
  const first = await notes.get(id);
  gateway.gets = 0;
  gateway.heads = 0;
  for (let i = 0; i < 12; i++) expect((await notes.get(id, first.etag)).body).toBeUndefined();
  expect(gateway.gets).toBe(0);
  expect(gateway.heads).toBe(12);
  gateway.headFailure = true;
  await expect(notes.get(id, first.etag)).rejects.toThrow('head failed');
  gateway.headFailure = false;
  const cold = new Notes(await OssStore.open(gateway, root, 'test', 'pmem/'));
  gateway.gets = 0;
  await cold.get(id, first.etag);
  await cold.get(id, first.etag);
  expect(gateway.gets).toBe(1);
});
it('refuses a lost or mismatched state volume and versioned buckets without mutating notes', async () => {
  const gateway = new MemoryGateway(),
    root = await temp();
  await OssStore.open(gateway, root, 'test', 'pmem/', { initialize: true });
  const puts = gateway.puts;
  await expect(OssStore.open(gateway, await temp(), 'test', 'pmem/')).rejects.toThrow(
    'identity missing',
  );
  await expect(
    OssStore.open(gateway, await temp(), 'test', 'pmem/', { initialize: true }),
  ).rejects.toThrow('identity missing');
  expect(gateway.puts).toBe(puts);
  const owner = JSON.parse(await readFile(join(root, 'owner.json'), 'utf8'));
  owner.stateId = randomUUID();
  await writeFile(join(root, 'owner.json'), JSON.stringify(owner));
  await expect(OssStore.open(gateway, root, 'test', 'pmem/')).rejects.toThrow('does not match');
  expect(gateway.puts).toBe(puts);
  gateway.version = 'Suspended';
  await expect(OssStore.open(gateway, root, 'test', 'pmem/')).rejects.toThrow('versioning');
});
it('evicts idle and least-recently-used validators and invalidates after writes', async () => {
  const gateway = new MemoryGateway(),
    root = await temp(),
    id = randomUUID();
  const notes = new Notes(
    await OssStore.open(gateway, root, 'test', 'pmem/', { initialize: true }),
  );
  await notes.write(id, Buffer.from('first'), 'create');
  const first = await notes.get(id);
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + 30 * 60_000 + 1);
  gateway.gets = 0;
  await notes.get(id, first.etag);
  expect(gateway.gets).toBe(1);
  vi.restoreAllMocks();
  for (let i = 0; i < 128; i++) {
    const other = randomUUID();
    await gateway.put(`pmem/notes/${other}.md`, Buffer.from('other'));
    await notes.get(other);
  }
  gateway.gets = 0;
  await notes.get(id, first.etag);
  expect(gateway.gets).toBe(1);
  const updated = await notes.write(id, Buffer.from('updated'), 'replace', first.etag);
  gateway.gets = 0;
  await notes.get(id, updated);
  expect(gateway.gets).toBe(1);
  await gateway.put(`pmem/notes/${id}.md`, Buffer.from('changed outside cache'));
  expect((await notes.get(id, updated)).body?.toString()).toBe('changed outside cache');
});
it('explicit initialization resumes the same local identity after an uncertain marker write', async () => {
  const gateway = new MemoryGateway(),
    root = await temp();
  gateway.loseNext = true;
  await expect(OssStore.open(gateway, root, 'test', 'pmem/', { initialize: true })).rejects.toThrow(
    'response lost',
  );
  const owner = await readFile(join(root, 'owner.json'), 'utf8');
  gateway.delayed!();
  await OssStore.open(gateway, root, 'test', 'pmem/', { initialize: true });
  expect(await readFile(join(root, 'owner.json'), 'utf8')).toBe(owner);
  expect(gateway.objects.get('pmem/control/state-owner')?.body.toString()).toBe(owner);
});
it('an uncertain deletion blocks replacement across restart until absence is observed', async () => {
  const gateway = new MemoryGateway(),
    root = await temp(),
    id = randomUUID();
  const notes = new Notes(
    await OssStore.open(gateway, root, 'test', 'pmem/', { initialize: true }),
  );
  const etag = await notes.write(id, Buffer.from('retained'), 'create');
  vi.spyOn(gateway, 'delete').mockRejectedValueOnce(new Error('delete response lost'));
  await expect(notes.remove(id, etag)).rejects.toMatchObject({ code: 'write_pending' });
  const restarted = new Notes(await OssStore.open(gateway, root, 'test', 'pmem/'));
  await expect(restarted.write(id, Buffer.from('new'), 'replace', etag)).rejects.toMatchObject({
    code: 'write_pending',
  });
  await gateway.delete(`pmem/notes/${id}.md`);
  await expect(restarted.get(id)).rejects.toMatchObject({ status: 404 });
  await expect(restarted.write(id, Buffer.from('new'), 'replace', etag)).rejects.toMatchObject({
    status: 404,
  });
});
it.skipIf(process.platform !== 'linux')(
  'rejects tmpfs and a missing container volume before any remote initialization',
  async () => {
    await expect(checkStateMount('/dev/shm')).rejects.toThrow('tmpfs');
    const gateway = new MemoryGateway();
    await expect(
      OssStore.open(gateway, await temp(), 'test', 'pmem/', { initialize: true, container: true }),
    ).rejects.toThrow('dedicated persistent volume');
    expect(gateway.puts).toBe(0);
    expect(gateway.gets).toBe(0);
  },
);
it('rejects corrupt pending records', async () => {
  const gateway = new MemoryGateway(),
    root = await temp();
  await OssStore.open(gateway, root, 'test', 'pmem/', { initialize: true });
  await writeFile(join(root, 'pending', `${randomUUID()}.json`), '{}');
  await expect(OssStore.open(gateway, root, 'test', 'pmem/')).rejects.toThrow('Corrupt');
});

it('reads a 1 MiB body only once per update/delete and records the verified baseline', async () => {
  const gateway = new MemoryGateway(),
    root = await temp(),
    id = randomUUID();
  const notes = new Notes(
    await OssStore.open(gateway, root, 'test', 'pmem/', { initialize: true }),
  );
  const original = Buffer.alloc(1024 * 1024, 'a');
  const before = await notes.write(id, original, 'create');
  gateway.gets = gateway.bytesRead = gateway.puts = 0;
  const next = await notes.write(id, Buffer.alloc(1024 * 1024, 'b'), 'replace', before);
  expect([gateway.gets, gateway.bytesRead, gateway.puts]).toEqual([1, 1024 * 1024, 1]);
  gateway.loseNext = true;
  await expect(notes.write(id, Buffer.from('late'), 'replace', next)).rejects.toMatchObject({
    code: 'write_pending',
  });
  const record = JSON.parse(await readFile(join(root, 'pending', `${id}.json`), 'utf8'));
  expect(record.before).toBe(next);
  expect(record.target).toBe(digest(Buffer.from('late')));
  gateway.delayed!();
  await notes.get(id);
  gateway.gets = gateway.bytesRead = 0;
  await notes.remove(id, record.target);
  expect([gateway.gets, gateway.bytesRead]).toEqual([1, 4]);
});
it('clears a definitive exclusive-create rejection durably without overwriting the existing object', async () => {
  const gateway = new MemoryGateway(),
    root = await temp(),
    id = randomUUID();
  const store = await OssStore.open(gateway, root, 'test', 'pmem/', { initialize: true });
  const notes = new Notes(store),
    key = `pmem/notes/${id}.md`;
  const put = gateway.put.bind(gateway);
  vi.spyOn(gateway, 'put').mockImplementationOnce(async (k, body, exclusive) => {
    // Another writer wins after our absence read but before our exclusive PUT.
    await put(key, Buffer.from('existing'));
    await put(k, body, exclusive);
  });
  await expect(notes.write(id, Buffer.from('mine'), 'create')).rejects.toMatchObject({
    status: 409,
    code: 'already_exists',
  });
  expect(gateway.objects.get(key)?.body.toString()).toBe('existing');
  expect(await files.readRegular(join(root, 'pending', `${id}.json`))).toBeNull();
  const restarted = new Notes(await OssStore.open(gateway, root, 'test', 'pmem/'));
  expect((await restarted.get(id)).body?.toString()).toBe('existing');
  await restarted.write(
    id,
    Buffer.from('explicit update'),
    'replace',
    digest(Buffer.from('existing')),
  );
});
it('keeps the guard if clearing a definitive rejection cannot be fsynced', async () => {
  const gateway = new MemoryGateway(),
    root = await temp(),
    id = randomUUID();
  const notes = new Notes(
    await OssStore.open(gateway, root, 'test', 'pmem/', { initialize: true }),
  );
  const put = gateway.put.bind(gateway);
  vi.spyOn(gateway, 'put').mockImplementationOnce(async (key, body, exclusive) => {
    await put(key, Buffer.from('existing'));
    vi.spyOn(files, 'syncDirectory').mockRejectedValueOnce(
      Object.assign(new Error('disk'), { code: 'EIO' }),
    );
    await put(key, body, exclusive);
  });
  await expect(notes.write(id, Buffer.from('mine'), 'create')).rejects.toMatchObject({
    code: 'write_pending',
    diagnostic: { stage: 'pending_clear', errorCode: 'EIO' },
  });
  const count = gateway.puts;
  await expect(notes.write(id, Buffer.from('again'), 'create')).rejects.toMatchObject({
    code: 'write_pending',
  });
  expect(gateway.puts).toBe(count);
});
it('does not treat an unrelated OSS 409 as a definitive rejection', async () => {
  const gateway = new MemoryGateway(),
    root = await temp(),
    id = randomUUID();
  const notes = new Notes(
    await OssStore.open(gateway, root, 'test', 'pmem/', { initialize: true }),
  );
  vi.spyOn(gateway, 'put').mockRejectedValueOnce(
    Object.assign(new Error('unknown conflict'), { code: 'OtherConflict', status: 409 }),
  );
  await expect(notes.write(id, Buffer.from('mine'), 'create')).rejects.toMatchObject({
    code: 'write_pending',
    diagnostic: { stage: 'oss_request' },
  });
  expect(await files.readRegular(join(root, 'pending', `${id}.json`))).not.toBeNull();
  const restarted = new Notes(await OssStore.open(gateway, root, 'test', 'pmem/'));
  await expect(restarted.write(id, Buffer.from('retry'), 'create')).rejects.toMatchObject({
    code: 'write_pending',
  });
});
it('logs bounded runtime diagnostics for each uncertainty stage and generic storage errors without secrets', async () => {
  const gateway = new MemoryGateway(),
    root = await temp();
  const store = await OssStore.open(gateway, root, 'test', 'pmem/', { initialize: true });
  const cfg = config({
    PMEM_ACCOUNT: 'me',
    PMEM_PASSWORD_HASH: await hashPassword('private-password'),
    PMEM_SESSION_KEY: 'ab'.repeat(32),
    PMEM_ORIGIN: 'http://localhost:3000',
    PMEM_DATA_DIR: root,
  });
  const entries: RuntimeDiagnostic[] = [];
  const app = await createApp(cfg, store, '/no-web', (entry) => entries.push(entry));
  const secret = 'private-body private-password private-cookie private-key-secret';
  const sdkError = Object.assign(new Error(secret + ' https://example.test/?Signature=secret'), {
    code: 'RequestTimeout',
    requestId: 'OSS-request-123',
    headers: { authorization: secret },
    res: { data: secret },
  });
  try {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: cfg.origin },
      payload: { account: 'me', password: 'private-password' },
    });
    const headers = {
      origin: cfg.origin,
      cookie: String(login.headers['set-cookie']).split(';')[0],
      'x-csrf-token': login.json().csrf,
      'content-type': 'text/markdown',
    };
    const submit = (id: string) =>
      app.inject({ method: 'POST', url: `/api/v1/notes/${id}`, headers, payload: secret });
    const id = randomUUID();
    vi.spyOn(gateway, 'put').mockRejectedValueOnce(sdkError);
    expect((await submit(id)).json()).toEqual({ error: 'write_pending' });
    expect(entries.at(-1)).toMatchObject({
      stage: 'oss_request',
      operation: 'create',
      noteId: id,
      operationId: expect.any(String),
      errorName: 'Error',
      errorCode: 'RequestTimeout',
      ossRequestId: 'OSS-request-123',
      status: 503,
    });
    await app.inject({ url: `/api/v1/notes/${id}`, headers });
    expect(entries.at(-1)).toMatchObject({
      stage: 'pending_verify',
      errorCode: 'TargetNotObserved',
    });
    vi.spyOn(files, 'atomicFile').mockRejectedValueOnce(
      Object.assign(new Error(secret), { code: 'ENOSPC' }),
    );
    expect((await submit(randomUUID())).statusCode).toBe(503);
    expect(entries.at(-1)).toMatchObject({ stage: 'pending_record', errorCode: 'ENOSPC' });
    vi.spyOn(files, 'syncDirectory').mockRejectedValueOnce(
      Object.assign(new Error(secret), { code: 'EIO' }),
    );
    expect((await submit(randomUUID())).statusCode).toBe(503);
    expect(entries.at(-1)).toMatchObject({ stage: 'pending_clear', errorCode: 'EIO' });
    vi.spyOn(gateway, 'get').mockRejectedValueOnce(sdkError);
    expect(
      (
        await app.inject({ url: `/api/v1/notes/${randomUUID()}?secret=query-secret`, headers })
      ).json(),
    ).toEqual({ error: 'storage_unavailable' });
    expect(entries.at(-1)).toMatchObject({
      code: 'storage_unavailable',
      errorCode: 'RequestTimeout',
      ossRequestId: 'OSS-request-123',
      route: '/api/v1/notes/:id',
    });
    expect(entries.at(-1)?.stage).toBeUndefined();
    const output = JSON.stringify(entries);
    for (const value of [
      secret,
      cfg.passwordHash,
      headers.cookie,
      headers['x-csrf-token'],
      'Signature',
      'query-secret',
      'authorization',
      'stack',
    ])
      expect(output).not.toContain(value);
    expect(entries).toHaveLength(5);
    expect(output.length).toBeLessThan(2500);
  } finally {
    await app.close();
  }
});
