import { expect, test } from '@playwright/test';

test('auto-reply persists through reload, replies via HTTP backend independently of observation and stops when disabled', async ({
  page,
  request,
}) => {
  const event = async (name: string) => {
    const response = await request.post('http://127.0.0.1:3001/__test/event', {
      data: { event: name },
    });
    expect(response.ok()).toBe(true);
  };
  const deliveries = async () =>
    (await (await request.get('http://127.0.0.1:3001/__test/stats')).json()).deliveries;
  await event('ready');
  await event('chat');
  await page.goto('/telegram');
  await page.getByRole('button', { name: 'История · Тест автоответчика' }).click();
  const control = page.getByRole('switch', { name: 'Автоответчик · Тест автоответчика' });
  await expect(control).not.toBeChecked();
  await control.press('Space');
  await expect(control).toBeChecked();
  await expect.poll(async () => (await deliveries()).length).toBe(1);
  expect((await deliveries())[0].input_message_content.text.text).toContain(
    'автоответчик подключён',
  );
  const observation = page.getByRole('switch', { name: /Наблюдать за/ });
  await expect(observation).toBeChecked();
  await observation.press('Space');
  await expect(observation).not.toBeChecked();
  await expect(control).toBeChecked();
  await event('incoming');
  await expect.poll(async () => (await deliveries()).length).toBe(2);
  const sent = (await deliveries())[1];
  expect(sent.reply_to.message_id).toBe(101);
  expect(sent.input_message_content.text.text).toContain(
    'Ответ от ИИ-секретаря для уважаемого @sender',
  );
  await page.reload();
  await page.getByRole('button', { name: 'История · Тест автоответчика' }).click();
  await expect(control).toBeChecked();
  await expect(observation).not.toBeChecked();
  await page.screenshot({ path: test.info().outputPath('auto-reply.png'), fullPage: true });
  await control.press('Space');
  await expect(control).not.toBeChecked();
  await event('incoming');
  await expect
    .poll(async () => {
      const chats = await (await request.get('http://127.0.0.1:3001/api/secretary/chats')).json();
      return chats.chats[0].autoReply.enabled;
    })
    .toBe(false);
  await expect.poll(async () => (await deliveries()).length).toBe(3);
  expect((await deliveries())[2].input_message_content.text.text).toContain(
    'автоответчик отключён',
  );
  expect((await deliveries())[2].reply_to).toBeNull();
  await page.route('**/api/secretary/chats?*', (route) => route.abort());
  await expect(page.getByText('Нет связи', { exact: true })).toBeVisible();
  await expect(control).toBeDisabled();
  // Return to the login state for the shared local test server's QR scenario.
  await page.unroute('**/api/secretary/chats?*');
  await page.getByRole('button', { name: 'Настройки аккаунта' }).click();
  await page.getByRole('button', { name: 'Отключить аккаунт', exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить отключение' }).click();
  await expect(page.getByRole('button', { name: 'Подключить Telegram' })).toBeVisible();
});
