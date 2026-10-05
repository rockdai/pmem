import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../apps/server/src/app';
import { config } from '../../apps/server/src/config';
import { hashPassword } from '../../apps/server/src/auth';
import { LocalStore } from '../../apps/server/src/local';
const passwordHash = await hashPassword('browser-test-password');
async function start(port: number, origin: string, env: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pmem-browser-'));
  const cfg = config({
    PMEM_ACCOUNT: 'me',
    PMEM_PASSWORD_HASH: passwordHash,
    PMEM_SESSION_KEY: 'bc'.repeat(32),
    PMEM_ORIGIN: origin,
    PMEM_DATA_DIR: root,
    PORT: String(port),
    ...env,
  });
  const app = await createApp(cfg, await LocalStore.create(root));
  await app.listen({ host: '127.0.0.1', port });
  return { app, root };
}
// Playwright only waits for 4173, so it must come up last.
const servers = [
  await start(4174, 'http://pmem.test:4174', { PMEM_ALLOW_INSECURE_HTTP: '1' }),
  await start(4173, 'http://127.0.0.1:4173'),
];
const close = async () => {
  for (const { app, root } of servers) {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
  process.exit(0);
};
process.on('SIGTERM', close);
process.on('SIGINT', close);
