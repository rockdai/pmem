import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
let root: string;
const children: ChildProcess[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pmem-main-'));
});
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode === null && child.kill()) await once(child, 'exit');
    }),
  );
  await rm(root, { recursive: true, force: true });
});
function start(env: NodeJS.ProcessEnv) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('./main.ts', import.meta.url))],
    {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PMEM_ACCOUNT: 'me',
        PMEM_PASSWORD_HASH: `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`,
        PMEM_SESSION_KEY: 'ab'.repeat(32),
        PMEM_STORAGE: 'local',
        PMEM_DATA_DIR: join(root, 'data'),
        PMEM_STATE_DIR: join(root, 'state'),
        PMEM_ALLOW_INSECURE_HTTP: '',
        HOST: '127.0.0.1',
        ...env,
      },
    },
  );
  children.push(child);
  const log = { text: '' };
  for (const stream of [child.stdout!, child.stderr!])
    stream.on('data', (chunk) => (log.text += chunk));
  return { child, log };
}
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
it('refuses to start on a plaintext HTTP origin outside loopback and names the opt-in', async () => {
  const { child, log } = start({ PMEM_ORIGIN: 'http://notes.lan:3000' });
  const [code] = await once(child, 'exit');
  expect(code).toBe(1);
  expect(log.text).toContain('Startup failed: HTTPS is required');
  expect(log.text).toContain('PMEM_ALLOW_INSECURE_HTTP=1');
});
it('starts on an opted-in HTTP origin and warns that credentials travel in plaintext', async () => {
  const port = await freePort();
  const origin = `http://notes.lan:${port}`;
  const { log } = start({ PMEM_ORIGIN: origin, PMEM_ALLOW_INSECURE_HTTP: '1', PORT: String(port) });
  await vi.waitFor(
    () => {
      expect(log.text).toContain('listening on port');
      expect(log.text).toMatch(/WARNING[^\n]*plaintext/);
    },
    { timeout: 10_000, interval: 50 },
  );
  expect(log.text).toContain(origin);
  expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
});
it('starts quietly on a loopback HTTP origin', async () => {
  const port = await freePort();
  const { log } = start({ PMEM_ORIGIN: `http://localhost:${port}`, PORT: String(port) });
  await vi.waitFor(() => expect(log.text).toContain('listening on port'), {
    timeout: 10_000,
    interval: 50,
  });
  expect(log.text).not.toContain('WARNING');
});
