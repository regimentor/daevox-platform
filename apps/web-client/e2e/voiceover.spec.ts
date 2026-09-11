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
  await page.getByRole('button', { name: '＋ Добавить видео' }).click();
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'talk.mp4', mimeType: 'video/mp4', buffer: media });
  await page.getByLabel('Озвучить автоматически').uncheck();
  await page.getByRole('button', { name: 'Подготовить перевод' }).click();
  await expect(page.getByRole('button', { name: 'Выбрать голоса ↗' })).toBeVisible();
  await page.getByRole('button', { name: 'Текст и перевод ↗' }).click();
  await expect(page.getByText('Перевод готовится…').first()).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть детали' }).click();
  await page.getByRole('button', { name: 'Выбрать голоса ↗' }).click();
  await expect(page.getByLabel('Образец aidar', { exact: true })).toBeVisible();
  await page.goto('/voiceover');
  await page.getByRole('link', { name: 'Текущий перевод', exact: true }).click();
  await page.getByRole('button', { name: 'Выбрать голоса ↗' }).click();
  await expect(page.getByRole('button', { name: 'Начать озвучку' })).toBeVisible();
  await page.getByRole('button', { name: 'Начать озвучку' }).click();
  await expect(page.getByRole('status')).toHaveText('Готово');
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
  await page.getByRole('button', { name: 'Текст и перевод ↗' }).click();
  await page.getByRole('button', { name: 'Перейти к 1.0 с', exact: true }).click();
  await expect.poll(() => page.locator('video').evaluate((v) => v.currentTime)).toBeCloseTo(1, 1);
  await expect
    .poll(() =>
      page
        .locator('audio[aria-label="Перевод"]')
        .evaluate((a) => (a as HTMLAudioElement).currentTime),
    )
    .toBeCloseTo(1, 1);
  await page.getByRole('button', { name: 'Закрыть детали' }).click();
  await page.getByRole('button', { name: 'Звук', exact: true }).click();
  await page.getByLabel('Только оригинал').check();
  await expect
    .poll(() =>
      page.locator('audio[aria-label="Перевод"]').evaluate((a) => (a as HTMLAudioElement).volume),
    )
    .toBe(0);
  await expect.poll(() => page.locator('video').evaluate((v) => v.volume)).toBe(1);
  await page.getByRole('button', { name: 'Закрыть детали' }).click();
  await page.getByRole('button', { name: 'Голоса ↗', exact: true }).click();
  await page.getByRole('combobox', { name: 'Спикер 1', exact: true }).click();
  await page.getByRole('option', { name: 'baya', exact: true }).click();
  await page.getByRole('button', { name: 'Переозвучить', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Готово');
  await expect(page.getByLabel('Видео', { exact: true })).toBeVisible();
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
  await expect(page.getByRole('status')).toHaveText('Ожидание видео');
  await page.unroute('**/events');
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('Ожидание видео');
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

test('updates translation counts and progress from the backend', async ({ page }) => {
  let completed = 3;
  await page.route('**/trancription-api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/events')) return route.abort();
    const stages = {
      translation: {
        state: 'running',
        completed_units: completed,
        total_units: 10,
        unit: 'phrases',
      },
    };
    const record = {
      id: 'progress-test',
      revision: completed,
      status: 'preparing',
      source: { kind: 'file', name: 'progress.mp4' },
      stages,
      transcript: [{ id: 'phrase', start: 0, end: 1, text: 'Hello.', speaker_id: null }],
      translations: [
        {
          id: 'phrase',
          source_segment_ids: ['phrase'],
          text: 'Привет.',
          status: 'warning',
          warnings: [{ code: 'semantic_review', message: 'Проверьте смысл перевода.' }],
        },
      ],
      speakers: [],
      voice_assignments: {},
      problems: [],
      assets: {},
      error: null,
    };
    const body = path.endsWith('/activity')
      ? { kind: 'voiceover', id: record.id, status: record.status }
      : path.endsWith('/voiceovers')
        ? {
            items: [
              {
                ...record,
                title: 'progress.mp4',
                created_at: '2026-09-11',
                duration: 60,
                storage_bytes: 100,
              },
            ],
            next_cursor: null,
          }
        : record;
    await route.fulfill({ json: body });
  });
  await page.goto('/voiceover/progress-test');
  await expect(
    page.getByRole('progressbar', { name: 'Прогресс перевода текста', exact: true }),
  ).toHaveAttribute('aria-valuenow', '30');
  await expect(page.getByText('Обработано 3 из 10 фраз', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Требуют проверки: 1 фраз/ }).click();
  await expect(page.getByText('Привет.', { exact: true })).toBeVisible();
  await expect(page.getByText('⚠ Проверьте смысл перевода.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть детали' }).click();
  completed = 7;
  await expect(
    page.getByRole('progressbar', { name: 'Прогресс перевода текста', exact: true }),
  ).toHaveAttribute('aria-valuenow', '70');
  await expect(page.getByText('Обработано 7 из 10 фраз', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('progressbar', { name: 'progress.mp4: Перевод', exact: true }),
  ).toHaveAttribute('aria-valuenow', '70');
});

