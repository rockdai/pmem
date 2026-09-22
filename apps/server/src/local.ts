import { open, readdir, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { MAX_BYTES, NOTE_ID } from '../../../packages/contracts/src/index';
import { AppError, mapLimit, type Meta, type Store } from './storage';
import { atomicFile, cleanTemporary, directory, missing, syncDirectory } from './files';
export class LocalStore implements Store {
  private constructor(readonly root: string) {}
  static async create(root: string) { const notes = await directory(join(root, 'notes')); await cleanTemporary(notes); return new LocalStore(notes); }
  private async file(id: string) {
    try { return await open(join(this.root, `${id}.md`), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (e) { if (missing(e)) return null; throw e; }
  }
  async head(id: string): Promise<Meta | null> {
    const file = await this.file(id); if (!file) return null;
    try { const stat = await file.stat({ bigint: true }); if (!stat.isFile()) throw new Error('Not a regular note'); return { id, size: Number(stat.size), modified: Number(stat.mtimeMs), validator: `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` }; }
    finally { await file.close(); }
  }
  async read(id: string, limit?: number) {
    const file = await this.file(id); if (!file) return null;
    try {
      const stat = await file.stat({ bigint: true }); if (!stat.isFile()) throw new Error('Not a regular note');
      if (!limit && stat.size > BigInt(MAX_BYTES)) throw new AppError(413, 'too_large');
      const body = Buffer.alloc(Math.min(Number(stat.size), limit ?? MAX_BYTES)); let offset = 0;
      while (offset < body.length) { const { bytesRead } = await file.read(body, offset, body.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
      return { body: body.subarray(0, offset), meta: { id, size: Number(stat.size), modified: Number(stat.mtimeMs), validator: `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` } };
    } finally { await file.close(); }
  }
  async list() {
    const entries = (await readdir(this.root, { withFileTypes: true })).filter(d => d.isFile() && d.name.endsWith('.md') && NOTE_ID.test(d.name.slice(0, -3)));
    return (await mapLimit(entries, 32, e => this.head(e.name.slice(0, -3)))).filter(x => x !== null);
  }
  async create(id: string, body: Buffer) { try { await atomicFile(this.root, `${id}.md`, body, true); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new AppError(409, 'already_exists'); throw e; } }
  async replace(id: string, body: Buffer) { await atomicFile(this.root, `${id}.md`, body); }
  async delete(id: string) { await unlink(join(this.root, `${id}.md`)); await syncDirectory(this.root); }
}
