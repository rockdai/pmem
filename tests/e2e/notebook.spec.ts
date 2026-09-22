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
test('login, empty creation, write, rich format, reload and delete', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByLabel('账号').fill('me');
  await page.getByLabel('密码').fill('browser-test-password');
  await page.getByRole('button', { name: '进入笔记本' }).click();
  await ready(page);
  const id = page.url().split('/').at(-1)!;
  const before = await page.request.get(`/api/v1/notes/${id}`);
  expect(before.status()).toBe(404);
  const editor = page.getByRole('textbox', { name: '笔记正文', exact: true });
  await editor.fill('记录一个稍纵即逝的想法');
  await expect(page.getByText('已同步', { exact: true })).toBeVisible();
  await editor.press('ControlOrMeta+a');
  await page.getByRole('button', { name: '加粗', exact: true }).click();
  await expect(page.getByText('已同步', { exact: true })).toBeVisible();
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
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await expect.poll(async () => (await page.request.get(`/api/v1/notes/${id}`)).status()).toBe(404);
  expect(errors).toEqual([]);
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
  await arrived;
  await editor.fill('first plus newer input');
  release();
  await expect(page.getByText('已同步', { exact: true })).toBeVisible();
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
  await expect(page.getByText('已同步', { exact: true })).toBeVisible();
  await context.setOffline(true);
  await editor.fill('offline retained draft');
  await expect(page.getByText('已保存到本机，待同步', { exact: true })).toBeVisible();
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByText('已同步', { exact: true })).toBeVisible();
  await page.reload();
  await expect(editor).toHaveText('offline retained draft');
});
test('other-device edits preserve local drafts on conflict', async ({ context, page, browser }) => {
  await login(context);
  await page.goto('/');
  await ready(page);
  const editor = page.getByRole('textbox', { name: '笔记正文', exact: true });
  await editor.fill('base');
  await expect(page.getByText('已同步', { exact: true })).toBeVisible();
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
  await expect(second.getByText('已同步', { exact: true })).toBeVisible();
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
  await expect(page.getByText('已同步', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
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
  await duplicate.addInitScript(({ ns, id }) => sessionStorage.setItem(`pmem-slot:${ns}`, id!), {
    ns: session.deployment,
    id: originalSlot,
  });
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
  await recovery
    .locator('.draft-row')
    .filter({ hasText: 'draft from duplicate' })
    .getByRole('button', { name: '恢复' })
    .click();
  await expect(editor).toHaveText('draft from duplicate');
  await expect(page.getByText('已同步', { exact: true })).toBeVisible({ timeout: 10000 });
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
  await expect(page.getByText('已同步', { exact: true })).toBeVisible();
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
  await expect(page.getByText('已同步', { exact: true })).toBeVisible();
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
  await expect(page.getByText('已同步', { exact: true })).toBeVisible();
  await context.clearCookies();
  await editor.fill('draft during expiry');
  await expect(page.getByRole('heading', { name: '留住此刻的想法。' })).toBeVisible();
  await page.getByLabel('账号').fill('me');
  await page.getByLabel('密码').fill('browser-test-password');
  await page.getByRole('button', { name: '进入笔记本' }).click();
  await expect(editor).toHaveText('draft during expiry');
  await expect(page.getByText('已同步', { exact: true })).toBeVisible();
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
test('unavailable IndexedDB leaves typing and copying possible without claiming a save', async ({
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
  await expect(page.getByRole('button', { name: '复制', exact: true })).toBeEnabled();
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
  await expect(page.getByText('已同步', { exact: true })).toBeVisible();
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
  await expect(page.getByText('已同步', { exact: true })).toBeVisible();
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
