import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { config, defaultConfigPath, loadConfig } from './config';
const base = {
  account: 'me',
  passwordHash: `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`,
  sessionKey: 'ab'.repeat(32),
};
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pmem-config-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
it('loads JSON with stable paths, defaults and home expansion', async () => {
  const path = join(root, 'pmem.json');
  await writeFile(path, JSON.stringify({ ...base, port: 4321, stateDir: '~/pmem-state' }));
  const result = await loadConfig(path);
  expect(result.port).toBe(4321);
  expect(result.origin).toBe('http://localhost:4321');
  expect(result.dataDir).toBe(join(root, 'data'));
  expect(result.stateDir).toBe(join(homedir(), 'pmem-state'));
  expect(result.sessionKey).toEqual(Buffer.from(base.sessionKey, 'hex'));
  expect(defaultConfigPath()).toBe(join(homedir(), '.pmem', 'pmem.json'));
});
it('reports missing, unreadable and malformed files without exposing their contents', async () => {
  const path = join(root, 'pmem.json');
  await expect(loadConfig(path)).rejects.toThrow('Configuration not found');
  await mkdir(path);
  await expect(loadConfig(path)).rejects.toThrow('Cannot read configuration');
  await rm(path, { recursive: true });
  await writeFile(path, '{"secret":"do-not-print",');
  await expect(loadConfig(path)).rejects.toThrow('Invalid JSON');
  try {
    await loadConfig(path);
  } catch (e) {
    expect(String(e)).not.toContain('do-not-print');
  }
});
it.each([
  null,
  [],
  'text',
  {},
  { ...base, sessionKey: 'secret' },
  { ...base, passwordHash: 'secret' },
  { ...base, account: 1 },
  { ...base, port: '3000' },
  { ...base, port: null },
  { ...base, storage: null },
  { ...base, port: 0 },
  { ...base, port: 65536 },
  { ...base, port: 1.5 },
  { ...base, host: '' },
  { ...base, storage: 'unknown' },
  { ...base, allowInsecureHttp: 'true' },
  { ...base, dataDir: null },
  { ...base, origin: 'https://example.com/' },
  { ...base, origin: 'https://me:secret@example.com' },
  { ...base, origin: 'not-a-url' },
  { ...base, unknown: true },
  { ...base, storage: 'oss' },
])('rejects invalid configuration %#', (input) => {
  expect(() => config(input)).toThrow();
});
it('validates the nested OSS credentials and prefix', () => {
  const oss = {
    bucket: 'test-bucket',
    region: 'oss-cn-hangzhou',
    prefix: 'pmem/',
    accessKeyId: 'id',
    accessKeySecret: 'secret',
  };
  expect(config({ ...base, storage: 'oss', oss }).oss).toEqual(oss);
  expect(() => config({ ...base, storage: 'oss', oss: { ...oss, prefix: '../' } })).toThrow(
    'prefix',
  );
  expect(() => config({ ...base, storage: 'oss', oss: { ...oss, accessKeySecret: '' } })).toThrow(
    'accessKeySecret',
  );
  expect(() => config({ ...base, storage: 'oss', oss: { ...oss, typo: true } })).toThrow(
    'Unknown oss',
  );
});
