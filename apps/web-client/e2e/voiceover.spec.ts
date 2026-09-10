import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test.beforeEach(async ({ request }) => {
  const activity = await (await request.get('/trancription-api/activity')).json();
  if (activity?.kind === 'voiceover')
    await request.delete(`/trancription-api/voiceovers/${activity.id}`);
});

test('prepares uploaded video, confirms voices and opens the saved player', async ({ page }) => {
  const directory = mkdtempSync(join(tmpdir(), 'voiceover-media-'));
  let media: Buffer;
  try {
    const path = join(directory, 'input.mp4');
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=160x90:d=3',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=3',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      '-y',
      path,
    ]);
    media = readFileSync(path);
  } finally {
    rmSync(directory, { recursive: true });
  }
  await page.goto('/voiceover');
  await expect(page.getByRole('heading', { name: 'Перевод видео', exact: true })).toBeVisible();
  await page
    .getByLabel('Видеофайл')
    .setInputFiles({ name: 'talk.mp4', mimeType: 'video/mp4', buffer: media });
  await page.getByRole('button', { name: 'Подготовить перевод' }).click();
  await expect(page.getByRole('button', { name: 'Начать озвучку' })).toBeVisible();
  await expect(page.getByText('Привет.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Образец aidar', { exact: true })).toBeVisible();
  await page.goto('/voiceover');
  await page.getByRole('link', { name: 'Текущий перевод', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Начать озвучку' })).toBeVisible();
  await page.getByRole('button', { name: 'Начать озвучку' }).click();
  await expect(page.getByText('Готово', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Видео', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Видео', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Воспроизвести', exact: true }).click();
  await expect.poll(() => page.locator('video').evaluate((video) => !video.paused)).toBe(true);
  await expect
    .poll(() =>
      page
        .locator('audio[aria-label="Перевод"]')
        .evaluate((audio) => !(audio as HTMLAudioElement).paused),
    )
    .toBe(true);
  const drift = await page.evaluate(() =>
    Math.abs(
      document.querySelector('video')!.currentTime - document.querySelector('audio')!.currentTime,
    ),
  );
  expect(drift).toBeLessThanOrEqual(0.1);
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  await expect
    .poll(() =>
      page
        .locator('audio[aria-label="Перевод"]')
        .evaluate((audio) => (audio as HTMLAudioElement).paused),
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Перейти к 1.0 с', exact: true }).click();
  await expect.poll(() => page.locator('video').evaluate((v) => v.currentTime)).toBeCloseTo(1, 1);
  await expect
    .poll(() =>
      page
        .locator('audio[aria-label="Перевод"]')
        .evaluate((a) => (a as HTMLAudioElement).currentTime),
    )
    .toBeCloseTo(1, 1);
  await page.getByLabel('Только оригинал').check();
  await expect
    .poll(() =>
      page.locator('audio[aria-label="Перевод"]').evaluate((a) => (a as HTMLAudioElement).volume),
    )
    .toBe(0);
  await expect.poll(() => page.locator('video').evaluate((v) => v.volume)).toBe(1);
});

test('cancels a stalled upload and releases the shared slot', async ({ request }) => {
  const { connect } = await import('node:net');
  const response = await request.post('/trancription-api/voiceovers', {
    data: {
      source_kind: 'file',
      filename: 'stalled.mp4',
      client_request_id: 'stalled',
    },
  });
  const record = await response.json();
  const socket = connect(3003, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => {
        socket.write(
          `PUT /trancription-api/voiceovers/${record.id}/source HTTP/1.1\r\nHost: 127.0.0.1:3003\r\nContent-Length: 100000\r\n\r\npartial`,
        );
        setTimeout(resolve, 100);
      });
      socket.once('error', reject);
    });
    const deletion = await request.delete(`/trancription-api/voiceovers/${record.id}`, {
      timeout: 2000,
    });
    expect(deletion.status()).toBe(204);
    await expect((await request.get('/trancription-api/activity')).json()).resolves.toBeNull();
  } finally {
    socket.destroy();
  }
});

test('shows SSE connection loss without failing the operation', async ({ page, request }) => {
  const response = await request.post('/trancription-api/voiceovers', {
    data: {
      source_kind: 'file',
      filename: 'connection.mp4',
      client_request_id: 'connection',
    },
  });
  const record = await response.json();
  await page.route('**/events', (route) => route.abort());
  await page.goto(`/voiceover/${record.id}`);
  await expect(
    page.getByText('Связь с обработкой потеряна. Переподключаемся…', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Ожидание видео', { exact: true })).toBeVisible();
  await page.unroute('**/events');
  await page.reload();
  await expect(page.getByText('Ожидание видео', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Связь с обработкой потеряна. Переподключаемся…', { exact: true }),
  ).not.toBeVisible();
});

test('opens older records through library pagination', async ({ page, request }) => {
  test.setTimeout(30000);
  for (let index = 0; index < 21; index++) {
    const response = await request.post('/trancription-api/voiceovers', {
      data: {
        source_kind: 'file',
        filename: `history-${index}.mp4`,
        client_request_id: `history-${index}`,
      },
    });
    const record = await response.json();
    await request.put(`/trancription-api/voiceovers/${record.id}/source`, {
      data: Buffer.from('invalid'),
    });
    await expect
      .poll(
        async () =>
          (await (await request.get(`/trancription-api/voiceovers/${record.id}`)).json()).status,
      )
      .toBe('failed');
  }
  await page.goto('/voiceover');
  await expect(page.getByRole('link', { name: 'history-20.mp4', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'history-0.mp4', exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: 'Показать ещё', exact: true }).click();
  await expect(page.getByRole('link', { name: 'history-0.mp4', exact: true })).toBeVisible();
});
