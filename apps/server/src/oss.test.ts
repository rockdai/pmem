import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OssStore, type ObjectData, type ObjectGateway, type ObjectInfo } from './oss';
import { Notes, digest } from './storage';
class MemoryGateway implements ObjectGateway {
  objects = new Map<string, ObjectData>(); heads = 0; gets = 0; puts = 0;
  version: string | undefined; headFailure = false;
  delayed: (() => void) | undefined; loseNext = false;
  async versioning() { return this.version; }
  async list(prefix: string) { return [...this.objects.values()].map(o => o.info).filter(o => o.key.startsWith(prefix)); }
  async get(key: string, limit?: number) { this.gets++; const o = this.objects.get(key); return o ? { body: Buffer.from(o.body.subarray(0, limit)), info: { ...o.info } } : null; }
  async head(key: string): Promise<ObjectInfo | null> { this.heads++; if (this.headFailure) throw new Error('head failed'); return this.objects.get(key)?.info ?? null; }
  async put(key: string, body: Buffer, exclusive = false) {
    this.puts++; if (exclusive && this.objects.has(key)) throw new Error('already exists');
    const commit = () => this.objects.set(key, { body: Buffer.from(body), info: { key, modified: Date.now(), size: body.length, validator: digest(body) } });
    if (this.loseNext) { this.loseNext = false; this.delayed = commit; throw new Error('response lost'); }
    commit();
  }
  async delete(key: string) { this.objects.delete(key); }
}
const dirs: string[] = [];
async function temp() { const p = await mkdtemp(join(tmpdir(), 'pmem-oss-')); dirs.push(p); return p; }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
it('persists uncertainty across restart and blocks later writes until the late write is observed', async () => {
  const gateway = new MemoryGateway(), root = await temp(), id = randomUUID();
  const store = await OssStore.open(gateway, root, 'test', 'pmem/', { initialize: true });
  const notes = new Notes(store); const first = await notes.write(id, Buffer.from('first'), 'create');
  gateway.loseNext = true;
  await expect(notes.write(id, Buffer.from('late'), 'replace', first)).rejects.toMatchObject({ code: 'write_pending' });
  const count = gateway.puts;
  const restarted = new Notes(await OssStore.open(gateway, root, 'test', 'pmem/'));
  await expect(restarted.write(id, Buffer.from('new'), 'replace', first)).rejects.toMatchObject({ code: 'write_pending' });
  expect(gateway.puts).toBe(count);
  gateway.delayed!();
  const late = await restarted.get(id); expect(late.body?.toString()).toBe('late');
  await restarted.write(id, Buffer.from('new'), 'replace', late.etag);
  expect((await restarted.get(id)).body?.toString()).toBe('new');
});
it('uses HEAD for unchanged warm polling, and fails closed on HEAD errors', async () => {
  const gateway = new MemoryGateway(), root = await temp(), id = randomUUID();
  const notes = new Notes(await OssStore.open(gateway, root, 'test', 'pmem/', { initialize: true }));
  await notes.write(id, Buffer.alloc(1024 * 1024, 'a'), 'create');
  const first = await notes.get(id); gateway.gets = 0; gateway.heads = 0;
  for (let i = 0; i < 12; i++) expect((await notes.get(id, first.etag)).body).toBeUndefined();
  expect(gateway.gets).toBe(0); expect(gateway.heads).toBe(12);
  gateway.headFailure = true;
  await expect(notes.get(id, first.etag)).rejects.toThrow('head failed');
  gateway.headFailure = false;
  const cold = new Notes(await OssStore.open(gateway, root, 'test', 'pmem/')); gateway.gets = 0;
  await cold.get(id, first.etag); await cold.get(id, first.etag); expect(gateway.gets).toBe(1);
});
it('refuses a lost or mismatched state volume and versioned buckets without mutating notes', async () => {
  const gateway = new MemoryGateway(), root = await temp();
  await OssStore.open(gateway, root, 'test', 'pmem/', { initialize: true });
  const puts = gateway.puts;
  await expect(OssStore.open(gateway, await temp(), 'test', 'pmem/')).rejects.toThrow('identity missing');
  await expect(OssStore.open(gateway, await temp(), 'test', 'pmem/', { initialize: true })).rejects.toThrow('identity missing');
  expect(gateway.puts).toBe(puts);
  const owner = JSON.parse(await readFile(join(root, 'owner.json'), 'utf8')); owner.stateId = randomUUID(); await writeFile(join(root, 'owner.json'), JSON.stringify(owner));
  await expect(OssStore.open(gateway, root, 'test', 'pmem/')).rejects.toThrow('does not match'); expect(gateway.puts).toBe(puts);
  gateway.version = 'Suspended';
  await expect(OssStore.open(gateway, root, 'test', 'pmem/')).rejects.toThrow('versioning');
});
it('evicts idle and least-recently-used validators and invalidates after writes', async () => {
  const gateway = new MemoryGateway(), root = await temp(), id = randomUUID();
  const notes = new Notes(await OssStore.open(gateway, root, 'test', 'pmem/', { initialize: true }));
  await notes.write(id, Buffer.from('first'), 'create'); const first = await notes.get(id);
  const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 30 * 60_000 + 1); gateway.gets = 0;
  await notes.get(id, first.etag); expect(gateway.gets).toBe(1); vi.restoreAllMocks();
  for (let i = 0; i < 128; i++) { const other = randomUUID(); await gateway.put(`pmem/notes/${other}.md`, Buffer.from('other')); await notes.get(other); }
  gateway.gets = 0; await notes.get(id, first.etag); expect(gateway.gets).toBe(1);
  const updated = await notes.write(id, Buffer.from('updated'), 'replace', first.etag); gateway.gets = 0;
  await notes.get(id, updated); expect(gateway.gets).toBe(1);
  await gateway.put(`pmem/notes/${id}.md`, Buffer.from('changed outside cache'));
  expect((await notes.get(id, updated)).body?.toString()).toBe('changed outside cache');
});
it('explicit initialization resumes the same local identity after an uncertain marker write', async () => {
  const gateway = new MemoryGateway(), root = await temp(); gateway.loseNext = true;
  await expect(OssStore.open(gateway, root, 'test', 'pmem/', { initialize: true })).rejects.toThrow('response lost');
  const owner = await readFile(join(root, 'owner.json'), 'utf8');
  gateway.delayed!(); await OssStore.open(gateway, root, 'test', 'pmem/', { initialize: true });
  expect(await readFile(join(root, 'owner.json'), 'utf8')).toBe(owner);
  expect(gateway.objects.get('pmem/control/state-owner')?.body.toString()).toBe(owner);
});
it('an uncertain deletion blocks replacement across restart until absence is observed', async () => {
  const gateway = new MemoryGateway(), root = await temp(), id = randomUUID();
  const notes = new Notes(await OssStore.open(gateway, root, 'test', 'pmem/', { initialize: true }));
  const etag = await notes.write(id, Buffer.from('retained'), 'create');
  vi.spyOn(gateway, 'delete').mockRejectedValueOnce(new Error('delete response lost'));
  await expect(notes.remove(id, etag)).rejects.toMatchObject({ code: 'write_pending' });
  const restarted = new Notes(await OssStore.open(gateway, root, 'test', 'pmem/'));
  await expect(restarted.write(id, Buffer.from('new'), 'replace', etag)).rejects.toMatchObject({ code: 'write_pending' });
  await gateway.delete(`pmem/notes/${id}.md`); await expect(restarted.get(id)).rejects.toMatchObject({ status: 404 });
  await expect(restarted.write(id, Buffer.from('new'), 'replace', etag)).rejects.toMatchObject({ status: 404 });
});
it('rejects corrupt pending records', async () => {
  const gateway = new MemoryGateway(), root = await temp();
  await OssStore.open(gateway, root, 'test', 'pmem/', { initialize: true });
  await writeFile(join(root, 'pending', `${randomUUID()}.json`), '{}');
  await expect(OssStore.open(gateway, root, 'test', 'pmem/')).rejects.toThrow('Corrupt');
});
