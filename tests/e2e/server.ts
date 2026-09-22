import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../apps/server/src/app';
import { config } from '../../apps/server/src/config';
import { hashPassword } from '../../apps/server/src/auth';
import { LocalStore } from '../../apps/server/src/local';
const root = await mkdtemp(join(tmpdir(), 'pmem-browser-'));
const cfg = config({
  PMEM_ACCOUNT: 'me',
  PMEM_PASSWORD_HASH: await hashPassword('browser-test-password'),
  PMEM_SESSION_KEY: 'bc'.repeat(32),
  PMEM_ORIGIN: 'http://127.0.0.1:4173',
  PMEM_DATA_DIR: root,
  PORT: '4173',
});
const app = await createApp(cfg, await LocalStore.create(root));
await app.listen({ host: '127.0.0.1', port: 4173 });
const close = async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGTERM', close);
process.on('SIGINT', close);
