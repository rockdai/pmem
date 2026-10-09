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
const oss = {
  bucket: 'test-bucket',
  region: 'oss-cn-hangzhou',
  accessKeyId: 'id',
  accessKeySecret: 'secret',
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
it('validates the nested OSS credentials and defaults to the bucket root', () => {
  expect(config({ ...base, storage: 'oss', oss }).oss).toEqual({ ...oss, prefix: '' });
  expect(() => config({ ...base, storage: 'oss', oss: { ...oss, accessKeySecret: '' } })).toThrow(
    'accessKeySecret',
  );
  expect(() => config({ ...base, storage: 'oss', oss: { ...oss, typo: true } })).toThrow(
    'Unknown oss',
  );
});
it.each([
  [undefined, ''],
  ['', ''],
  ['personal/', 'personal/'],
  ['team/notes/', 'team/notes/'],
])('loads an optional OSS prefix from JSON: %s', async (prefix, expected) => {
  const path = join(root, 'pmem.json');
  await writeFile(path, JSON.stringify({ ...base, storage: 'oss', oss: { ...oss, prefix } }));
  expect((await loadConfig(path)).oss?.prefix).toBe(expected);
});
it.each([
  null,
  true,
  123,
  {},
  [],
  ' ',
  '/',
  '../',
  'personal',
  '/personal/',
  'a//b/',
  'a/../',
  'a/\n',
  'a/\0',
])('rejects an invalid OSS prefix: %#', (prefix) => {
  expect(() => config({ ...base, storage: 'oss', oss: { ...oss, prefix } })).toThrow(
    'OSS prefix must be empty or a simple relative path ending in /',
  );
});
it.each([
  ['oss-cn-hangzhou-internal.aliyuncs.com', 'https://oss-cn-hangzhou-internal.aliyuncs.com'],
  [
    'https://oss-cn-hangzhou-internal.aliyuncs.com/',
    'https://oss-cn-hangzhou-internal.aliyuncs.com',
  ],
  ['https://oss-cn-hangzhou.aliyuncs.com', 'https://oss-cn-hangzhou.aliyuncs.com'],
  ['vpc100-oss-cn-hangzhou.aliyuncs.com', 'https://vpc100-oss-cn-hangzhou.aliyuncs.com'],
  ['https://vpc100-oss-cn-hangzhou.aliyuncs.com/', 'https://vpc100-oss-cn-hangzhou.aliyuncs.com'],
  [
    'oss-cn-shanghai-internal.aliyuncs.com:443',
    'https://oss-cn-shanghai-internal.aliyuncs.com',
  ],
])('loads an OSS endpoint without a region from JSON: %s', async (endpoint, expected) => {
  const path = join(root, 'pmem.json');
  await writeFile(
    path,
    JSON.stringify({ ...base, storage: 'oss', oss: { ...oss, region: undefined, endpoint } }),
  );
  const result = (await loadConfig(path)).oss;
  expect(result?.endpoint).toBe(expected);
  expect(result?.region).toBeUndefined();
});
it('accepts both an OSS region and an endpoint', () => {
  const endpoint = 'https://oss-cn-hangzhou-internal.aliyuncs.com';
  expect(config({ ...base, storage: 'oss', oss: { ...oss, endpoint } }).oss).toEqual({
    ...oss,
    endpoint,
    prefix: '',
  });
});
it.each([
  ['test-bucket', 'test-bucket.oss-cn-hangzhou.aliyuncs.com'],
  ['test-bucket', 'https://test-bucket.oss-cn-hangzhou.aliyuncs.com'],
  ['test-bucket', 'test-bucket.oss-cn-hangzhou-internal.aliyuncs.com'],
  ['test-bucket', 'https://test-bucket.oss-cn-hangzhou-internal.aliyuncs.com/'],
  ['test-bucket', 'https://TEST-BUCKET.OSS-CN-HANGZHOU-INTERNAL.ALIYUNCS.COM:443/'],
  ['test-bucket', 'test-bucket.oss-cn-hangzhou-internal.aliyuncs.com.:8443'],
  ['another-bucket', 'https://another-bucket.oss-cn-shanghai-internal.aliyuncs.com:8443'],
  ['test-bucket', 'https://test-bucket.oss-accelerate.aliyuncs.com'],
  ['test-bucket', 'https://test-bucket.cn-hangzhou.oss.aliyuncs.com'],
  ['test-bucket', 'test-bucket.vpc100-oss-cn-hangzhou.aliyuncs.com'],
  ['test-bucket', 'https://test-bucket.vpc100-oss-cn-hangzhou.aliyuncs.com'],
  ['another-bucket', 'https://ANOTHER-BUCKET.VPC100-OSS-CN-SHANGHAI.ALIYUNCS.COM.:8443/'],
])('rejects a bucket-qualified OSS endpoint for %s: %s', async (bucket, endpoint) => {
  const path = join(root, 'pmem.json');
  for (const region of [undefined, oss.region]) {
    await writeFile(
      path,
      JSON.stringify({ ...base, storage: 'oss', oss: { ...oss, bucket, region, endpoint } }),
    );
    await expect(loadConfig(path)).rejects.toThrow(
      /^oss\.endpoint must be an OSS service endpoint without the oss\.bucket hostname prefix$/,
    );
  }
});
it.each([
  ['oss', 'oss-cn-hangzhou.aliyuncs.com'],
  ['oss-cn-hangzhou', 'oss-cn-hangzhou.aliyuncs.com'],
  ['oss-cn-hangzhou-internal', 'oss-cn-hangzhou-internal.aliyuncs.com'],
  ['cn-hangzhou', 'cn-hangzhou.oss.aliyuncs.com'],
  ['vpc100-oss-cn-hangzhou', 'vpc100-oss-cn-hangzhou.aliyuncs.com'],
])('accepts a service endpoint whose name overlaps with bucket %s', (bucket, endpoint) => {
  expect(
    config({ ...base, storage: 'oss', oss: { ...oss, bucket, region: undefined, endpoint } }).oss,
  ).toMatchObject({ bucket, endpoint: `https://${endpoint}` });
});
it('rejects an OSS config with neither region nor endpoint', async () => {
  const path = join(root, 'pmem.json');
  await writeFile(
    path,
    JSON.stringify({ ...base, storage: 'oss', oss: { ...oss, region: undefined } }),
  );
  await expect(loadConfig(path)).rejects.toThrow('oss.region or oss.endpoint is required');
});
it.each([null, true, 123, {}, [], '', '\0'])(
  'rejects an invalid explicit OSS region even when an endpoint is supplied: %#',
  (region) => {
    expect(() =>
      config({
        ...base,
        storage: 'oss',
        oss: { ...oss, region, endpoint: 'https://oss-cn-hangzhou-internal.aliyuncs.com' },
      }),
    ).toThrow('Invalid or missing configuration: region');
  },
);
it.each([
  'bad region!',
  ' oss-cn-hangzhou',
  'oss-cn-hangzhou ',
  'oss-cn-hangzhou\n',
  'oss.cn.hangzhou',
  'oss-cn/hangzhou',
  'oss-cn\thangzhou',
  '杭州',
  'oss-cn?token=private-secret',
])(
  'rejects an invalid OSS region format with or without an endpoint: %#',
  (region) => {
    for (const endpoint of [undefined, 'oss-cn-hangzhou-internal.aliyuncs.com']) {
      expect(() => config({ ...base, storage: 'oss', oss: { ...oss, region, endpoint } })).toThrow(
        /^oss\.region must contain only letters, digits, underscores or hyphens$/,
      );
    }
  },
);
it.each(['oss-cn-hangzhou', 'oss-cn-shanghai', 'OSS-test_REGION-1'])(
  'accepts a valid explicit region alongside an endpoint: %s',
  (region) => {
    const endpoint = 'https://oss-cn-hangzhou-internal.aliyuncs.com';
    expect(config({ ...base, storage: 'oss', oss: { ...oss, region, endpoint } }).oss).toMatchObject({
      region,
      endpoint,
    });
  },
);
it.each([
  '127.0.0.1',
  'https://192.168.0.1:8443/',
  '127.1',
  '2130706433',
  '0x7f000001',
  'https://0177.0.0.1',
  '127.0.0.1.',
])(
  'rejects an IP OSS endpoint with or without a region: %s',
  (endpoint) => {
    for (const region of [undefined, oss.region]) {
      expect(() => config({ ...base, storage: 'oss', oss: { ...oss, region, endpoint } })).toThrow(
        /^oss\.endpoint must use a DNS hostname instead of an IP address$/,
      );
    }
  },
);
it.each([
  null,
  true,
  123,
  {},
  '',
  ' ',
  'https://',
  'https://[::1]',
  '[::1]',
  'http://oss-cn-hangzhou-internal.aliyuncs.com',
  'ftp://oss-cn-hangzhou-internal.aliyuncs.com',
  'https://private-id:private-secret@oss-cn-hangzhou-internal.aliyuncs.com',
  'https://oss-cn-hangzhou-internal.aliyuncs.com/pmem/',
  'https://oss-cn-hangzhou-internal.aliyuncs.com/../',
  'https://oss-cn-hangzhou-internal.aliyuncs.com?secret=private-secret',
  'https://oss-cn-hangzhou-internal.aliyuncs.com#fragment',
  'oss-cn-hangzhou-internal.aliyuncs.com:65536',
  'oss-cn-hangzhou-internal.aliyuncs.com\n',
  'https://oss-cn-hangzhou-internal.aliyuncs.com\\path',
])('rejects an invalid OSS endpoint without exposing its value: %#', (endpoint) => {
  expect(() => config({ ...base, storage: 'oss', oss: { ...oss, endpoint } })).toThrow(
    /^oss\.endpoint must be a hostname or HTTPS URL without credentials, path, query or fragment$/,
  );
});