test('selects GPUs before starting automatic voiceover', async ({ page }) => {
  await page.route('**/trancription-api/voiceover-devices', (route) =>
    route.fulfill({
      json: {
        items: [
          { value: 'GPU-a', label: 'GPU A' },
          { value: 'GPU-b', label: 'GPU B' },
        ],
      },
    }),
  );
  await page.route('**/trancription-api/voiceovers', (route) => {
    if (route.request().method() === 'POST')
      return route.fulfill({
        status: 422,
        json: { detail: { code: 'test', message: 'Тест запроса' } },
      });
    return route.continue();
  });
  await page.goto('/voiceover');
  await page.getByRole('button', { name: '＋ Добавить видео' }).click();
  await expect(page.getByLabel('Озвучить автоматически')).toBeChecked();
  await page.getByLabel('Ссылка YouTube').fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await page.getByRole('combobox', { name: 'Видеокарта для распознавания', exact: true }).click();
  await page.getByRole('option', { name: 'GPU A', exact: true }).click();
  await page.getByRole('combobox', { name: 'Видеокарта для озвучки', exact: true }).click();
  await page.getByRole('option', { name: 'GPU B', exact: true }).click();
  const sent = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/voiceovers'),
  );
  await page.getByRole('button', { name: 'Подготовить перевод' }).click();
  expect((await sent).postDataJSON()).toMatchObject({
    asr_gpu: 'GPU-a',
    tts_gpu: 'GPU-b',
    auto_synthesize: true,
  });
});

test('shows synthesis phrase counts and ticking processing time', async ({ page }) => {
  let count = 1;
  const started = Date.now() / 1000;
  await page.route('**/trancription-api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/events')) return route.abort();
    const record = {
      id: 'synthesis-test',
      revision: count,
      status: 'synthesizing',
      source: { kind: 'file', name: 'synthesis.mp4' },
      transcript: [],
      translations: [],
      speakers: [],
      voice_assignments: {},
      problems: [],
      assets: {},
      error: null,
      elapsed_seconds: 10,
      processing_started_at: started,
      stages: {
        synthesis: {
          state: 'running',
          completed_units: count,
          total_units: 5,
          unit: 'phrases',
          elapsed_seconds: 0,
          started_at: started,
          first_started_at: started,
        },
      },
    };
    return route.fulfill({
      json: path.endsWith('/activity')
        ? null
        : path.endsWith('/voiceovers')
          ? {
              items: [
                {
                  ...record,
                  title: 'synthesis.mp4',
                  created_at: '2026-09-11',
                  storage_bytes: 0,
                  duration: 30,
                },
              ],
              next_cursor: null,
            }
          : record,
    });
  });
  await page.goto('/voiceover/synthesis-test');
  await expect(
    page.getByRole('progressbar', { name: 'Прогресс синтеза речи', exact: true }),
  ).toHaveAttribute('aria-valuenow', '20');
  await expect(page.getByText('Синтез речи · 1 из 5 фраз', { exact: true })).toBeVisible();
  const time = page.getByText(/^Время обработки:/);
  const initial = await time.textContent();
  await expect(time).not.toHaveText(initial!);
  count = 4;
  await expect(
    page.getByRole('progressbar', { name: 'Прогресс синтеза речи', exact: true }),
  ).toHaveAttribute('aria-valuenow', '80');
  await expect(
    page.getByRole('progressbar', { name: 'synthesis.mp4: Озвучка', exact: true }),
  ).toHaveAttribute('aria-valuenow', '80');
});
