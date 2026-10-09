import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AliGateway, OssStore } from '../apps/server/src/oss';
import { Notes } from '../apps/server/src/storage';
import { loadConfig } from '../apps/server/src/config';
if (process.env.PMEM_OSS_INTEGRATION !== '1')
  throw new Error(
    'Opt-in only: set PMEM_OSS_INTEGRATION=1 and a dedicated empty PMEM_OSS_TEST_PREFIX',
  );
const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing ${key}`);
  return value;
};
const settings = await loadConfig(process.argv[2]);
if (settings.storage !== 'oss' || !settings.oss) throw new Error('Use an OSS configuration file');
const prefix = required('PMEM_OSS_TEST_PREFIX');
if (!/^test-[a-zA-Z0-9_-]+\/$/.test(prefix) || prefix === settings.oss.prefix)
  throw new Error(
    'Test prefix must be test-<unique-name>/ and distinct from the application prefix',
  );
const { bucket, region, endpoint, accessKeyId, accessKeySecret } = settings.oss;
const gateway = new AliGateway(bucket, region, accessKeyId, accessKeySecret, endpoint);
const root = await mkdtemp(join(tmpdir(), 'pmem-oss-live-')),
  id = crypto.randomUUID();
let initialized = false;
try {
  const notes = new Notes(await OssStore.open(gateway, root, bucket, prefix, { initialize: true }));
  initialized = true;
  const body = Buffer.from('# 真实 OSS 集成\n\n只保存 Markdown 内容');
  const first = await notes.write(id, body, 'create');
  assert.deepEqual((await notes.get(id)).body, body);
  assert.equal((await notes.list()).notes[0].id, id);
  for (let i = 0; i < 12; i++) assert.equal((await notes.get(id, first)).body, undefined);
  const next = await notes.write(id, Buffer.from('updated'), 'replace', first);
  await assert.rejects(notes.write(id, Buffer.from('stale'), 'replace', first), { status: 412 });
  const restarted = new Notes(await OssStore.open(gateway, root, bucket, prefix));
  assert.equal((await restarted.get(id)).body?.toString(), 'updated');
  await restarted.remove(id, next);
  await assert.rejects(restarted.get(id), { status: 404 });
  console.log('Real OSS CRUD, list, warm checks, stale write, restart and delete passed.');
} finally {
  // Only the exact keys created by this isolated run are removed; no recursive deletion.
  if (initialized) {
    await gateway.delete(`${prefix}notes/${id}.md`);
    await gateway.delete(`${prefix}control/state-owner`);
  }
  await rm(root, { recursive: true, force: true });
}
