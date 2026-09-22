import type { BlockReason } from '../../../packages/contracts/src/index';
export interface Submission {
  body: string;
  base: string | null;
  rev: number;
  kind: 'create' | 'replace' | 'delete';
}
export interface Draft {
  key: string;
  namespace: string;
  slot: string;
  id: string;
  body: string;
  base: string | null;
  rev: number;
  modified: number;
  meaningful: boolean;
  block?: BlockReason;
  pending?: Submission;
}
export interface Clean {
  key: string;
  namespace: string;
  id: string;
  body: string;
  etag: string;
}
export type DraftStore = Pick<
  Drafts,
  'put' | 'get' | 'all' | 'cached' | 'clean' | 'remove' | 'forget' | 'clear' | 'close'
>;
const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
const complete = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Local save failed'));
  });
export class Drafts {
  private constructor(private db: IDBDatabase) {}
  static async open(name = 'pmem-current') {
    const opening = indexedDB.open(name, 1);
    opening.onupgradeneeded = () => {
      opening.result.createObjectStore('drafts', { keyPath: 'key' });
      opening.result.createObjectStore('clean', { keyPath: 'key' });
    };
    return new Drafts(await request(opening));
  }
  static unavailable(): DraftStore {
    return {
      put: async () => {
        throw new Error('Browser storage unavailable');
      },
      get: async () => undefined,
      all: async () => [],
      cached: async () => undefined,
      clean: async () => {},
      remove: async () => {},
      forget: async () => {},
      clear: async () => {},
      close() {},
    };
  }
  close() {
    this.db.close();
  }
  async put(draft: Draft) {
    const start = performance.now();
    const tx = this.db.transaction('drafts', 'readwrite'),
      done = complete(tx);
    tx.objectStore('drafts').put(structuredClone(draft));
    await done;
    performance.clearMeasures('pmem:draft');
    performance.measure('pmem:draft', { start, end: performance.now() });
  }
  async get(key: string): Promise<Draft | undefined> {
    return request(this.db.transaction('drafts').objectStore('drafts').get(key));
  }
  async all(namespace: string): Promise<Draft[]> {
    const rows = await request<Draft[]>(
      this.db.transaction('drafts').objectStore('drafts').getAll(),
    );
    return rows.filter((d) => d.namespace === namespace).sort((a, b) => b.modified - a.modified);
  }
  async cached(namespace: string, id: string): Promise<Clean | undefined> {
    return request(this.db.transaction('clean').objectStore('clean').get(`${namespace}:${id}`));
  }
  async clean(
    namespace: string,
    id: string,
    body: string,
    etag: string,
    draft?: { key: string; rev: number },
  ) {
    const tx = this.db.transaction(['drafts', 'clean'], 'readwrite'),
      done = complete(tx);
    tx.objectStore('clean').put({
      key: `${namespace}:${id}`,
      namespace,
      id,
      body,
      etag,
    } satisfies Clean);
    if (draft) {
      const get = tx.objectStore('drafts').get(draft.key);
      get.onsuccess = () => {
        if (get.result?.rev === draft.rev) tx.objectStore('drafts').delete(draft.key);
      };
    }
    await done;
  }
  async remove(key: string, rev?: number) {
    const tx = this.db.transaction('drafts', 'readwrite'),
      done = complete(tx),
      store = tx.objectStore('drafts');
    if (rev === undefined) store.delete(key);
    else {
      const get = store.get(key);
      get.onsuccess = () => {
        if (get.result?.rev === rev) store.delete(key);
      };
    }
    await done;
  }
  async forget(namespace: string, id: string) {
    const tx = this.db.transaction('clean', 'readwrite'),
      done = complete(tx);
    tx.objectStore('clean').delete(`${namespace}:${id}`);
    await done;
  }
  async clear(namespace: string) {
    const tx = this.db.transaction(['drafts', 'clean'], 'readwrite'),
      done = complete(tx);
    for (const name of ['drafts', 'clean']) {
      const cursor = tx.objectStore(name).openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (c) {
          if (c.value.namespace === namespace) c.delete();
          c.continue();
        }
      };
    }
    await done;
  }
}
export async function acquireSlot(namespace: string): Promise<{ id: string; release: () => void }> {
  let id = sessionStorage.getItem(`pmem-slot:${namespace}`) ?? crypto.randomUUID();
  if (!navigator.locks) {
    id = crypto.randomUUID();
    sessionStorage.setItem(`pmem-slot:${namespace}`, id);
    return { id, release() {} };
  }
  while (true) {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = await new Promise<boolean>((resolve, reject) => {
      void navigator.locks
        .request(`pmem:${namespace}:${id}`, { ifAvailable: true }, async (lock) => {
          resolve(Boolean(lock));
          if (lock) await hold;
        })
        .catch(reject);
    });
    if (acquired) {
      sessionStorage.setItem(`pmem-slot:${namespace}`, id);
      return { id, release };
    }
    id = crypto.randomUUID();
  }
}
export async function removeOrphan(db: DraftStore, draft: Draft) {
  if (!navigator.locks) return;
  await navigator.locks.request(
    `pmem:${draft.namespace}:${draft.slot}`,
    { ifAvailable: true },
    async (lock) => {
      if (lock) await db.remove(draft.key, draft.rev);
    },
  );
}
