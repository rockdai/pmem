import OSS from 'ali-oss';
import { errorIdentity, type StorageDiagnostic } from './diagnostics';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, statfs, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MAX_BYTES, NOTE_ID } from '../../../packages/contracts/src/index';
import { AppError, digest, type Meta, type Store } from './storage';
import { atomicFile, cleanTemporary, directory, readRegular, syncDirectory } from './files';

export interface ObjectInfo {
  key: string;
  modified: number;
  size: number;
  validator: string;
}
export interface ObjectData {
  body: Buffer;
  info: ObjectInfo;
}
export interface ObjectGateway {
  versioning(): Promise<string | undefined>;
  list(prefix: string): Promise<ObjectInfo[]>;
  get(key: string, limit?: number): Promise<ObjectData | null>;
  head(key: string): Promise<ObjectInfo | null>;
  put(key: string, body: Buffer, exclusive?: boolean): Promise<void>;
  delete(key: string): Promise<void>;
}
const absent = (e: unknown) => (e as { code?: string }).code === 'NoSuchKey';
export class AliGateway implements ObjectGateway {
  readonly client: OSS;
  constructor(
    readonly bucket: string,
    region: string,
    accessKeyId: string,
    accessKeySecret: string,
    endpoint?: string,
  ) {
    this.client = new OSS({
      bucket,
      region,
      accessKeyId,
      accessKeySecret,
      secure: true,
      timeout: 15_000,
      ...(endpoint ? { endpoint } : {}),
      retryMax: 0,
    } as OSS.Options);
  }
  async versioning() {
    const result = await (
      this.client as unknown as {
        getBucketVersioning(bucket: string): Promise<{ versionStatus?: string }>;
      }
    ).getBucketVersioning(this.bucket);
    return result.versionStatus;
  }
  private info(key: string, headers: Record<string, string>): ObjectInfo {
    const size = Number(headers['content-range']?.split('/')[1] ?? headers['content-length']);
    if (!Number.isFinite(size) || !headers.etag || !headers['last-modified'])
      throw new Error('OSS metadata missing');
    return {
      key,
      size,
      modified: Date.parse(headers['last-modified']),
      validator: `${headers.etag}:${headers['last-modified']}:${size}`,
    };
  }
  async list(prefix: string) {
    const all: ObjectInfo[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.listV2({
        prefix,
        'max-keys': 1000,
        ...(token ? { 'continuation-token': token } : {}),
      });
      all.push(
        ...(page.objects ?? []).map((o) => ({
          key: o.name,
          size: o.size,
          modified: Date.parse(o.lastModified),
          validator: `${o.etag}:${o.lastModified}:${o.size}`,
        })),
      );
      if (page.isTruncated && (!page.nextContinuationToken || token === page.nextContinuationToken))
        throw new Error('Invalid OSS pagination');
      token = page.isTruncated ? page.nextContinuationToken : undefined;
    } while (token);
    return all;
  }
  async get(key: string, limit?: number): Promise<ObjectData | null> {
    try {
      const result = await this.client.getStream(
        key,
        limit ? { headers: { Range: `bytes=0-${limit - 1}` } } : {},
      );
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const value of result.stream) {
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (!limit && total > MAX_BYTES) {
          result.stream.destroy();
          throw new AppError(413, 'too_large');
        }
        chunks.push(chunk);
        if (limit && total >= limit) {
          result.stream.destroy();
          break;
        }
      }
      return {
        body: Buffer.concat(chunks).subarray(0, limit ?? MAX_BYTES),
        info: this.info(key, result.res.headers as Record<string, string>),
      };
    } catch (e) {
      if (absent(e)) return null;
      if (limit && (e as { status?: number }).status === 416) return this.get(key);
      throw e;
    }
  }
  async head(key: string) {
    try {
      const result = await this.client.head(key);
      return this.info(key, result.res.headers as Record<string, string>);
    } catch (e) {
      if (absent(e)) return null;
      throw e;
    }
  }
  async put(key: string, body: Buffer, exclusive = false) {
    await this.client.put(key, body, {
      mime: key.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'application/json',
      headers: {
        ...(exclusive ? { 'x-oss-forbid-overwrite': 'true' } : {}),
        'Cache-Control': 'no-store',
      },
    });
  }
  async delete(key: string) {
    await this.client.delete(key);
  }
}

