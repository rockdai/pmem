import { test, expect, type BrowserContext, type Page } from '@playwright/test';
let cachedLogin:
  | {
      cookies: Awaited<ReturnType<BrowserContext['cookies']>>;
      session: { csrf: string; deployment: string };
    }
  | undefined;
async function login(context: BrowserContext) {
  if (!cachedLogin) {
    const response = await context.request.post('/api/v1/auth/login', {
      headers: { origin: 'http://127.0.0.1:4173' },
      data: { account: 'me', password: 'browser-test-password' },
    });
    expect(response.status()).toBe(200);
    cachedLogin = { cookies: await context.cookies(), session: await response.json() };
  } else await context.addCookies(cachedLogin.cookies);
  return cachedLogin.session;
}
async function ready(page: Page) {
  await expect(page.getByRole('textbox', { name: '笔记正文', exact: true })).toBeVisible();
}
async function openMarkdown(page: Page, context: BrowserContext, body: string) {
  const session = await login(context);
  const id = crypto.randomUUID();
  const response = await context.request.post(`/api/v1/notes/${id}`, {
    headers: {
      origin: 'http://127.0.0.1:4173',
      'x-csrf-token': session.csrf,
      'content-type': 'text/markdown',
    },
    data: body,
  });
  expect(response.status()).toBe(201);
  await page.goto(`/#/note/${id}`);
  await ready(page);
  return id;
}

for (const modifier of ['Control', 'Meta']) {
  test(`${modifier}+A stays inside the current code block including repeated selection`, async ({
    page,
    context,
  }) => {
    const id = await openMarkdown(
      page,
      context,
      'before\n\n```js\n  first\nsecond  \n```\n\nafter\n\n```\nother\n```',
    );
    const code = page.locator('.note-editor pre code').first();
    await Promise.all([
      code.evaluate(
        (element) =>
          new Promise<void>((resolve) => {
            document.addEventListener('selectionchange', function selected() {
              if (!element.contains(window.getSelection()?.anchorNode ?? null)) return;
              document.removeEventListener('selectionchange', selected);
              resolve();
            });
          }),
      ),
      code.click(),
    ]);
    await page.keyboard.press(`${modifier}+a`);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
      '  first\nsecond  ',
    );
    await page.keyboard.press(`${modifier}+a`);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
      '  first\nsecond  ',
    );
    await page.keyboard.insertText('replacement');
    await expect(code).toHaveText('replacement');
    await page.keyboard.press('ControlOrMeta+s');
    await expect
      .poll(async () => (await page.request.get(`/api/v1/notes/${id}`)).text())
      .toBe('before\n\n```js\nreplacement\n```\n\nafter\n\n```\nother\n```');
  });
}

test('code controls collapse, expand and copy without saving UI text', async ({
  page,
  context,
}) => {
  const body = '```js\n  first\nsecond  \n```';
  const id = await openMarkdown(page, context, body);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          document.documentElement.dataset.copied = text;
        },
      },
    });
  });
  const writes: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PUT') writes.push(r.url());
  });
  const collapse = page.getByRole('button', { name: '收起', exact: true });
  const copy = page.getByRole('button', { name: '复制代码', exact: true });
  const left = await collapse.boundingBox(),
    right = await copy.boundingBox();
  expect(left!.x).toBeLessThan(right!.x);
  expect(left!.y).toBe(right!.y);
  await collapse.click();
  await expect(page.locator('.note-editor pre')).toBeHidden();
  await copy.click();
  await expect(page.getByText('已复制', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.dataset.copied)).toBe(
    '  first\nsecond  ',
  );
  await page.getByRole('button', { name: '展开', exact: true }).click();
  await expect(page.locator('.note-editor pre')).toBeVisible();
  await page.waitForTimeout(600);
  expect(writes).toEqual([]);
  expect(await (await page.request.get(`/api/v1/notes/${id}`)).text()).toBe(body);
});

