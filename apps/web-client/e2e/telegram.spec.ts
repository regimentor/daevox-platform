import { expect, test } from '@playwright/test';

test('real HTTP QR flow across two tabs, 2FA, logout and reconnection', async ({
  page,
  context,
  request,
}) => {
  const errors: string[] = [];
  const apiRequests: Array<{ origin: string; method: string }> = [];
  context.on('request', (outgoing) => {
    const url = new URL(outgoing.url());
    if (url.pathname.startsWith('/api/telegram/')) {
      apiRequests.push({ origin: url.origin, method: outgoing.method() });
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));
  const event = async (name: string) => {
    const response = await request.post('http://127.0.0.1:3001/__test/event', {
      data: { event: name },
    });
    expect(response.ok()).toBe(true);
  };
  const stats = async () => (await request.get('http://127.0.0.1:3001/__test/stats')).json();
  const second = await context.newPage();
  await Promise.all([page.goto('/telegram'), second.goto('/telegram')]);
  await expect(page.getByRole('button', { name: 'Подключить Telegram' })).toBeEnabled();
  await expect(second.getByRole('button', { name: 'Подключить Telegram' })).toBeEnabled();
  await Promise.all([
    page.getByRole('button', { name: 'Подключить Telegram' }).click(),
    second.getByRole('button', { name: 'Подключить Telegram' }).click(),
  ]);
  const qr = page.getByRole('img', { name: 'QR-код для входа в Telegram' });
  await expect(qr).toBeVisible();
  await expect(second.getByRole('img', { name: 'QR-код для входа в Telegram' })).toBeVisible();
  expect((await stats()).connects).toBe(1);
  const original = await qr.innerHTML();
  await event('rotate');
  await expect.poll(() => qr.innerHTML()).not.toBe(original);
  await page.screenshot({ path: test.info().outputPath('telegram-light.png'), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(qr).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await expect(qr).toHaveAttribute('width', '180');
  await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'dark');
  await page.screenshot({
    path: test.info().outputPath('telegram-dark-mobile.png'),
    fullPage: true,
  });
  await event('offline');
  await expect(qr).toHaveCount(0);
  await expect(page.getByText('Нет сети Telegram.', { exact: false })).toBeVisible();
  await event('online');
  await expect(qr).toHaveCount(0);
  await event('rotate');
  await expect(qr).toBeVisible();
  await event('password');
  await expect(page.getByLabel('Пароль Telegram', { exact: true })).toBeEnabled();
  await page.getByLabel('Пароль Telegram', { exact: true }).fill('private-e2e-password');
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Аккаунт подключён' })).toBeVisible();
  await expect(second.getByRole('heading', { name: 'Аккаунт подключён' })).toBeVisible();
  await expect(page.getByText('@test_account')).toBeVisible();
  expect((await stats()).passwords).toBe(1);
  const storage = await page.evaluate(() =>
    JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
  );
  expect(storage).not.toMatch(/private-e2e-password|tg:\/\/login/);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Аккаунт подключён' })).toBeVisible();
  await page.getByRole('button', { name: 'Отключить аккаунт' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Оставить подключённым' }).click();
  expect((await stats()).logouts).toBe(0);
  await page.getByRole('button', { name: 'Отключить аккаунт' }).click();
  await page.getByRole('button', { name: 'Отключить', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Подключить Telegram' })).toBeEnabled();
  expect((await stats()).logouts).toBe(1);
  expect((await stats()).generations).toBe(2);
  await page.getByRole('button', { name: 'Подключить Telegram' }).click();
  await expect(qr).toBeVisible();
  await event('ready');
  await expect(page.getByRole('heading', { name: 'Аккаунт подключён' })).toBeVisible();
  await event('fatal');
  await expect(page.getByRole('button', { name: 'Перезапустить подключение' })).toBeEnabled();
  await page.getByRole('button', { name: 'Перезапустить подключение' }).click();
  await expect(page.getByRole('button', { name: 'Подключить Telegram' })).toBeEnabled();
  expect(errors).toEqual([]);
  expect(new Set(apiRequests.map((entry) => entry.origin))).toEqual(
    new Set(['http://127.0.0.1:5174']),
  );
  expect(new Set(apiRequests.map((entry) => entry.method))).toEqual(new Set(['GET', 'POST']));
  await second.close();
});