interface Owner {
  schema: 1;
  stateId: string;
  bucket: string;
  prefix: string;
}
interface Pending {
  schema: 1;
  id: string;
  requestId: string;
  operation: 'create' | 'replace' | 'delete';
  before: string | null;
  target: string | null;
}
const hashPattern = /^"[0-9a-f]{64}"$/;
export async function checkStateMount(path: string, container = false) {
  if (process.platform !== 'linux') return;
  const info = await statfs(path);
  if ([0x01021994, 0x858458f6].includes(Number(info.type)))
    throw new Error('OSS state directory must not use tmpfs or ramfs');
  if (container) {
    const mounts = (await readFile('/proc/self/mountinfo', 'utf8')).split('\n');
    const unescape = (s: string) =>
      s.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
    if (!mounts.some((line) => unescape(line.split(' ')[4] ?? '') === resolve(path)))
      throw new Error('OSS state directory requires a dedicated persistent volume mount');
  }
}

export class OssStore implements Store {
  private pending = new Map<string, Pending>();
  private constructor(
    readonly gateway: ObjectGateway,
    readonly root: string,
    readonly bucket: string,
    readonly prefix: string,
  ) {}
  private key(id: string) {
    return `${this.prefix}notes/${id}.md`;
  }
  private meta(id: string, info: ObjectInfo): Meta {
    return { id, modified: info.modified, size: info.size, validator: info.validator };
  }
  private static validateOwner(value: unknown, bucket: string, prefix: string): value is Owner {
    const o = value as Owner | null;
    return Boolean(
      o && o.schema === 1 && NOTE_ID.test(o.stateId) && o.bucket === bucket && o.prefix === prefix,
    );
  }
  static async open(
    gateway: ObjectGateway,
    root: string,
    bucket: string,
    prefix: string,
    options: { initialize?: boolean; container?: boolean } = {},
  ) {
    root = await directory(root);
    await checkStateMount(root, options.container);
    const version = await gateway.versioning();
    if (version !== undefined && version !== '')
      throw new Error('OSS bucket versioning must never have been enabled (including Suspended)');
    const markerKey = `${prefix}control/state-owner`;
    let local = await readRegular(join(root, 'owner.json'), 4096);
    let remote = await gateway.get(markerKey);
    if (options.initialize && !remote) {
      if ((await gateway.list(`${prefix}notes/`)).length)
        throw new Error('Initialization requires an empty notes prefix');
      if (!local) {
        local = Buffer.from(
          JSON.stringify({ schema: 1, stateId: randomUUID(), bucket, prefix } satisfies Owner),
        );
        await atomicFile(root, 'owner.json', local, true);
      }
      const owner: unknown = JSON.parse(local.toString());
      if (!this.validateOwner(owner, bucket, prefix))
        throw new Error('State identity does not match storage');
      // No automatic replay if PUT is uncertain: the next explicit init uses the same identity.
      await gateway.put(markerKey, local, true);
      remote = await gateway.get(markerKey);
    }
    if (!local || !remote)
      throw new Error(
        'OSS state identity missing; mount the original volume or initialize an empty prefix',
      );
    const a: unknown = JSON.parse(local.toString()),
      b: unknown = JSON.parse(remote.body.toString());
    if (
      !this.validateOwner(a, bucket, prefix) ||
      !this.validateOwner(b, bucket, prefix) ||
      a.stateId !== b.stateId
    )
      throw new Error('OSS state volume does not match remote identity');
    await directory(join(root, 'pending'));
    // Check actual write/fsync capability before serving, without treating this as durability proof.
    await atomicFile(root, '.probe', Buffer.from('pmem'));
    if ((await readRegular(join(root, '.probe')))?.toString() !== 'pmem')
      throw new Error('OSS state probe readback failed');
    await unlink(join(root, '.probe'));
    await syncDirectory(root);
    const store = new OssStore(gateway, root, bucket, prefix);
    for (const name of await readdir(join(root, 'pending'))) {
      if (name.startsWith('.tmp-')) continue;
      const body = await readRegular(join(root, 'pending', name), 8192);
      const p = JSON.parse(body?.toString() ?? '') as Pending;
      if (
        p.schema !== 1 ||
        !NOTE_ID.test(p.id) ||
        name !== `${p.id}.json` ||
        !NOTE_ID.test(p.requestId) ||
        !['create', 'replace', 'delete'].includes(p.operation) ||
        (p.before !== null && !hashPattern.test(p.before)) ||
        (p.operation === 'delete' ? p.target !== null : !hashPattern.test(p.target ?? ''))
      )
        throw new Error('Corrupt OSS pending state; refusing writes');
      store.pending.set(p.id, p);
    }
    await cleanTemporary(root);
    await cleanTemporary(join(root, 'pending'));
    return store;
  }
  async list() {
    return (await this.gateway.list(`${this.prefix}notes/`)).flatMap((info) => {
      const id = info.key.slice(`${this.prefix}notes/`.length, -3);
      return info.key.endsWith('.md') && NOTE_ID.test(id) ? [this.meta(id, info)] : [];
    });
  }
  async head(id: string) {
    const info = await this.gateway.head(this.key(id));
    return info ? this.meta(id, info) : null;
  }
  async read(id: string, limit?: number) {
    const data = await this.gateway.get(this.key(id), limit);
    return data ? { body: data.body, meta: this.meta(id, data.info) } : null;
  }
  private async clear(id: string) {
    await unlink(join(this.root, 'pending', `${id}.json`));
    await syncDirectory(join(this.root, 'pending'));
    this.pending.delete(id);
  }
  private uncertain(record: Pending, stage: StorageDiagnostic['stage'], error: unknown) {
    return new AppError(503, 'write_pending', {
      ...errorIdentity(error),
      stage,
      operation: record.operation,
      noteId: record.id,
      operationId: record.requestId,
    });
  }
  async settle(id: string) {
    const p = this.pending.get(id);
    if (!p) return;
    let current;
    try {
      current = await this.read(id);
    } catch (error) {
      throw this.uncertain(p, 'pending_verify', error);
    }
    if (
      p.target === null ? current === null : current !== null && digest(current.body) === p.target
    ) {
      try {
        await this.clear(id);
      } catch (error) {
        throw this.uncertain(p, 'pending_clear', error);
      }
    } else throw this.uncertain(p, 'pending_verify', { code: 'TargetNotObserved' });
  }
  private async change(
    id: string,
    body: Buffer | null,
    operation: Pending['operation'],
    before: string | null,
  ) {
    await this.settle(id);
    const record: Pending = {
      schema: 1,
      id,
      requestId: randomUUID(),
      operation,
      before,
      target: body === null ? null : digest(body),
    };
    // The caller has already read and verified before under the per-note lock.
    // Keep the in-memory guard even if recording fails ambiguously. Nothing is sent before fsync.
    this.pending.set(id, record);
    try {
      await atomicFile(
        join(this.root, 'pending'),
        `${id}.json`,
        Buffer.from(JSON.stringify(record)),
      );
    } catch (error) {
      throw this.uncertain(record, 'pending_record', error);
    }
    try {
      if (body === null) await this.gateway.delete(this.key(id));
      else await this.gateway.put(this.key(id), body, operation === 'create');
    } catch (error) {
      // Only this exact forbid-overwrite rejection proves that the create was not applied.
      const failure = error as { code?: string; status?: number } | null;
      if (
        operation === 'create' &&
        failure?.code === 'FileAlreadyExists' &&
        failure.status === 409
      ) {
        try {
          await this.clear(id);
        } catch (cleanupError) {
          throw this.uncertain(record, 'pending_clear', cleanupError);
        }
        throw new AppError(409, 'already_exists');
      }
      throw this.uncertain(record, 'oss_request', error);
    }
    try {
      await this.clear(id);
    } catch (error) {
      throw this.uncertain(record, 'pending_clear', error);
    }
  }
  async create(id: string, body: Buffer) {
    await this.change(id, body, 'create', null);
  }
  async replace(id: string, body: Buffer, before: string) {
    await this.change(id, body, 'replace', before);
  }
  async delete(id: string, before: string) {
    await this.change(id, null, 'delete', before);
  }
}