for (const area of ['gap', 'editor', 'page']) {
  test(`clicking below a final code block in the ${area} enters a paragraph`, async ({
    page,
    context,
  }) => {
    await openMarkdown(page, context, '```\ncode\n```');
    const block = await page.locator('.code-block').boundingBox();
    const editor = await page.locator('.note-editor').boundingBox();
    const y =
      area === 'gap'
        ? block!.y + block!.height - 4
        : area === 'editor'
          ? block!.y + block!.height + 24
          : editor!.y + editor!.height + 24;
    await page.mouse.click(block!.x + 40, y);
    await page.keyboard.insertText('outside code');
    await expect(page.locator('.note-editor > p')).toHaveText('outside code');
    await expect(page.locator('.note-editor pre code')).toHaveText('code');
  });
}

test('clicking below code reuses an existing paragraph and works while collapsed', async ({
  page,
  context,
}) => {
  await openMarkdown(page, context, '```\ncode\n```\n\nafter');
  await page.getByRole('button', { name: '收起', exact: true }).click();
  const block = await page.locator('.code-block').boundingBox();
  await page.mouse.click(block!.x + 40, block!.y + block!.height - 4);
  await page.keyboard.insertText('prefix ');
  await expect(page.locator('.note-editor > p')).toHaveCount(1);
  await expect(page.locator('.note-editor > p')).toHaveText('prefix after');
  await page.getByRole('button', { name: '展开', exact: true }).click();
  await expect(page.locator('.note-editor pre code')).toHaveText('code');
});

test('dates, toolbar and editor layout stay consistent across viewport sizes', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openMarkdown(page, context, '# 自适应宽度');
  const row = page.locator('.note-row').filter({ hasText: '自适应宽度' });
  await expect(row.locator('small')).toHaveText(/^\d{4}-\d{2}-\d{2}$/);
  await expect(page.locator('.breadcrumb')).toHaveCount(0);
  await expect(page.locator('.note-header')).toBeHidden();
  const editor = page.locator('.note-editor');
  const wide = await editor.boundingBox();
  expect(wide!.width).toBeGreaterThan(900);
  await page.setViewportSize({ width: 1100, height: 900 });
  const narrow = await editor.boundingBox();
  expect(wide!.width - narrow!.width).toBe(340);
  for (const name of ['撤销', '重做']) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCSS(
      'font-weight',
      '400',
    );
    await expect(
      page.getByRole('button', { name, exact: true }).locator('svg'),
    ).toHaveAttribute('stroke-width', '1.25');
  }
  const select = page.getByLabel('段落格式');
  await expect(select).toHaveCSS('padding-right', '30px');
  await expect(select).toHaveCSS('background-position', 'calc(100% - 10px) 50%');
  await page.setViewportSize({ width: 320, height: 700 });
  await expect(page.locator('.editor-page')).toHaveCSS('min-width', '320px');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await expect(page.getByRole('button', { name: '打开笔记列表' })).toBeVisible();
});

