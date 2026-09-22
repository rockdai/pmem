import { createHash } from 'node:crypto';
import {
  MAX_BYTES,
  NOTE_ID,
  noteTitle,
  type NotePage,
} from '../../../packages/contracts/src/index';
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
export interface Meta {
  id: string;
  modified: number;
  size: number;
  validator: string;
}
export interface Stored {
  body: Buffer;
  meta: Meta;
}
export interface Store {
  list(): Promise<Meta[]>;
  head(id: string): Promise<Meta | null>;
  read(id: string, limit?: number): Promise<Stored | null>;
  create(id: string, body: Buffer): Promise<void>;
  replace(id: string, body: Buffer): Promise<void>;
  delete(id: string): Promise<void>;
  settle?(id: string): Promise<void>;
}
export const digest = (body: Buffer) => `"${createHash('sha256').update(body).digest('hex')}"`;
export function validateId(id: string) {
  if (!NOTE_ID.test(id)) throw new AppError(400, 'invalid_id');
}
export class Serial {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.tails.set(key, result);
    void result
      .finally(() => {
        if (this.tails.get(key) === result) this.tails.delete(key);
      })
      .catch(() => {});
    return result;
  }
}
export async function mapLimit<T, R>(
  input: T[],
  count: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(input.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(count, input.length) }, async () => {
      while (next < input.length) {
        const index = next++;
        output[index] = await fn(input[index]);
      }
    }),
  );
  return output;
}
export class Notes {
  readonly serial = new Serial();
  private cache = new Map<string, { meta: Meta; etag: string; used: number }>();
  constructor(readonly store: Store) {}
  private remember(meta: Meta, etag: string) {
    this.cache.delete(meta.id);
    this.cache.set(meta.id, { meta, etag, used: Date.now() });
    if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
  }
  async get(id: string, condition?: string): Promise<{ etag: string; body?: Buffer }> {
    validateId(id);
    return this.serial.run(id, async () => {
      // The durable uncertainty protocol is always checked before using a cache.
      if (this.store.settle) {
        try {
          await this.store.settle(id);
        } catch (e) {
          this.cache.delete(id);
          throw e;
        }
      }
      const cached = this.cache.get(id);
      if (condition && cached && Date.now() - cached.used < 30 * 60_000) {
        const meta = await this.store.head(id);
        if (!meta) {
          this.cache.delete(id);
          throw new AppError(404, 'not_found');
        }
        if (meta.validator === cached.meta.validator && condition === cached.etag) {
          this.remember(meta, cached.etag);
          return { etag: cached.etag };
        }
      }
      const data = await this.store.read(id);
      if (!data) {
        this.cache.delete(id);
        throw new AppError(404, 'not_found');
      }
      const etag = digest(data.body);
      this.remember(data.meta, etag);
      return { etag, ...(condition === etag ? {} : { body: data.body }) };
    });
  }
  async write(id: string, body: Buffer, mode: 'create' | 'replace', match?: string) {
    validateId(id);
    if (body.length > MAX_BYTES) throw new AppError(413, 'too_large');
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      throw new AppError(400, 'invalid_utf8');
    }
    if (mode === 'replace' && !match) throw new AppError(428, 'precondition_required');
    return this.serial.run(id, async () => {
      this.cache.delete(id);
      await this.store.settle?.(id);
      const current = await this.store.read(id);
      if (mode === 'create') {
        if (current) throw new AppError(409, 'already_exists');
        await this.store.create(id, body);
      } else {
        if (!current) throw new AppError(404, 'not_found');
        if (digest(current.body) !== match) throw new AppError(412, 'conflict');
        if (!current.body.equals(body)) await this.store.replace(id, body);
      }
      return digest(body);
    });
  }
  async remove(id: string, match?: string) {
    validateId(id);
    if (!match) throw new AppError(428, 'precondition_required');
    return this.serial.run(id, async () => {
      this.cache.delete(id);
      await this.store.settle?.(id);
      const current = await this.store.read(id);
      if (!current) throw new AppError(404, 'not_found');
      if (digest(current.body) !== match) throw new AppError(412, 'conflict');
      await this.store.delete(id);
    });
  }
  async list(cursor?: string, limit = 20): Promise<NotePage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new AppError(400, 'invalid_limit');
    let after: { modified: number; id: string } | undefined;
    if (cursor) {
      try {
        after = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      } catch {
        throw new AppError(400, 'invalid_cursor');
      }
      if (!after || !Number.isFinite(after.modified) || !NOTE_ID.test(after.id))
        throw new AppError(400, 'invalid_cursor');
    }
    const all = (await this.store.list()).sort(
      (a, b) => b.modified - a.modified || a.id.localeCompare(b.id),
    );
    const eligible = all.filter(
      (m) =>
        !after || m.modified < after.modified || (m.modified === after.modified && m.id > after.id),
    );
    const page = eligible.slice(0, limit);
    const values = await mapLimit(page, 4, async (meta) => {
      const content = await this.serial.run(meta.id, () => this.store.read(meta.id, 8192));
      if (!content) return null;
      const title = noteTitle(content.body.toString('utf8'));
      return { id: meta.id, modified: meta.modified, title };
    });
    const last = page.at(-1);
    return {
      notes: values.filter((x) => x !== null),
      ...(eligible.length > limit && last
        ? {
            cursor: Buffer.from(JSON.stringify({ modified: last.modified, id: last.id })).toString(
              'base64url',
            ),
          }
        : {}),
    };
  }
}
