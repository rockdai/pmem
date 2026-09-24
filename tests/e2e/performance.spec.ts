import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
test('production cold and warm navigation, actual input and durable recovery', async ({
  browser,
}) => {
  test.skip(process.env.PMEM_BENCH !== '1', 'Opt-in 30-sample benchmark: pnpm bench:web');
  test.setTimeout(600_000);
  const weak = process.env.PMEM_BENCH_NETWORK === 'weak',
    characters = Number(process.env.PMEM_BENCH_CHARACTERS ?? 2007);
  if (!Number.isInteger(characters) || characters < 1 || characters > 330000)
    throw new Error('PMEM_BENCH_CHARACTERS must be 1..330000');
  const seed = await browser.newContext({ baseURL: 'http://127.0.0.1:4173' });
  const response = await seed.request.post('/api/v1/auth/login', {
    headers: { origin: 'http://127.0.0.1:4173' },
    data: { account: 'me', password: 'browser-test-password' },
  });
  expect(response.status()).toBe(200);
  const session = await response.json(),
    state = await seed.storageState(),
    id = crypto.randomUUID(),
    initial = '普通笔记测试文字。'.repeat(Math.ceil(characters / 9)).slice(0, characters);
  expect(
    (
      await seed.request.post(`/api/v1/notes/${id}`, {
        headers: {
          origin: 'http://127.0.0.1:4173',
          'x-csrf-token': session.csrf,
          'content-type': 'text/markdown',
        },
        data: initial,
      })
    ).status(),
  ).toBe(201);
  const all: Record<string, unknown[]> = {},
    summary: Record<string, unknown> = {};
  for (const mode of ['cold', 'warm']) {
    const records: Record<string, number>[] = [];
    let failures = 0;
    let context = await browser.newContext({ storageState: state });
    for (let i = 0; i < 30; i++) {
      if (mode === 'cold' && i > 0) {
        await context.close();
        context = await browser.newContext({ storageState: state });
      }
      const page = await context.newPage(),
        cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: weak ? 300 : 150,
        downloadThroughput: (weak ? 1_000_000 : 10_000_000) / 8,
        uploadThroughput: (weak ? 256_000 : 2_000_000) / 8,
      });
      await page.addInitScript(() => {
        document.addEventListener('input', () => performance.mark('pmem:first-input'), {
          once: true,
          capture: true,
        });
      });
      try {
        // Warm samples prime both HTTP and clean-content caches outside the measured navigation.
        if (mode === 'warm' && i === 0) {
          await page.goto(`http://127.0.0.1:4173/#/note/${id}`);
          await expect(page.getByRole('textbox', { name: '笔记正文', exact: true })).toContainText(
            initial,
          );
        }
        await page.goto(`http://127.0.0.1:4173/#/note/${id}`);
        await page.waitForFunction(() => Boolean(document.documentElement.dataset.ready));
        const editor = page.getByRole('textbox', { name: '笔记正文', exact: true });
        await expect(editor).toContainText(initial);
        const ready = await page.evaluate(
          () => performance.getEntriesByName('pmem:ready').at(-1)!.startTime,
        );
        const marker = `样本${mode}${i}`;
        await editor.press('ControlOrMeta+End');
        await page.keyboard.insertText(marker);
        await page.waitForFunction(
          async ({ id, marker }) =>
            new Promise<boolean>((resolve) => {
              const opening = indexedDB.open('pmem-current');
              opening.onsuccess = () => {
                const db = opening.result;
                const reading = db.transaction('drafts').objectStore('drafts').getAll();
                reading.onsuccess = () => {
                  const found = reading.result.some((d) => d.id === id && d.body.includes(marker));
                  db.close();
                  resolve(found);
                };
              };
            }),
          { id, marker },
        );
        const metrics = await page.evaluate(() => {
          const value = (name: string) => performance.getEntriesByName(name).at(-1)?.duration ?? 0;
          const save = performance.getEntriesByName('pmem:draft').at(-1)!,
            input = performance.getEntriesByName('pmem:first-input').at(-1)!;
          return {
            firstInputToDraft: save.startTime + save.duration - input.startTime,
            navigationThroughFirstDraft: save.startTime + save.duration,
            read: value('pmem:read'),
            markdown: value('pmem:markdown'),
            editor: value('pmem:editor'),
            draft: value('pmem:draft'),
            wireBytes: performance
              .getEntriesByType('resource')
              .reduce((n, r) => n + (r as PerformanceResourceTiming).transferSize, 0),
          };
        });
        await expect(page.getByText('已同步', { exact: true })).toBeVisible();
        await page.reload();
        await expect(editor).toContainText(marker);
        records.push({ ready, ...metrics });
      } catch (e) {
        failures++;
        console.error(
          `${mode} sample ${i}: ${e instanceof Error ? e.message.split('\n')[0] : 'failed'}`,
        );
      } finally {
        await page.close();
      }
    }
    await context.close();
    all[mode] = records;
    const percentile = (key: string, percent: number) =>
      records.map((r) => r[key]).sort((a, b) => a - b)[Math.ceil(records.length * percent) - 1];
    summary[mode] = {
      samples: records.length,
      failures,
      readyP50: percentile('ready', 0.5),
      readyP95: percentile('ready', 0.95),
      readyMax: percentile('ready', 1),
      inputP95: percentile('firstInputToDraft', 0.95),
      throughFirstDraftP95: percentile('navigationThroughFirstDraft', 0.95),
    };
  }
  await seed.close();
  await mkdir('dist/reports', { recursive: true });
  const report = {
    date: new Date().toISOString(),
    environment: {
      platform: platform(),
      release: release(),
      cpu: cpus()[0]?.model,
      cpuCount: cpus().length,
      node: process.version,
      browser: browser.version(),
      network: weak
        ? 'CDP 1 Mbps down / 256 Kbps up / 300 ms latency; no packet loss injection; local server; no CPU throttling'
        : 'CDP 10 Mbps down / 2 Mbps up / 150 ms latency; local server; no CPU throttling',
      note: `${characters} Chinese characters; actual input, IndexedDB commit and reload on every sample`,
    },
    summary,
    samples: all,
  };
  const name =
    !weak && characters === 2007
      ? 'navigation'
      : `navigation-${weak ? 'weak' : 'standard'}-${characters}`;
  await writeFile(`dist/reports/${name}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  expect(Object.values(summary).every((s) => (s as { failures: number }).failures === 0)).toBe(
    true,
  );
});
