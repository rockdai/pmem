// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { NOTE_ID } from '../../../packages/contracts/src/index';
import { acquireSlot, uuid } from './drafts';
const slots: Awaited<ReturnType<typeof acquireSlot>>[] = [];
afterEach(() => {
  slots.splice(0).forEach((slot) => slot.release());
  vi.unstubAllGlobals();
  sessionStorage.clear();
});
async function acquire(namespace: string) {
  const slot = await acquireSlot(namespace);
  slots.push(slot);
  return slot;
}
function withWebLocks() {
  const held = new Set<string>();
  vi.stubGlobal('navigator', {
    locks: {
      async request(name: string, _options: LockOptions, callback: LockGrantedCallback<unknown>) {
        if (held.has(name)) return callback(null);
        held.add(name);
        try {
          return await callback({ name, mode: 'exclusive' });
        } finally {
          held.delete(name);
        }
      },
    },
  });
}
function plaintextHttpPage() {
  const getRandomValues = crypto.getRandomValues.bind(crypto);
  vi.stubGlobal('crypto', { getRandomValues });
  expect(navigator.locks).toBeUndefined();
}
it('mints valid, distinct note IDs with and without crypto.randomUUID', () => {
  const native = uuid();
  plaintextHttpPage();
  const ids = Array.from({ length: 200 }, uuid);
  for (const id of [native, ...ids]) expect(id).toMatch(NOTE_ID);
  expect(new Set(ids).size).toBe(200);
});
it('acquires a fresh draft slot per load on a plaintext HTTP page', async () => {
  plaintextHttpPage();
  const first = await acquire('deployment');
  expect(first.id).toMatch(NOTE_ID);
  const second = await acquire('deployment');
  expect(second.id).toMatch(NOTE_ID);
  expect(second.id).not.toBe(first.id);
  second.release();
  const third = await acquire('deployment');
  expect(third.id).toMatch(NOTE_ID);
  expect([first.id, second.id]).not.toContain(third.id);
});
it('avoids occupied slots and reuses a released slot when Web Locks are available', async () => {
  withWebLocks();
  const first = await acquire('deployment');
  const second = await acquire('deployment');
  expect(first.id).toMatch(NOTE_ID);
  expect(second.id).toMatch(NOTE_ID);
  expect(second.id).not.toBe(first.id);
  second.release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const reopened = await acquire('deployment');
  expect(reopened.id).toBe(second.id);
});
it('remembers released slots independently for each deployment', async () => {
  withWebLocks();
  const first = await acquire('first-deployment');
  const second = await acquire('second-deployment');
  expect(first.id).not.toBe(second.id);
  first.release();
  second.release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect((await acquire('first-deployment')).id).toBe(first.id);
  expect((await acquire('second-deployment')).id).toBe(second.id);
});
