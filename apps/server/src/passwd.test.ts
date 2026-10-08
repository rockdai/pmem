import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkPassword, hashPassword } from './auth';

const ptyRunner = `
import json, os, pty, select, signal, subprocess, sys, termios, time
master, slave = pty.openpty()
before = termios.tcgetattr(slave)
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
def terminate(*_):
    raise SystemExit(1)
signal.signal(signal.SIGTERM, terminate)
deadline = time.monotonic() + 20
try:
    while True:
        ready, _, _ = select.select([master, sys.stdin], [], [], 0.05)
        if master in ready:
            data = os.read(master, 65536)
            if data:
                print(json.dumps({'output': data.decode('utf-8', errors='replace')}), flush=True)
        if sys.stdin in ready:
            line = sys.stdin.readline()
            if not line:
                raise RuntimeError('Terminal driver closed')
            message = json.loads(line)
            if 'signal' in message:
                os.kill(child.pid, getattr(signal, message['signal']))
            else:
                os.write(master, message['input'].encode())
        if child.poll() is not None:
            while select.select([master], [], [], 0)[0]:
                data = os.read(master, 65536)
                if not data: break
                print(json.dumps({'output': data.decode('utf-8', errors='replace')}), flush=True)
            after = termios.tcgetattr(slave)
            flags = termios.ECHO | termios.ICANON
            print(json.dumps({'code': child.returncode, 'restored': before[3] & flags == after[3] & flags}), flush=True)
            break
        if time.monotonic() > deadline:
            raise RuntimeError('Interactive command timed out')
finally:
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait()
    os.close(master)
    os.close(slave)
`;
const entry = fileURLToPath(new URL('./cli.ts', import.meta.url));
const command = ['--import', import.meta.resolve('tsx'), entry];
const oldPassword = 'original-password-123';
const newPassword = 'new-$password-中文-123';
const children: ChildProcess[] = [];
let root: string, path: string, port: number;
let original: Record<string, unknown>;
const env = () => ({ ...process.env, HOME: root, USERPROFILE: root });

