import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const npmEnv = { ...process.env };
for (const key of Object.keys(npmEnv))
  if (/^npm_config_(npm_globalconfig|verify_deps_before_run|_jsr_registry)$/i.test(key))
    delete npmEnv[key];
const root = await mkdtemp(join(tmpdir(), 'pmem-package-'));
const prefix = join(root, 'global');
const env = { ...process.env, HOME: join(root, 'user'), USERPROFILE: join(root, 'user') };
const cwd = join(root, 'unrelated');
const binary = join(prefix, 'bin', 'pmem');
let foreground;
async function cli(args, input) {
  const child = spawn(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (data) => (output += data));
  child.stderr.on('data', (data) => (output += data));
  child.stdin.end(input);
  const [code] = await once(child, 'close');
  assert.equal(code, 0, output);
  return output.trim();
}
const port = await new Promise((resolvePort) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolvePort(port));
  });
});
const origin = `http://localhost:${port}`;
try {
  await mkdir(cwd);
  await mkdir(join(env.HOME, '.pmem'), { recursive: true });
  const { stdout } = await exec(
    'npm',
    [
      'pack',
      ...(process.argv[2] ? [process.argv[2]] : []),
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      root,
    ],
    { env: npmEnv },
  );
  const pack = JSON.parse(stdout)[0];
  assert.equal(pack.name, '@rockdai/pmem');
  const packageRoot = join(prefix, 'lib', 'node_modules', pack.name);
  for (const { path } of pack.files) {
    assert.match(
      path,
      /^(package\.json|README\.md|LICENSE|pmem\.example\.json|docs\/deployment\.md|dist\/server\/cli\.js|dist\/web\/)/,
    );
    assert.doesNotMatch(path, /\.map$|\.env|pmem\.pid|pmem\.log/);
  }
  const installed = await exec(
    'npm',
    [
      'install',
      '--global',
      '--prefix',
      prefix,
      '--no-audit',
      '--no-fund',
      join(root, pack.filename),
    ],
    { env: npmEnv, maxBuffer: 1024 * 1024 },
  );
  if (installed.stderr) process.stderr.write(installed.stderr);
  assert.equal(await cli(['--version']), '0.1.0');
  const help = await cli(['--help']);
  assert.match(help, /~\/\.pmem\/pmem.json/);
  const examplePath = join(packageRoot, 'pmem.example.json');
  assert.ok(help.includes(examplePath));
  assert.equal(JSON.parse(await readFile(examplePath, 'utf8')).storage, 'local');
  const config = {
    account: 'test',
    passwordHash: await cli(['hash-password'], 'package-test-password'),
    sessionKey: await cli(['key']),
    port,
    origin,
  };
  const configPath = join(env.HOME, '.pmem', 'pmem.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  foreground = spawn(binary, ['start', '-c', configPath], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  foreground.stdout.on('data', (data) => (log += data));
  foreground.stderr.on('data', (data) => (log += data));
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`Startup timed out: ${log}`)), 15000);
    foreground.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(log));
    });
    foreground.stdout.on('data', () => {
      if (log.includes('listening on port')) {
        clearTimeout(timer);
        resolveReady();
      }
    });
  });
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<div id="root">/);
  for (const asset of await readdir(
    join(packageRoot, 'dist', 'web', 'assets'),
  )) {
    if (!/\.(js|css)$/.test(asset)) continue;
    const response = await fetch(`${origin}/assets/${asset}`);
    assert.equal(response.status, 200, asset);
    assert.ok((await response.text()).length > 0);
  }
  const login = await fetch(`${origin}/api/v1/auth/login`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ account: 'test', password: 'package-test-password' }),
  });
  assert.equal(login.status, 200);
  const headers = {
    origin,
    cookie: login.headers.get('set-cookie').split(';')[0],
    'x-csrf-token': (await login.json()).csrf,
    'content-type': 'text/markdown',
  };
  const id = '00000000-0000-4000-8000-000000000001';
  assert.equal(
    (
      await fetch(`${origin}/api/v1/notes/${id}`, {
        method: 'POST',
        headers,
        body: '# installed from npm tarball',
      })
    ).status,
    201,
  );
  assert.equal(
    await readFile(join(env.HOME, '.pmem', 'data', 'notes', `${id}.md`), 'utf8'),
    '# installed from npm tarball',
  );
  const exited = once(foreground, 'exit');
  assert.match(await cli(['stop']), /stopped/);
  await exited;
  assert.match(await cli(['start', '-d']), /started in background/);
  assert.equal((await fetch(`${origin}/healthz`)).status, 200);
  const note = await fetch(`${origin}/api/v1/notes/${id}`, { headers });
  assert.equal(note.status, 200);
  assert.equal(await note.text(), '# installed from npm tarball');
  assert.match(await cli(['stop']), /stopped/);
  assert.match(await cli(['stop']), /not running/);
  console.log(
    `Package smoke passed: ${pack.name}@${pack.version}; global install, assets, login, persistence, foreground and daemon lifecycle.`,
  );
} finally {
  try {
    await cli(['stop']);
  } catch {}
  if (foreground?.exitCode === null && foreground?.signalCode === null) {
    foreground.kill('SIGTERM');
    await once(foreground, 'exit');
  }
  await rm(root, { recursive: true, force: true });
}
