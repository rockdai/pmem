import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { tmpdir, cpus, platform } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../apps/server/src/local';
import { Notes, mapLimit } from '../apps/server/src/storage';
const root = await mkdtemp(join(tmpdir(), 'pmem-list-bench-')), reports = [];
try {
  const store = await LocalStore.create(root), service = new Notes(store), body = '# 列表性能样本\n\n' + '记录思绪。'.repeat(400);
  let snippets = 0, bytes = 0, stats = 0;
  const read = store.read.bind(store), head = store.head.bind(store);
  store.read = async (...args) => { const result = await read(...args); snippets++; bytes += result?.body.length ?? 0; return result; };
  store.head = async id => { stats++; return head(id); };
  for (const size of [1000, 10000]) {
    const ids = Array.from({ length: size }, (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`);
    // Fixture creation is not part of the measured API path.
    await mapLimit(ids, 32, async (id, ..._unused) => { const file = join(store.root, `${id}.md`); await writeFile(file, body); const time = 1700000000 + parseInt(id.slice(-12), 16); await utimes(file, time, time); });
    const samples = [];
    for (let iteration = 0; iteration < 30; iteration++) {
      snippets = bytes = stats = 0; const start = performance.now(); const page = await service.list(); const ms = performance.now() - start;
      assert.equal(page.notes[0].id, ids.at(-1)); assert.equal(page.notes.length, 20); assert.equal(snippets, 20); assert.equal(stats, size);
      samples.push({ ms, statRequests: stats, snippetReads: snippets, snippetBytes: bytes });
    }
    const ordered = samples.map(s => s.ms).sort((a, b) => a - b);
    reports.push({ size, p50: ordered[14], p95: ordered[28], maximum: ordered[29], failures: 0, samples });
    const same = ids.slice(0, 55); await Promise.all(same.map(id => utimes(join(store.root, `${id}.md`), 1800000000, 1800000000)));
    const first = await service.list(undefined, 50), second = await service.list(first.cursor, 50);
    assert.deepEqual([...first.notes, ...second.notes].slice(0, 55).map(n => n.id), same);
  }
  await mkdir('dist/reports', { recursive: true });
  await writeFile('dist/reports/list.json', JSON.stringify({ date: new Date().toISOString(), platform: platform(), cpu: cpus()[0]?.model, note: 'Local temporary filesystem; service.list including full metadata scan, sorting and 20 snippets; no HTTP/network delay; report-only target', reports }, null, 2));
  console.table(reports.map(({ samples, ...summary }) => summary));
} finally { await rm(root, { recursive: true, force: true }); }
