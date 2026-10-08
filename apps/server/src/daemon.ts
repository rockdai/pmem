import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pmemHome, type Config } from './config';
import { startServer } from './main';
interface ServiceRecord {
  pid: number;
  port: number;
  token: string;
}
const recordPath = () => join(pmemHome(), 'pmem.pid');
export const logPath = () => join(pmemHome(), 'pmem.log');
async function readRecord(): Promise<ServiceRecord | null> {
  let body: string;
  try {
    body = await readFile(recordPath(), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    const record = JSON.parse(body);
    if (
      !Number.isInteger(record.pid) ||
      record.pid <= 1 ||
      !Number.isInteger(record.port) ||
      record.port < 1 ||
      record.port > 65535 ||
      !/^[a-f0-9]{64}$/.test(record.token)
    )
      throw new Error();
    return record;
  } catch {
    throw new Error(
      `Invalid service record: ${recordPath()}. Check running pmem processes before removing it.`,
    );
  }
}
async function removeRecord(token: string) {
  if ((await readRecord())?.token !== token) return;
  try {
    await unlink(recordPath());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw e;
  }
}
export async function stopService() {
  const record = await readRecord();
  if (!record) {
    console.log('pmem is not running.');
    return;
  }
  if (!alive(record.pid)) {
    await removeRecord(record.token);
    console.log('pmem is not running; removed stale service record.');
    return;
  }
  // Authenticate the live service instead of signaling a possibly reused PID.
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${record.port}/stop`, {
      method: 'POST',
      headers: { authorization: `Bearer ${record.token}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error(
      `Cannot reach the recorded pmem service. Check ${logPath()} and PID ${record.pid}; no process was killed.`,
    );
  }
  if (!response.ok)
    throw new Error(
      'The recorded pmem service could not be stopped; retry when startup completes.',
    );
  await response.text();
  console.log('pmem stopped.');
}
export async function runService(settings: Config) {
  await mkdir(pmemHome(), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  let stopping: Promise<void> | undefined;
  const shutdown = () =>
    (stopping ??= (async () => {
      await app?.close();
      await removeRecord(token);
    })());
  const control = createServer((request, response) => {
    if (
      request.method !== 'POST' ||
      request.url !== '/stop' ||
      request.headers.authorization !== `Bearer ${token}`
    ) {
      response.writeHead(404).end();
      return;
    }
    if (!app) {
      response.writeHead(409).end();
      return;
    }
    void shutdown()
      .then(() => {
        response.writeHead(200).end('stopped');
        control.close();
      })
      .catch(() => {
        response.writeHead(500).end();
      });
  });
  control.requestTimeout = 5000;
  control.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    control.once('error', reject);
    control.listen(0, '127.0.0.1', resolve);
  });
  let ownsRecord = false;
  try {
    let file;
    try {
      file = await open(recordPath(), 'wx', 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error(
          'pmem already has a service record. Use pmem stop before starting again (also clears stale records).',
        );
      throw e;
    }
    ownsRecord = true;
    try {
      await file.writeFile(
        JSON.stringify({ pid: process.pid, port: (control.address() as AddressInfo).port, token }),
      );
    } finally {
      await file.close();
    }
    app = await startServer(settings);
  } catch (e) {
    try {
      if (ownsRecord) await unlink(recordPath());
    } finally {
      control.close();
    }
    throw e;
  }
  const onSignal = () => {
    void shutdown()
      .then(() => control.close())
      .catch(() => {
        console.error('Shutdown failed; inspect the service log before restarting.');
        process.exitCode = 1;
        control.close();
      });
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  control.once('close', () => {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
  });
  if (process.env.PMEM_DAEMON_CHILD === '1' && process.send) {
    process.send({ ready: true, pid: process.pid });
    process.disconnect();
  }
}
export async function startDaemon(entry: string, configPath: string) {
  await mkdir(pmemHome(), { recursive: true, mode: 0o700 });
  const log = await open(logPath(), 'a', 0o600);
  const child = spawn(process.execPath, [...process.execArgv, entry, 'start', '-c', configPath], {
    detached: true,
    env: { ...process.env, PMEM_DAEMON_CHILD: '1' },
    stdio: ['ignore', log.fd, log.fd, 'ipc'],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Daemon startup timed out; see ${logPath()}`));
      }, 30_000);
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        error ? reject(error) : resolve();
      };
      child.once('error', finish);
      child.once('exit', (code) =>
        finish(new Error(`Daemon failed to start (exit ${code}); see ${logPath()}`)),
      );
      child.once('message', (message) => {
        if (message && typeof message === 'object' && 'ready' in message && message.ready === true)
          finish();
      });
    });
    console.log(`pmem started in background (PID ${child.pid}). Log: ${logPath()}`);
  } finally {
    await log.close();
    child.unref();
  }
}
