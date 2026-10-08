import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import packageInfo from '../../../package.json' with { type: 'json' };
let root: string, path: string, port: number;
const children: ChildProcess[] = [];
const entry = fileURLToPath(new URL('./cli.ts', import.meta.url));
const base = {
  account: 'me',
  passwordHash: `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`,
  sessionKey: 'ab'.repeat(32),
};
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pmem-cli-'));
  path = join(root, '.pmem', 'pmem.json');
  await mkdir(join(root, '.pmem'));
  port = await freePort();
  await writeFile(path, JSON.stringify({ ...base, port }));
});
function launch(args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), entry, ...args], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: root, USERPROFILE: root, ...env },
  });
  children.push(child);
  const log = { text: '' };
  for (const stream of [child.stdout!, child.stderr!])
    stream.on('data', (chunk) => (log.text += chunk));
  const done = once(child, 'close').then(([code]) => ({ code, text: log.text }));
  return { child, log, done };
}
const cli = (args: string[]) => launch(args).done;
const healthy = () => fetch(`http://127.0.0.1:${port}/healthz`);
afterEach(async () => {
  await cli(['stop']);
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  }
  await rm(root, { recursive: true, force: true });
});
it.each(['SIGTERM', 'SIGINT'] as const)(
  'starts from the default home config, ignores .env and environment overrides, and shuts down on %s',
  async (signal) => {
    await writeFile(join(root, '.env'), 'PORT=1\nPMEM_ACCOUNT=wrong\n');
    const { child, log, done } = launch(['start'], { PORT: '1', PMEM_ACCOUNT: 'wrong' });
    await vi.waitFor(() => expect(log.text).toContain('listening on port'), { timeout: 10000 });
    expect((await healthy()).status).toBe(200);
    expect(log.text).not.toContain('WARNING');
    expect((await stat(join(root, '.pmem', 'data', 'notes'))).isDirectory()).toBe(true);
    child.kill(signal);
    expect((await done).code).toBe(0);
    expect((await cli(['stop'])).text).toContain('not running');
  },
);
it('resolves a custom config and relative data directory independently of the working directory', async () => {
  const custom = join(root, 'config folder');
  await mkdir(custom);
  await writeFile(
    join(custom, 'custom.json'),
    JSON.stringify({ ...base, port, dataDir: 'notes-data' }),
  );
  const { log } = launch(['start', '-c', 'config folder/custom.json']);
  await vi.waitFor(() => expect(log.text).toContain('listening on port'), { timeout: 10000 });
  expect((await stat(join(custom, 'notes-data', 'notes'))).isDirectory()).toBe(true);
  expect((await healthy()).status).toBe(200);
});
it('refuses plaintext HTTP outside loopback and names the JSON opt-in', async () => {
  await writeFile(path, JSON.stringify({ ...base, port, origin: 'http://notes.lan:3000' }));
  const result = await cli(['start']);
  expect(result.code).toBe(1);
  expect(result.text).toContain('HTTPS is required');
  expect(result.text).toContain('allowInsecureHttp: true');
});
it('warns when the configuration explicitly allows plaintext HTTP', async () => {
  await writeFile(
    path,
    JSON.stringify({ ...base, port, origin: `http://notes.lan:${port}`, allowInsecureHttp: true }),
  );
  const { log } = launch(['start']);
  await vi.waitFor(() => expect(log.text).toMatch(/WARNING[^\n]*plaintext/), { timeout: 10000 });
  expect((await healthy()).status).toBe(200);
});
it('starts a detached daemon, refuses duplicate starts, and stops it without needing the config file', async () => {
  const custom = join(root, 'custom config.json');
  await writeFile(custom, await readFile(path));
  const started = await cli(['start', '-d', '-c', custom]);
  expect(started.code).toBe(0);
  expect(started.text).toContain('started in background');
  expect((await healthy()).status).toBe(200);
  expect((await cli(['start', '-d'])).code).toBe(1);
  expect((await healthy()).status).toBe(200);
  expect(await readFile(join(root, '.pmem', 'pmem.log'), 'utf8')).toContain('listening on port');
  if (process.platform !== 'win32')
    expect((await stat(join(root, '.pmem', 'pmem.pid'))).mode & 0o777).toBe(0o600);
  await rm(path);
  await rm(custom);
  const record = JSON.parse(await readFile(join(root, '.pmem', 'pmem.pid'), 'utf8'));
  expect((await fetch(`http://127.0.0.1:${record.port}/stop`, { method: 'POST' })).status).toBe(
    404,
  );
  expect((await healthy()).status).toBe(200);
  expect((await cli(['stop'])).code).toBe(0);
  await expect(healthy()).rejects.toThrow();
  expect((await cli(['stop'])).text).toContain('not running');
});
it('allows only one of two concurrent daemon starts', async () => {
  const results = await Promise.all([cli(['start', '-d']), cli(['start', '-d'])]);
  expect(results.map((result) => result.code).sort()).toEqual([0, 1]);
  expect((await healthy()).status).toBe(200);
});
it('reports daemon bind failures and releases the service record for retry', async () => {
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(port, '127.0.0.1', resolve));
  try {
    const result = await cli(['start', '-d']);
    expect(result.code).toBe(1);
    expect(result.text).toContain('Daemon failed to start');
    expect(await readFile(join(root, '.pmem', 'pmem.log'), 'utf8')).toContain('EADDRINUSE');
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
  expect((await cli(['start', '-d'])).code).toBe(0);
});
it('clears stale records after a crashed service so it can restart', async () => {
  const { child, log, done } = launch(['start']);
  await vi.waitFor(() => expect(log.text).toContain('listening on port'), { timeout: 10000 });
  child.kill('SIGKILL');
  await done;
  expect((await cli(['stop'])).text).toContain('stale service record');
  expect((await cli(['start', '-d'])).code).toBe(0);
});
it('does not signal an unrelated process referenced by a stale record', async () => {
  const record = join(root, '.pmem', 'pmem.pid');
  await writeFile(record, JSON.stringify({ pid: process.pid, port, token: 'ab'.repeat(32) }));
  expect((await cli(['stop'])).code).toBe(1);
  expect(process.kill(process.pid, 0)).toBe(true);
  await rm(record);
});
it.each([
  ['start', '--bogus'],
  ['start', '-c'],
  ['stop', '-d'],
  ['start', 'extra'],
  ['unknown'],
  ['passwd', '-d'],
  ['passwd', 'secret'],
])(
  'rejects invalid CLI arguments: %j',
  async (...args) => {
    expect((await cli(args)).code).toBe(1);
  },
);
it('provides help and version without configuration', async () => {
  await rm(path);
  expect((await cli(['--version'])).text.trim()).toBe(packageInfo.version);
  expect((await cli(['--help'])).text).toContain('~/.pmem/pmem.json');
  const missing = await cli(['start']);
  expect(missing.code).toBe(1);
  expect(missing.text).toContain('Configuration not found');
});
