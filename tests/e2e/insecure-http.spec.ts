import { test, expect, type Page } from '@playwright/test';
const origin = 'http://pmem.test:4174';
test.use({ launchOptions: { args: ['--host-resolver-rules=MAP pmem.test 127.0.0.1'] } });
test.skip(
  ({ browserName }) => browserName !== 'chromium',
  'Only Chromium can map a non-loopback hostname onto the local test server',
);
async function enter(page: Page) {
  await page.goto(origin);
  await page.getByLabel('账号').fill('me');
  await page.getByLabel('密码').fill('browser-test-password');
  await page.getByRole('button', { name: '进入笔记本' }).click();
  const editor = page.getByRole('textbox', { name: '笔记正文', exact: true });
  await expect(editor).toBeVisible();
  return editor;
}
test('an opted-in plaintext HTTP origin supports login, writing, reload, copy and delete', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const remote = (id: string) =>
    page.evaluate(async (path) => {
      const response = await fetch(path);
      return { status: response.status, body: await response.text() };
    }, `/api/v1/notes/${id}`);
  const editor = await enter(page);
  expect(
    await page.evaluate(() => [
      isSecureContext,
      typeof crypto.randomUUID,
      typeof navigator.locks,
      typeof navigator.clipboard,
    ]),
  ).toEqual([false, 'undefined', 'undefined', 'undefined']);
  await editor.fill('内网明文访问也能记录');
  await expect(page.getByText('已同步', { exact: true })).toBeVisible();
  const id = page.url().split('/').at(-1)!;
  expect((await remote(id)).body).toContain('内网明文访问也能记录');
  await page.reload();
  await expect(editor).toContainText('内网明文访问也能记录');
  await page.getByRole('button', { name: '复制', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '内容原文' })).toHaveValue(/内网明文访问也能记录/);
  await page.getByRole('button', { name: '关闭原文' }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await expect.poll(async () => (await remote(id)).status).toBe(404);
  expect(errors).toEqual([]);
});
test('a draft left unsynced by an earlier load can be restored and then discarded', async ({
  page,
}) => {
  let offline = true;
  await page.route('**/api/v1/notes/*', (route) =>
    offline && route.request().method() !== 'GET' ? route.abort() : route.continue(),
  );
  const editor = await enter(page);
  await editor.fill('刷新前还没同步');
  await expect(page.getByText('已保存到本机，待同步', { exact: true })).toBeVisible();
  await page.reload();
  const banner = page.getByRole('button', { name: /有未同步的本机草稿/ });
  await banner.click();
  const rows = page.getByRole('dialog', { name: '恢复本机草稿' }).locator('.draft-row');
  await rows.filter({ hasText: '刷新前还没同步' }).getByRole('button', { name: '恢复' }).click();
  await expect(editor).toHaveText('刷新前还没同步');
  offline = false;
  await expect(page.getByText('已同步', { exact: true })).toBeVisible({ timeout: 10000 });
  await banner.click();
  await expect(rows).toHaveCount(1);
  page.once('dialog', (dialog) => dialog.accept());
  await rows.getByRole('button', { name: '丢弃' }).click();
  await expect(rows).toHaveCount(0);
  await expect(banner).toHaveCount(0);
});
