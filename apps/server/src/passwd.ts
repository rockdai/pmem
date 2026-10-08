import { constants } from 'node:fs';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { hashPassword } from './auth';
import { config } from './config';
import { reloadPassword } from './daemon';
import { missing, syncDirectory } from './files';

async function promptPassword() {
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new Error('pmem passwd requires an interactive terminal');
  const output = new Writable({ write: (_chunk, _encoding, done) => done() });
  const rl = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  const cancel = () => {
    process.stderr.write('\n');
    rl.close();
  };
  try {
    return await new Promise<string>((resolve, reject) => {
      let first: string | undefined;
      rl.on('SIGINT', cancel);
      rl.on('SIGTSTP', cancel);
      process.once('SIGTERM', cancel);
      process.once('SIGINT', cancel);
      rl.once('error', () => reject(new Error('Cannot read password from terminal')));
      rl.once('close', () => reject(new Error('Password change cancelled')));
      rl.on('line', (line) => {
        process.stderr.write('\n');
        if (first === undefined) {
          first = line;
          process.stderr.write('Confirm new password: ');
        } else if (first !== line)
          reject(new Error('Passwords do not match; password unchanged'));
        else resolve(line);
      });
      process.stderr.write('New password (at least 12 characters): ');
    });
  } finally {
    rl.close();
    process.off('SIGTERM', cancel);
    process.off('SIGINT', cancel);
    output.destroy();
  }
}

export async function changePassword(path: string) {
  const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let original: string, owner;
  try {
    owner = await source.stat();
    if (!owner.isFile()) throw new Error('Configuration must be a regular file');
    original = await source.readFile('utf8');
  } finally {
    await source.close();
  }
  let values;
  try {
    values = JSON.parse(original);
  } catch {
    throw new Error(`Invalid JSON in configuration: ${path}`);
  }
  config(values, dirname(path));
  const passwordHash = await hashPassword(await promptPassword());
  const temporary = join(dirname(path), `.${basename(path)}-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      if (
        process.getuid &&
        (owner.uid !== process.getuid() || owner.gid !== process.getgid!())
      )
        await file.chown(owner.uid, owner.gid);
      values.passwordHash = passwordHash;
      await file.writeFile(JSON.stringify(values, null, 2) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    const current = await lstat(path);
    if (
      current.ino !== owner.ino ||
      current.dev !== owner.dev ||
      (await readFile(path, 'utf8')) !== original
    )
      throw new Error('Configuration changed while entering the password; please retry');
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await unlink(temporary).catch((e) => {
      if (!missing(e)) throw e;
    });
  }
  const result = await reloadPassword(path);
  console.log(
    result === 'applied'
      ? 'Password changed. Existing sessions are signed out.'
      : `Password saved to ${path}. It will take effect when this configuration is started.`,
  );
}
