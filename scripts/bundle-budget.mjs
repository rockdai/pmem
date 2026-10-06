import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
const entries = [];
for (const file of await readdir('dist/web/assets')) {
  if (/\.(js|css)$/.test(file)) {
    const body = await readFile(`dist/web/assets/${file}`),
      gzip = gzipSync(body);
    entries.push({ file, bytes: body.length, gzip: gzip.length });
    await writeFile(`dist/web/assets/${file}.gz`, gzip);
  }
}
const total = (suffix) =>
  entries.filter((e) => e.file.endsWith(suffix)).reduce((n, e) => n + e.gzip, 0);
const scripts = entries.filter((e) => e.file.endsWith('.js')),
  largest = Math.max(...scripts.map((e) => e.bytes)),
  html = await readFile('dist/web/index.html', 'utf8'),
  unlinked = scripts.filter((e) => !html.includes(`/assets/${e.file}`)).map((e) => e.file);
console.table(entries);
console.log(
  `All JS: ${total('.js')} / ${250 * 1024} gzip bytes; all CSS: ${total('.css')} / ${30 * 1024}; largest JS chunk: ${largest} / 500000 bytes`,
);
if (unlinked.length) console.log(`JS chunks index.html neither loads nor preloads: ${unlinked}`);
await mkdir('dist/reports', { recursive: true });
await writeFile(
  'dist/reports/bundle.json',
  JSON.stringify({ entries, js: total('.js'), css: total('.css'), largest }, null, 2),
);
if (total('.js') > 250 * 1024 || total('.css') > 30 * 1024 || largest > 500000 || unlinked.length)
  process.exitCode = 1;
