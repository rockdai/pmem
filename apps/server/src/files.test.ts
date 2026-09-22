import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicFile, cleanTemporary } from './files';
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof fs>(), open: vi.fn((...args: Parameters<typeof fs.open>) => actualOpen(...args)), rename: vi.fn((...args: Parameters<typeof fs.rename>) => actualRename(...args)) }));
const { open: actualOpen, rename: actualRename } = await vi.importActual<typeof fs>('node:fs/promises');
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), 'pmem-atomic-')); });
afterEach(async () => { vi.mocked(fs.open).mockImplementation(actualOpen); vi.mocked(fs.rename).mockImplementation(actualRename); await fs.rm(root, { force: true, recursive: true }); });
it('a full disk during writing preserves the original file and removes the temporary file', async () => {
  await atomicFile(root, 'note.md', Buffer.from('old'));
  vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
    const file = await actualOpen(...args);
    vi.spyOn(file, 'writeFile').mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    return file;
  });
  await expect(atomicFile(root, 'note.md', Buffer.from('new'))).rejects.toMatchObject({ code: 'ENOSPC' });
  expect(await fs.readFile(join(root, 'note.md'), 'utf8')).toBe('old'); expect(await fs.readdir(root)).toEqual(['note.md']);
});
it('failed publication and exclusive creation cannot replace an existing note', async () => {
  await atomicFile(root, 'note.md', Buffer.from('old'));
  vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error('I/O failure'), { code: 'EIO' }));
  await expect(atomicFile(root, 'note.md', Buffer.from('new'))).rejects.toMatchObject({ code: 'EIO' });
  await expect(atomicFile(root, 'note.md', Buffer.from('new'), true)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await fs.readFile(join(root, 'note.md'), 'utf8')).toBe('old'); expect(await fs.readdir(root)).toEqual(['note.md']);
});
it('startup only removes regular temporary files with the application UUID naming scheme', async () => {
  const name = `.tmp-${crypto.randomUUID()}`;
  await fs.writeFile(join(root, name), 'incomplete'); await fs.writeFile(join(root, '.tmp-user-file'), 'keep');
  await fs.symlink('/etc/passwd', join(root, `.tmp-${crypto.randomUUID()}`));
  await cleanTemporary(root); const names = await fs.readdir(root);
  expect(names).not.toContain(name); expect(names).toContain('.tmp-user-file'); expect(names).toHaveLength(2);
});