test('a confirmed delayed deletion clears its route and reloads without a missing-note error', async ({
  page,
  context,
}) => {
  const id = await openMarkdown(page, context, '延迟删除');
  await page.route(`**/api/v1/notes/${id}`, async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue();
    await route.fetch();
    await route.abort();
  });
  await page
    .locator('.note-row')
    .filter({ hasText: '延迟删除' })
    .getByRole('button', { name: '更多操作' })
    .click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('menuitem', { name: '删除' }).click();
  await page.getByRole('button', { name: '检查同步' }).click();
  await expect(page).toHaveURL('http://127.0.0.1:4173/');
  await page.reload();
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
test('login, empty creation, write, rich format, reload and delete', async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByLabel('账号').fill('me');
  await page.getByLabel('密码').fill('browser-test-password');
  await page.getByRole('button', { name: '进入笔记本' }).click();
  await ready(page);
  cachedLogin = {
    cookies: await context.cookies(),
    session: await (await context.request.get('/api/v1/auth/session')).json(),
  };
  const id = page.url().split('/').at(-1)!;
  const before = await page.request.get(`/api/v1/notes/${id}`);
  expect(before.status()).toBe(404);
  const editor = page.getByRole('textbox', { name: '笔记正文', exact: true });
  await editor.fill('记录一个稍纵即逝的想法');
  await expect(page.getByText(/^已同步 \d{2}:\d{2}:\d{2}$/)).toBeVisible();
  await editor.press('ControlOrMeta+a');
  await page.getByRole('button', { name: '加粗', exact: true }).click();
  await expect(page.getByText(/^已同步 \d{2}:\d{2}:\d{2}$/)).toBeVisible();
  await expect
    .poll(async () => (await page.request.get(`/api/v1/notes/${id}`)).text())
    .toContain('**');
  const original = await (await page.request.get(`/api/v1/notes/${id}`)).text();
  const writes: string[] = [];
  page.on('request', (r) => {
    if (['POST', 'PUT'].includes(r.method())) writes.push(r.url());
  });
  await page.reload();
  await expect(editor).toContainText('记录一个稍纵即逝的想法');
  expect(await editor.locator('strong').count()).toBe(1);
  await editor.focus();
  await page.waitForTimeout(800);
  expect(writes).toEqual([]);
  expect(await (await page.request.get(`/api/v1/notes/${id}`)).text()).toBe(original);
  await expect(
    page.getByRole('navigation').getByRole('button', { name: /记录一个稍纵即逝的想法/ }),
  ).toBeVisible();
  await page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
  await expect(
    page.locator('.note-header').getByRole('button', { name: /复制|删除/ }),
  ).toHaveCount(0);
  const row = page
    .getByRole('navigation', { name: '笔记列表' })
    .locator('.note-row', { hasText: '记录一个稍纵即逝的想法' });
  await row.hover();
  await row.getByRole('button', { name: '更多操作' }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('menuitem', { name: '删除' }).click();
  await expect
    .poll(async () => (await page.request.get(`/api/v1/notes/${id}`)).status())
    .toBe(404);
  await expect(page).toHaveURL('http://127.0.0.1:4173/');
  expect(
    await page.evaluate(
      (namespace) => localStorage.getItem(`pmem-last:${namespace}`),
      cachedLogin!.session.deployment,
    ),
  ).toBeNull();
  await page.reload();
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(errors).toEqual([]);
});
for (const modifier of ['Control', 'Meta']) {
  test(`${modifier}+S syncs the current note immediately from the editor or toolbar`, async ({
    context,
    page,
  }) => {
    await login(context);
    await page.clock.install({ time: Date.now() - 60_000 });
    await page.goto('/');
    await ready(page);
    await page.clock.pauseAt(Date.now());
    const editor = page.getByRole('textbox', { name: '笔记正文', exact: true });
    const id = page.url().split('/').at(-1)!;
    const writes: string[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith(`/notes/${id}`) && ['POST', 'PUT'].includes(request.method()))
        writes.push(request.method());
    });
    expect(
      await editor.evaluate((element, modifier) => {
        const event = new KeyboardEvent('keydown', {
          key: 's',
          ctrlKey: modifier === 'Control',
          metaKey: modifier === 'Meta',
          bubbles: true,
          cancelable: true,
        });
        element.dispatchEvent(event);
        return event.defaultPrevented;
      }, modifier),
    ).toBe(true);
    expect((await page.request.get(`/api/v1/notes/${id}`)).status()).toBe(404);
    await editor.fill('快捷键立即同步');
    await expect(page.getByText('已保存到本机，待同步', { exact: true })).toBeVisible();
    expect(writes).toEqual([]);
    await editor.press(`${modifier}+s`);
    await expect(page.getByText(/^已同步 \d{2}:\d{2}:\d{2}$/)).toBeVisible();
    expect(await (await page.request.get(`/api/v1/notes/${id}`)).text()).toBe('快捷键立即同步');
    await editor.press(`${modifier}+s`);
    await page.clock.runFor(2000);
    expect(writes).toEqual(['POST']);
    await editor.fill('工具栏聚焦时也能同步');
    await expect(page.getByText('已保存到本机，待同步', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '加粗', exact: true }).focus();
    await page.keyboard.press(`${modifier}+s`);
    await expect(page.getByText(/^已同步 \d{2}:\d{2}:\d{2}$/)).toBeVisible();
    expect(await (await page.request.get(`/api/v1/notes/${id}`)).text()).toBe(
      '工具栏聚焦时也能同步',
    );
    expect(writes).toEqual(['POST', 'PUT']);
  });
}
test('save shortcuts leave other keys and composition alone and follow the selected note', async ({
  context,
  page,
}) => {
  await login(context);
  await page.clock.install({ time: Date.now() - 60_000 });
  await page.goto('/');
  await ready(page);
  await page.clock.pauseAt(Date.now());
  const editor = page.getByRole('textbox', { name: '笔记正文', exact: true });
  await editor.fill('第一篇快捷键笔记');
  await editor.press('ControlOrMeta+s');
  await expect(page.getByText(/^已同步 \d{2}:\d{2}:\d{2}$/)).toBeVisible();
  const firstId = page.url().split('/').at(-1)!;
  await page.getByRole('button', { name: /新的笔记/ }).click();
  await editor.fill('第二篇快捷键笔记');
  await expect(page.getByText('已保存到本机，待同步', { exact: true })).toBeVisible();
  const secondId = page.url().split('/').at(-1)!;
  for (const init of [
    { key: 's' },
    { key: 'b', ctrlKey: true },
    { key: 's', ctrlKey: true, shiftKey: true },
    { key: 's', metaKey: true, altKey: true },
    { key: 's', ctrlKey: true, isComposing: true },
    { key: 's', metaKey: true, repeat: true },
  ]) {
    expect(
      await page.evaluate((init) => {
        const event = new KeyboardEvent('keydown', {
          ...init,
          bubbles: true,
          cancelable: true,
        });
        document.body.dispatchEvent(event);
        return event.defaultPrevented;
      }, init),
    ).toBe(Boolean(init.isComposing || init.repeat));
    expect((await page.request.get(`/api/v1/notes/${secondId}`)).status()).toBe(404);
  }
  await editor.press('ControlOrMeta+s');
  await expect(page.getByText(/^已同步 \d{2}:\d{2}:\d{2}$/)).toBeVisible();
  expect(await (await page.request.get(`/api/v1/notes/${firstId}`)).text()).toBe(
    '第一篇快捷键笔记',
  );
  expect(await (await page.request.get(`/api/v1/notes/${secondId}`)).text()).toBe(
    '第二篇快捷键笔记',
  );
});
test('a late acknowledgment never overwrites typing and survives refresh', async ({
  context,
  page,
}) => {
  await login(context);
  await page.goto('/');
  await ready(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let captured!: () => void;
  const arrived = new Promise<void>((resolve) => {
    captured = resolve;
  });
  await page.route('**/api/v1/notes/*', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    captured();
    await gate;
    await route.fulfill({ response });
  });
  const editor = page.getByRole('textbox', { name: '笔记正文', exact: true });
  await editor.fill('first');
  await editor.press('ControlOrMeta+s');
  await arrived;
  await editor.fill('first plus newer input');
  await editor.press('ControlOrMeta+s');
  release();
  await expect(page.getByText(/^已同步 \d{2}:\d{2}:\d{2}$/)).toBeVisible();
  await expect(editor).toHaveText('first plus newer input');
  await page.reload();
  await expect(editor).toHaveText('first plus newer input');
});
test('offline drafts remain local and sync when the opened page reconnects', async ({
  context,
  page,
}) => {
  await login(context);
  await page.goto('/');
  await ready(page);
  const editor = page.getByRole('textbox', { name: '笔记正文', exact: true });
  await editor.fill('online');
  await expect(page.getByText(/^已同步 \d{2}:\d{2}:\d{2}$/)).toBeVisible();
  await context.setOffline(true);
  await editor.fill('offline retained draft');
  await expect(page.getByText('已保存到本机，待同步', { exact: true })).toBeVisible();
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByText(/^已同步 \d{2}:\d{2}:\d{2}$/)).toBeVisible();
  await page.reload();
  await expect(editor).toHaveText('offline retained draft');
});
test('other-device edits preserve local drafts on conflict', async ({
  context,
  page,
  browser,
}) => {
  await login(context);
  await page.goto('/');
  await ready(page);
  const editor = page.getByRole('textbox', { name: '笔记正文', exact: true });
  await editor.fill('base');
  await expect(page.getByText(/^已同步 \d{2}:\d{2}:\d{2}$/)).toBeVisible();
  const url = page.url();
  const other = await browser.newContext({ baseURL: 'http://127.0.0.1:4173' });
  await login(other);
  const second = await other.newPage();
  await second.goto(url);
  await ready(second);
  await context.setOffline(true);
  await editor.fill('my local draft');
  await expect(page.getByText('已保存到本机，待同步', { exact: true })).toBeVisible();
  await second.getByRole('textbox', { name: '笔记正文', exact: true }).fill('from phone');
  await expect(second.getByText(/^已同步 \d{2}:\d{2}:\d{2}$/)).toBeVisible();
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByText(/其他设备修改了这篇笔记/)).toBeVisible();
  await expect(editor).toHaveText('my local draft');
  await page.reload();
  await expect(editor).toHaveText('my local draft');
  await other.close();
});
test('mobile viewport can record without horizontal overflow', async ({ context, page }) => {
  await login(context);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await ready(page);
  await page.getByRole('textbox', { name: '笔记正文', exact: true }).fill('手机记录中文灵感');
  await expect(page.getByText(/^已同步 \d{2}:\d{2}:\d{2}$/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    390,
  );
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
  await page.getByRole('button', { name: '打开笔记列表' }).click();
  await expect(page.getByRole('navigation', { name: '笔记列表' })).toBeVisible();
});
test('duplicated tab gets a different draft slot; closed-tab drafts can be recovered', async ({
  context,
  page,
}) => {
  const session = await login(context);
  await page.goto('/');
  await ready(page);
  await context.setOffline(true);
  const editor = page.getByRole('textbox', { name: '笔记正文', exact: true });
  await editor.fill('draft from original tab');
  await expect(page.getByText('已保存到本机，待同步', { exact: true })).toBeVisible();
  const originalSlot = await page.evaluate(
    (namespace) => sessionStorage.getItem(`pmem-slot:${namespace}`),
    session.deployment,
  );
  const duplicate = await context.newPage();
  await duplicate.addInitScript(
    ({ ns, id }) => sessionStorage.setItem(`pmem-slot:${ns}`, id!),
    {
      ns: session.deployment,
      id: originalSlot,
    },
  );
  await context.setOffline(false);
  await duplicate.goto('/');
  await ready(duplicate);
  const duplicateSlot = await duplicate.evaluate(
    (namespace) => sessionStorage.getItem(`pmem-slot:${namespace}`),
    session.deployment,
  );
  expect(duplicateSlot).not.toBe(originalSlot);
  await context.setOffline(true);
  await duplicate
    .getByRole('textbox', { name: '笔记正文', exact: true })
    .fill('draft from duplicate');
  await expect(duplicate.getByText('已保存到本机，待同步', { exact: true })).toBeVisible();
  await duplicate.close();
  await context.setOffline(false);
  await page.getByRole('button', { name: /^本机草稿/ }).click();
  const recovery = page.getByRole('dialog', { name: '恢复本机草稿' });
  await expect(recovery).toContainText('draft from duplicate');
  await expect(recovery.locator('.draft-row small').first()).toHaveText(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
  );
  await recovery
    .locator('.draft-row')
    .filter({ hasText: 'draft from duplicate' })
    .getByRole('button', { name: '恢复' })
    .click();
  await expect(editor).toHaveText('draft from duplicate');
  await expect(page.getByText(/^已同步 \d{2}:\d{2}:\d{2}$/)).toBeVisible({ timeout: 10000 });
});
test('oversized paste stays complete locally and does not create a remote file', async ({
  context,
  page,
}) => {
  await login(context);
  await page.goto('/');
  await ready(page);
  const id = page.url().split('/').at(-1)!;
  const text = '大'.repeat(700000);
  await page.getByRole('textbox', { name: '笔记正文', exact: true }).fill(text);
  await expect(page.getByText(/内容超过 1 MiB.*已保存到本机/)).toBeVisible();
  expect((await page.request.get(`/api/v1/notes/${id}`)).status()).toBe(404);
  await page.reload();
  await expect(page.getByRole('textbox', { name: '笔记正文', exact: true })).toHaveText(text);
  await page.getByRole('textbox', { name: '笔记正文', exact: true }).fill('缩减后继续保存');
  await expect(page.getByText(/^已同步 \d{2}:\d{2}:\d{2}$/)).toBeVisible();
});
test('a remote deletion never resurrects the old note and expired auth retains the draft', async ({
  context,
  page,
}) => {
  const session = await login(context);
  await page.goto('/');
  await ready(page);
  const editor = page.getByRole('textbox', { name: '笔记正文', exact: true });
  await editor.fill('existing note');
  await expect(page.getByText(/^已同步 \d{2}:\d{2}:\d{2}$/)).toBeVisible();
  const id = page.url().split('/').at(-1)!;
  const current = await page.request.get(`/api/v1/notes/${id}`);
  expect(
    (
      await page.request.delete(`/api/v1/notes/${id}`, {
        headers: {
          origin: 'http://127.0.0.1:4173',
          'x-csrf-token': session.csrf,
          'if-match': current.headers().etag,
        },
      })
    ).status(),
  ).toBe(204);
  await editor.fill('keep after deletion');
  await expect(page.getByText(/这篇笔记已被删除/)).toBeVisible();
  expect((await page.request.get(`/api/v1/notes/${id}`)).status()).toBe(404);
  await page.getByRole('button', { name: '另存为新笔记' }).click();
  await expect(page.getByText(/^已同步 \d{2}:\d{2}:\d{2}$/)).toBeVisible();
  await context.clearCookies();
  await editor.fill('draft during expiry');
  await expect(page.getByRole('heading', { name: '留住此刻的想法。' })).toBeVisible();
  await page.getByLabel('账号').fill('me');
  await page.getByLabel('密码').fill('browser-test-password');
  await page.getByRole('button', { name: '进入笔记本' }).click();
  await expect(editor).toHaveText('draft during expiry');
  await expect(page.getByText(/^已同步 \d{2}:\d{2}:\d{2}$/)).toBeVisible();
});
test('unsupported stored Markdown is read-only and is never rewritten on open', async ({
  context,
  page,
}) => {
  const session = await login(context),
    id = crypto.randomUUID(),
    body = '<script>window.pmemUnsafe=true</script>\n\n| a | b |\n| - | - |\n| c | d |';
  expect(
    (
      await context.request.post(`/api/v1/notes/${id}`, {
        headers: {
          origin: 'http://127.0.0.1:4173',
          'x-csrf-token': session.csrf,
          'content-type': 'text/markdown',
        },
        data: body,
      })
    ).status(),
  ).toBe(201);
  await page.goto(`/#/note/${id}`);
  await expect(page.getByRole('textbox', { name: '笔记原文' })).toHaveValue(body);
  expect(await page.evaluate(() => 'pmemUnsafe' in window)).toBe(false);
  expect(await (await context.request.get(`/api/v1/notes/${id}`)).text()).toBe(body);
});
test('completed task styling stays on that task and primary controls are white on the brand greens', async ({
  context,
  page,
}) => {
  const session = await login(context),
    id = crypto.randomUUID();
  await context.request.post(`/api/v1/notes/${id}`, {
    headers: {
      origin: 'http://127.0.0.1:4173',
      'x-csrf-token': session.csrf,
      'content-type': 'text/markdown',
    },
    data: '- [x] 已完成父项\n  - [ ] 未完成子项',
  });
  await page.goto(`/#/note/${id}`);
  await ready(page);
  const editor = page.getByRole('textbox', { name: '笔记正文', exact: true });
  const struck = (text: string) =>
    editor.getByText(text, { exact: true }).evaluate((el) => {
      let node: Element | null = el;
      while (node && !node.classList.contains('note-editor')) {
        if (getComputedStyle(node).textDecorationLine.includes('line-through')) return true;
        node = node.parentElement;
      }
      return false;
    });
  await expect.poll(() => struck('已完成父项')).toBe(true);
  expect(await struck('未完成子项')).toBe(false);
  expect(
    await editor
      .getByText('未完成子项', { exact: true })
      .evaluate(
        (el) =>
          getComputedStyle(el).color === getComputedStyle(el.closest('.note-editor')!).color,
      ),
  ).toBe(true);
  const create = page.getByRole('button', { name: /新的笔记/ });
  await expect(create).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(create).toHaveCSS('background-color', 'rgb(0, 185, 107)');
  await create.hover();
  await expect(create).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(create).toHaveCSS('background-color', 'rgb(0, 148, 86)');
  const done = editor.locator("li[data-checked='true'] > label > input"),
    todo = editor.locator("li[data-checked='false'] > label > input");
  await expect(done).toHaveCSS('background-color', 'rgb(0, 185, 107)');
  expect(await done.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain('%23fff');
  await expect(todo).toHaveCSS('background-color', 'rgb(255, 255, 255)');
});
test('a note can be deleted from its sidebar menu without opening it', async ({
  context,
  page,
}) => {
  const session = await login(context),
    id = crypto.randomUUID();
  await context.request.post(`/api/v1/notes/${id}`, {
    headers: {
      origin: 'http://127.0.0.1:4173',
      'x-csrf-token': session.csrf,
      'content-type': 'text/markdown',
    },
    data: '# 从列表删除',
  });
  await page.goto('/');
  await ready(page);
  const row = page
    .getByRole('navigation', { name: '笔记列表' })
    .locator('.note-row', { hasText: '从列表删除' });
  const currentUrl = page.url();
  const more = row.getByRole('button', { name: '更多操作' });
  await expect(more).toHaveText('⋮');
  await expect(more).toHaveCSS('opacity', '0');
  await row.hover();
  await expect(more).toHaveCSS('opacity', '1');
  await more.click();
  const [button, menu] = await Promise.all([
    more.boundingBox(),
    page.getByRole('menu', { name: '笔记操作' }).boundingBox(),
  ]);
  expect(menu!.y).toBeGreaterThanOrEqual(button!.y + button!.height);
  expect(menu!.x + menu!.width).toBeLessThanOrEqual(button!.x + button!.width + 1);
  const [brand, create] = await Promise.all([
    page.getByText('Personal Memory', { exact: true }).boundingBox(),
    page.getByRole('button', { name: /新的笔记/ }).boundingBox(),
  ]);
  expect(brand!.x).toBeCloseTo(create!.x, 0);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('menuitem', { name: '删除' }).click();
  await expect(row).toHaveCount(0);
  await expect(page).toHaveURL(currentUrl);
  await expect
    .poll(async () => (await context.request.get(`/api/v1/notes/${id}`)).status())
    .toBe(404);
  await expect(page.getByRole('textbox', { name: '笔记正文', exact: true })).toBeVisible();
});
test('unavailable IndexedDB leaves typing possible without claiming a save', async ({
  context,
  page,
}) => {
  await login(context);
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', {
      value: {
        open() {
          throw new DOMException('Unavailable', 'SecurityError');
        },
      },
    });
  });
  await page.goto('/');
  await ready(page);
  const id = page.url().split('/').at(-1)!;
  const editor = page.getByRole('textbox', { name: '笔记正文', exact: true });
  await editor.fill('retain this in memory');
  await expect(
    page.getByRole('status').filter({ hasText: '本机保存失败，请复制内容' }),
  ).toBeVisible();
  await expect(editor).toHaveText('retain this in memory');
  expect((await page.request.get(`/api/v1/notes/${id}`)).status()).toBe(404);
  await expect(editor).toBeEditable();
});
test('toolbar focus rings stay inside their controls, undo and redo work, and / opens no menu', async ({
  context,
  page,
}) => {
  await login(context);
  await page.goto('/');
  await ready(page);
  const editor = page.getByRole('textbox', { name: '笔记正文', exact: true });
  const [select, bold] = await Promise.all([
    page.getByRole('combobox', { name: '段落格式' }).boundingBox(),
    page.getByRole('button', { name: '加粗', exact: true }).boundingBox(),
  ]);
  expect(bold!.x - (select!.x + select!.width)).toBeGreaterThanOrEqual(4);
  await editor.focus();
  await page.keyboard.press('Shift+Tab');
  const redo = page.getByRole('button', { name: '重做' });
  await expect(redo).toBeFocused();
  expect(
    await redo.evaluate((el) => [
      el.matches(':focus-visible'),
      getComputedStyle(el).outlineOffset,
    ]),
  ).toEqual([true, '-2px']);
  await expect(redo.locator('svg')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '撤销' }).locator('svg')).toHaveCount(1);
  await editor.fill('/标题');
  await expect(page.getByLabel('插入内容')).toHaveCount(0);
  await expect(page.getByText('输入 /')).toHaveCount(0);
  await page.getByRole('button', { name: '撤销' }).click();
  await expect(editor).toHaveText('');
  await redo.click();
  await expect(editor).toHaveText('/标题');
});
test('pasted supported rich text keeps its format; unsupported HTML becomes visible text', async ({
  context,
  page,
}) => {
  await login(context);
  await page.goto('/');
  await ready(page);
  const editor = page.getByRole('textbox', { name: '笔记正文', exact: true });
  await editor.focus();
  await editor.evaluate((element) => {
    const data = new DataTransfer();
    data.setData('text/html', '<p><strong>粘贴加粗</strong></p>');
    data.setData('text/plain', '粘贴加粗');
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: data });
    element.dispatchEvent(event);
  });
  await expect(editor.locator('strong')).toHaveText('粘贴加粗');
  await expect(page.getByText(/^已同步 \d{2}:\d{2}:\d{2}$/)).toBeVisible();
  await editor.press('ControlOrMeta+End');
  await editor.press('Enter');
  await editor.evaluate((element) => {
    const data = new DataTransfer();
    data.setData('text/html', '<script>window.pasteExecuted = true</script>');
    data.setData('text/plain', '<script>visible text</script>');
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: data });
    element.dispatchEvent(event);
  });
  await expect(editor).toContainText('<script>visible text</script>');
  expect(await page.evaluate(() => 'pasteExecuted' in window)).toBe(false);
  await expect(page.getByText(/^已同步 \d{2}:\d{2}:\d{2}$/)).toBeVisible();
  await page.reload();
  await expect(editor).toContainText('<script>visible text</script>');
  await expect(editor.locator('strong').first()).toHaveText('粘贴加粗');
});
test('draft recovery paginates without discarding unsynchronized content', async ({
  context,
  page,
}) => {
  await login(context);
  await page.goto('/');
  await ready(page);
  await context.setOffline(true);
  for (let i = 0; i < 7; i++) {
    if (i) await page.getByRole('button', { name: /新的笔记/ }).click();
    await page
      .getByRole('textbox', { name: '笔记正文', exact: true })
      .fill(`unsynchronized draft ${i}`);
    await expect(page.getByText('已保存到本机，待同步', { exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: /^本机草稿/ }).click();
  const dialog = page.getByRole('dialog', { name: '恢复本机草稿' });
  await expect(dialog.getByRole('heading')).toHaveText('本机草稿 · 7');
  await expect(dialog.getByRole('button', { name: '恢复', exact: true })).toHaveCount(5);
  await dialog.getByRole('button', { name: '加载更多' }).click();
  await expect(dialog.getByRole('button', { name: '恢复', exact: true })).toHaveCount(7);
});

test('reauthentication in one tab resumes the other tab with its original note and latest draft', async ({
  page,
  context,
}) => {
  await login(context);
  await page.goto('/');
  await ready(page);
  const editorA = page.getByRole('textbox', { name: '笔记正文', exact: true });
  await editorA.fill('tab A baseline');
  await expect(page.getByText(/^已同步 \d{2}:\d{2}:\d{2}$/)).toBeVisible();
  const other = await context.newPage();
  await other.goto('/');
  await ready(other);
  const editorB = other.getByRole('textbox', { name: '笔记正文', exact: true });
  await editorB.fill('tab B baseline');
  await expect(other.getByText(/^已同步 \d{2}:\d{2}:\d{2}$/)).toBeVisible();
  const originalUrl = other.url(),
    id = originalUrl.split('/').at(-1)!;
  await context.clearCookies();
  await page.bringToFront();
  await editorA.fill('tab A during expiry');
  await expect(page.getByLabel('密码')).toBeVisible();
  await other.bringToFront();
  await editorB.fill('tab B latest local draft');
  await expect(other.getByLabel('密码')).toBeVisible();
  await page.bringToFront();
  await page.getByLabel('账号').fill('me');
  await page.getByLabel('密码').fill('browser-test-password');
  await page.getByRole('button', { name: '进入笔记本' }).click();
  await expect(page.getByLabel('密码')).toBeHidden();
  await other.bringToFront();
  await other.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(other.getByLabel('密码')).toBeHidden({ timeout: 10_000 });
  await expect(other.getByText(/^已同步 \d{2}:\d{2}:\d{2}$/)).toBeVisible();
  expect(other.url()).toBe(originalUrl);
  expect(await (await other.request.get(`/api/v1/notes/${id}`)).text()).toBe(
    'tab B latest local draft',
  );
  await editorB.fill('tab B continues editing');
  await expect(other.getByText(/^已同步 \d{2}:\d{2}:\d{2}$/)).toBeVisible();
  await other.reload();
  await expect(editorB).toHaveText('tab B continues editing');
  expect(other.url()).toBe(originalUrl);
  await other.close();
});
