// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { NOTE_ID } from '../../../packages/contracts/src/index';
import { acquireSlot, uuid } from './drafts';
afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});
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
  const first = await acquireSlot('deployment');
  expect(first.id).toMatch(NOTE_ID);
  expect(sessionStorage.getItem('pmem-slot:deployment')).toBe(first.id);
  const second = await acquireSlot('deployment');
  expect(second.id).toMatch(NOTE_ID);
  expect(second.id).not.toBe(first.id);
});