function cli(args: string[]) {
  const child = spawn(process.execPath, [...command, ...args], {
    cwd: root,
    env: env(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const log = { text: '' };
  for (const stream of [child.stdout!, child.stderr!])
    stream.on('data', (data) => (log.text += data));
  const done = once(child, 'close').then(([code]) => ({ code, text: log.text }));
  return { child, log, done };
}
function terminal(args = ['passwd']) {
  const child = spawn(
    'python3',
    ['-u', '-c', ptyRunner, process.execPath, ...command, ...args],
    {
      cwd: root,
      env: env(),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  children.push(child);
  const log = { text: '', errors: '' };
  let result: { code: number; restored: boolean } | undefined;
  createInterface({ input: child.stdout! }).on('line', (line) => {
    const message = JSON.parse(line);
    if ('output' in message) log.text += message.output;
    else result = message;
  });
  child.stderr!.on('data', (data) => (log.errors += data));
  const done = once(child, 'close').then(([code]) => {
    expect(log.errors).toBe('');
    expect(code).toBe(0);
    expect(result?.restored).toBe(true);
    return { ...result!, text: log.text };
  });
  const send = (input: string) => child.stdin!.write(JSON.stringify({ input }) + '\n');
  const signal = (name: string) => child.stdin!.write(JSON.stringify({ signal: name }) + '\n');
  const ready = () =>
    vi.waitFor(() => expect(log.text).toContain('New password'), { timeout: 10000 });
  return { child, log, done, send, signal, ready };
}
async function passwd(args = ['passwd'], password = newPassword) {
  const prompt = terminal(args);
  await prompt.ready();
  prompt.send(password + '\n' + password + '\n');
  const result = await prompt.done;
  expect(result.text).not.toContain(password);
  expect(result.text).toContain('Confirm new password');
  return result;
}
async function login(password: string) {
  return fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
    method: 'POST',
    headers: { origin: `http://localhost:${port}`, 'content-type': 'application/json' },
    body: JSON.stringify({ account: 'me', password }),
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pmem-passwd-'));
  path = join(root, '.pmem', 'pmem.json');
  await mkdir(join(root, '.pmem'));
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  original = {
    account: 'me',
    passwordHash: await hashPassword(oldPassword),
    sessionKey: 'ab'.repeat(32),
    port,
    dataDir: 'notes-data',
    origin: `http://localhost:${port}`,
  };
  await writeFile(path, JSON.stringify(original), { mode: 0o600 });
});
afterEach(async () => {
  await cli(['stop']).done;
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin?.end();
      child.kill('SIGTERM');
      await once(child, 'close');
    }
  }
  await rm(root, { recursive: true, force: true });
});

it('rejects noninteractive input without changing the configuration', async () => {
  expect((await cli(['passwd']).done).text).toContain('interactive terminal');
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(original);
});

describe.skipIf(process.platform === 'win32')('interactive password changes', () => {
  it.each([false, true])(
    'changes only the password hash with a custom path: %s',
    async (custom) => {
      const target = custom ? join(root, 'custom config.json') : path;
      if (custom) await writeFile(target, JSON.stringify(original), { mode: 0o600 });
      const before = await stat(target);
      const result = await passwd(custom ? ['passwd', '-c', 'custom config.json'] : undefined);
      expect(result.code).toBe(0);
      expect(result.text).toContain('Password saved');
      const changed = JSON.parse(await readFile(target, 'utf8'));
      expect(await checkPassword(newPassword, changed.passwordHash)).toBe(true);
      expect(await checkPassword(oldPassword, changed.passwordHash)).toBe(false);
      expect({ ...changed, passwordHash: original.passwordHash }).toEqual(original);
      const after = await stat(target);
      expect(after.mode & 0o777).toBe(0o600);
      expect([after.uid, after.gid]).toEqual([before.uid, before.gid]);
      if (custom) expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(original);
    },
  );

  it.each([false, true])(
    'applies the password and invalidates sessions without restarting (daemon: %s)',
    async (daemon) => {
      const target = daemon ? join(root, 'active config ?#密.json') : path;
      if (daemon) await writeFile(target, JSON.stringify(original), { mode: 0o600 });
      const args = daemon ? ['start', '-d', '-c', target] : ['start'];
      const running = cli(args);
      if (daemon) expect((await running.done).code).toBe(0);
      else
        await vi.waitFor(() => expect(running.log.text).toContain('listening on port'), {
          timeout: 10000,
        });
      const record = await readFile(join(root, '.pmem', 'pmem.pid'), 'utf8');
      const session = await login(oldPassword);
      expect(session.status).toBe(200);
      const cookie = session.headers.get('set-cookie')!.split(';')[0];
      const result = await passwd(daemon ? ['passwd', '-c', target] : undefined);
      expect(result.code).toBe(0);
      expect(result.text).toContain('Existing sessions are signed out');
      expect(await readFile(join(root, '.pmem', 'pmem.pid'), 'utf8')).toBe(record);
      expect((await login(oldPassword)).status).toBe(401);
      expect((await login(newPassword)).status).toBe(200);
      expect(
        (await fetch(`http://127.0.0.1:${port}/api/v1/auth/session`, { headers: { cookie } }))
          .status,
      ).toBe(401);
      expect((await cli(['stop']).done).code).toBe(0);
      expect((await cli(['start', '-d', '-c', target]).done).code).toBe(0);
      expect((await login(newPassword)).status).toBe(200);
    },
  );

  it.each([
    ['mismatch', newPassword + '\nother-password-123\n', 'do not match'],
    ['short', 'short\nshort\n', 'at least 12'],
    ['empty', '\n\n', 'at least 12'],
    ['oversized', '密'.repeat(350) + '\n' + '密'.repeat(350) + '\n', 'at most 1024'],
    ['cancel', '\x03', 'cancelled'],
    ['cancel confirmation', newPassword + '\n\x03', 'cancelled'],
    ['EOF', '\x04', 'cancelled'],
  ])('keeps the config and restores the terminal on %s', async (_name, input, error) => {
    const before = await readFile(path, 'utf8');
    const prompt = terminal();
    await prompt.ready();
    prompt.send(input);
    const result = await prompt.done;
    expect(result.code).toBe(1);
    expect(result.text).toContain(error);
    expect(result.text).not.toContain(newPassword);
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(await readdir(join(root, '.pmem'))).toEqual(['pmem.json']);
  });

  it('restores the terminal when terminated during input', async () => {
    const prompt = terminal();
    await prompt.ready();
    prompt.signal('SIGTERM');
    expect((await prompt.done).code).toBe(1);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(original);
  });

  it.each([12, 1024])(
    'accepts a password at the length boundary of %i ASCII characters',
    async (length) => {
      const password = 'a'.repeat(length);
      expect((await passwd(undefined, password)).code).toBe(0);
      expect(
        await checkPassword(password, JSON.parse(await readFile(path, 'utf8')).passwordHash),
      ).toBe(true);
    },
  );

  it('does not overwrite a configuration edited while entering the password', async () => {
    const prompt = terminal();
    await prompt.ready();
    const edited = { ...original, account: 'changed' };
    await writeFile(path, JSON.stringify(edited));
    prompt.send(newPassword + '\n' + newPassword + '\n');
    const result = await prompt.done;
    expect(result.code).toBe(1);
    expect(result.text).toContain('Configuration changed');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(edited);
    expect(await readdir(join(root, '.pmem'))).toEqual(['pmem.json']);
  });

  it('reports that a saved password requires a restart when the service cannot be reached', async () => {
    const record = join(root, '.pmem', 'pmem.pid');
    await writeFile(
      record,
      JSON.stringify({ pid: process.pid, port, token: 'cd'.repeat(32) }),
    );
    try {
      const result = await passwd();
      expect(result.code).toBe(1);
      expect(result.text).toContain('Password saved, but');
      expect(
        await checkPassword(
          newPassword,
          JSON.parse(await readFile(path, 'utf8')).passwordHash,
        ),
      ).toBe(true);
    } finally {
      await rm(record);
    }
  });

  it('does not apply another configuration or permit unauthenticated password reloads', async () => {
    expect((await cli(['start', '-d']).done).code).toBe(0);
    const record = JSON.parse(await readFile(join(root, '.pmem', 'pmem.pid'), 'utf8'));
    const control = `http://127.0.0.1:${record.port}/reload-password?config=${encodeURIComponent(path)}`;
    expect((await fetch(control, { method: 'POST' })).status).toBe(404);
    const custom = join(root, 'another.json');
    await writeFile(custom, JSON.stringify(original));
    const result = await passwd(['passwd', '-c', custom]);
    expect(result.code).toBe(0);
    expect(result.text).toContain('when this configuration is started');
    expect((await login(oldPassword)).status).toBe(200);
    expect((await login(newPassword)).status).toBe(401);
  });

  it('requires a restart when other configuration fields also changed', async () => {
    expect((await cli(['start', '-d']).done).code).toBe(0);
    await writeFile(path, JSON.stringify({ ...original, account: 'another-account' }));
    const result = await passwd();
    expect(result.code).toBe(1);
    expect(result.text).toContain('Restart pmem');
    expect((await login(oldPassword)).status).toBe(200);
    expect((await login(newPassword)).status).toBe(401);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    expect(saved.account).toBe('another-account');
    expect(await checkPassword(newPassword, saved.passwordHash)).toBe(true);
  });

  it('preserves hidden input when editing with backspace', async () => {
    const prompt = terminal();
    await prompt.ready();
    prompt.send(newPassword + 'x\x7f\n' + newPassword + '\n');
    const result = await prompt.done;
    expect(result.code).toBe(0);
    expect(result.text).not.toContain(newPassword);
    expect(
      await checkPassword(newPassword, JSON.parse(await readFile(path, 'utf8')).passwordHash),
    ).toBe(true);
  });

  it('handles repeated and overlapping reloads without changing other settings', async () => {
    expect((await cli(['start', '-d']).done).code).toBe(0);
    expect((await passwd()).code).toBe(0);
    const nextPassword = 'another-new-password-456';
    expect((await passwd(undefined, nextPassword)).code).toBe(0);
    const record = JSON.parse(await readFile(join(root, '.pmem', 'pmem.pid'), 'utf8'));
    const url = `http://127.0.0.1:${record.port}/reload-password?config=${encodeURIComponent(await realpath(path))}`;
    const responses = await Promise.all(
      Array.from({ length: 3 }, () =>
        fetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${record.token}` },
        }),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect((await login(newPassword)).status).toBe(401);
    expect((await login(nextPassword)).status).toBe(200);
  });

  it('rejects malformed and symlink configurations without prompting or disclosing content', async () => {
    await writeFile(path, '{"secret":"never-print-this",');
    let result = await terminal().done;
    expect(result.code).toBe(1);
    expect(result.text).toContain('Invalid JSON');
    expect(result.text).not.toContain('never-print-this');
    expect(result.text).not.toContain('New password');
    const target = join(root, 'target.json');
    await writeFile(target, JSON.stringify(original));
    await rm(path);
    await symlink(target, path);
    result = await terminal().done;
    expect(result.code).toBe(1);
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual(original);
  });
});
