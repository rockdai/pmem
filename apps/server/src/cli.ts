#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import packageInfo from '../../../package.json' with { type: 'json' };
import { hashPassword } from './auth';
import { defaultConfigPath, expandPath, loadConfig } from './config';
import { runService, startDaemon, stopService } from './daemon';
import { runtime } from './runtime';
import { changePassword } from './passwd';
const example = new URL(
  existsSync(new URL('../../pmem.example.json', import.meta.url))
    ? '../../pmem.example.json'
    : '../../../pmem.example.json',
  import.meta.url,
);
const help = `Personal Memory ${packageInfo.version}
Usage:
  pmem start [-d|--daemon] [-c|--config <path>]
  pmem stop
  pmem passwd [-c|--config <path>]    Change password interactively
  pmem key
  pmem hash-password                 Read a password from stdin
  pmem init-oss [-c|--config <path>]
  pmem --version

Default config: ~/.pmem/pmem.json
Example: ${fileURLToPath(example)}
Create the config from the example and fill passwordHash (pmem hash-password)
and sessionKey (pmem key). Relative data paths resolve beside the config file.
One service per user. Background log: ~/.pmem/pmem.log
`;
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' },
      daemon: { type: 'boolean', short: 'd' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  const command = positionals[0];
  if (values.help || (!command && !values.version)) console.log(help);
  else if (values.version && !command) console.log(packageInfo.version);
  else {
    if (
      positionals.length !== 1 ||
      values.version ||
      (values.daemon && command !== 'start') ||
      (values.config && !['start', 'init-oss', 'passwd'].includes(command))
    )
      throw new Error('Invalid arguments; see pmem --help');
    const path = expandPath(values.config ?? defaultConfigPath());
    if (command === 'start') {
      const settings = await loadConfig(path);
      if (values.daemon) await startDaemon(fileURLToPath(import.meta.url), path);
      else await runService(settings, path);
    } else if (command === 'stop') await stopService();
    else if (command === 'passwd') await changePassword(path);
    else if (command === 'key') console.log(randomBytes(32).toString('hex'));
    else if (command === 'hash-password') {
      if (process.stdin.isTTY)
        throw new Error('Pass the password on stdin; do not use command-line arguments');
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      console.log(
        await hashPassword(
          Buffer.concat(chunks)
            .toString('utf8')
            .replace(/\r?\n$/, ''),
        ),
      );
    } else if (command === 'init-oss') {
      const settings = await loadConfig(path);
      if (settings.storage !== 'oss') throw new Error('Set storage to oss before initialization');
      await runtime(settings, true);
      console.log('OSS state identity verified. Ready to start.');
    } else throw new Error(`Unknown command; see pmem --help`);
  }
} catch (e) {
  console.error(
    e instanceof Error && !('requestId' in e)
      ? e.message.split('\n')[0]
      : 'OSS operation failed; verify permissions and state identity',
  );
  process.exitCode = 1;
}
