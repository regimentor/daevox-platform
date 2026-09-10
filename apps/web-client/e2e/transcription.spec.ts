import { expect, test } from '@playwright/test';

test('uploads through Vite proxy and restores speaker transcript and saved paths', async ({
  page,
}) => {
  await page.goto('/transcription');
  await expect(page.getByRole('heading', { name: 'Транскрибация', exact: true })).toBeVisible();
  await page.locator('input[type=file]').setInputFiles({
    name: 'speech.wav',
    mimeType: 'audio/wav',
    buffer: Buffer.from('fixture audio'),
  });
  await page.getByRole('button', { name: 'Начать транскрибацию' }).click();
  await expect(page.getByText('Готово', { exact: true })).toBeVisible();
  await expect(page.getByText('Привет,', { exact: true })).toBeVisible();
  await expect(page.getByText('Одновременная речь', { exact: true })).toBeVisible();
  await expect(page.getByText(/transcript.json/)).toBeVisible();
  await page.reload();
  for (const text of ['Привет,', 'мир! Пока.'])
    await expect(page.getByText(text, { exact: true })).toBeVisible();
});

test('cancels both active stages and restores partial text', async ({ page }) => {
  await page.goto('/transcription');
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'wait', mimeType: 'audio/wav', buffer: Buffer.from('audio') });
  await page.getByRole('button', { name: 'Начать транскрибацию' }).click();
  await expect(page.getByText('Привет, мир! Пока.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Отменить', exact: true }).click();
  await expect(page.getByText('Отменено', { exact: true })).toBeVisible();
  await expect(page.getByText(/Неполный результат:/)).toBeVisible();
  await page.reload();
  await expect(page.getByText('Привет, мир! Пока.', { exact: true })).toBeVisible();
});

test('a disconnected upload fails and removes its reservation', async ({ request }) => {
  const { connect } = await import('node:net');
  const response = await request.post('/trancription-api/operations', {
    data: {
      source_kind: 'file',
      filename: 'interrupted.wav',
      client_request_id: 'disconnect',
    },
  });
  const operation = await response.json();
  await new Promise<void>((resolve, reject) => {
    const socket = connect(3002, '127.0.0.1', () => {
      socket.write(
        `PUT /trancription-api/operations/${operation.operation_id}/source HTTP/1.1\r\nHost: 127.0.0.1:3002\r\nContent-Length: 100000\r\n\r\npartial`,
      );
      setTimeout(() => {
        socket.destroy();
        resolve();
      }, 100);
    });
    socket.on('error', reject);
  });
  await expect
    .poll(
      async () =>
        (await (await request.get(`/trancription-api/operations/${operation.operation_id}`)).json())
          .status,
    )
    .toBe('failed');
  const saved = await (
    await request.get(`/trancription-api/operations/${operation.operation_id}`)
  ).json();
  expect(saved.error.code).toBe('upload_error');
});

test('replaces live text with speaker segments without duplicate words', async ({ page }) => {
  await page.goto('/transcription');
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'live-speakers', mimeType: 'audio/wav', buffer: Buffer.from('audio') });
  await page.getByRole('button', { name: 'Начать транскрибацию' }).click();
  await expect(page.getByText('Привет, мир! Пока.', { exact: true })).toBeVisible();
  await expect(page.getByText('Спикер определяется', { exact: true })).toBeVisible();
  await expect(page.getByText('Привет,', { exact: true })).toBeVisible();
  await expect(page.getByText('Привет, мир! Пока.', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('Готово', { exact: true })).toBeVisible();
  for (const text of ['Привет,', 'мир! Пока.'])
    await expect(page.getByText(text, { exact: true })).toHaveCount(1);
});
