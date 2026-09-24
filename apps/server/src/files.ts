import { constants } from 'node:fs';
import { open, mkdir, realpath, rename, link, unlink, lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
export const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
export async function directory(path: string) {
  const absolute = resolve(path);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  if ((await lstat(absolute)).isSymbolicLink())
    throw new Error('Storage directory must not be a symlink');
  return realpath(absolute);
}
export async function syncDirectory(path: string) {
  const f = await open(path, 'r');
  try {
    await f.sync();
  } finally {
    await f.close();
  }
}
export async function readRegular(path: string, limit?: number): Promise<Buffer | null> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Not a regular file');
    const buffer = Buffer.alloc(Math.min(stat.size, limit ?? stat.size));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    await file.close();
  }
}
export async function atomicFile(dir: string, name: string, body: Buffer, create = false) {
  const temporary = join(dir, `.tmp-${randomUUID()}`),
    target = join(dir, name);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(body);
      await file.sync();
    } finally {
      await file.close();
    }
    if (create) {
      await link(temporary, target);
      await unlink(temporary);
    } else {
      try {
        if ((await lstat(target)).isSymbolicLink()) throw new Error('Symlink target rejected');
      } catch (e) {
        if (!missing(e)) throw e;
      }
      await rename(temporary, target);
    }
    await syncDirectory(dir);
  } finally {
    await unlink(temporary).catch((e) => {
      if (!missing(e)) throw e;
    });
  }
}
// Called only at single-writer startup; never follow links or remove user-named files.
export async function cleanTemporary(dir: string) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      /^\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(entry.name)
    )
      await unlink(join(dir, entry.name));
  }
  await syncDirectory(dir);
}
