import { test, expect } from '@playwright/test';

test('raw preset editor saves a draft through the real core and keeps launch in the header', async ({
  page,
  request,
}) => {
  await page.goto('/models?view=manage');
  await expect(page.getByRole('heading', { name: 'Управление моделями' })).toBeVisible();
  await page.getByRole('button', { name: 'Пресеты', exact: true }).click();
  await page.getByRole('button', { name: 'Новый INI' }).click();
  await page.getByRole('textbox', { name: 'Имя файла' }).fill('browser.ini');
  const text = '; browser draft\n[local]\nctx-size=banana\n';
  await page.getByRole('textbox', { name: 'Исходный INI' }).fill(text);
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByText('Expected a signed 32-bit integer')).toBeVisible();
  const catalog = await (await request.get('/core/presets')).json();
  expect(catalog.files.find((file: { name: string }) => file.name === 'browser.ini').text).toBe(
    text,
  );
  await expect(page.getByRole('button', { name: 'Запустить', exact: true })).toHaveCount(0);
});

test('header owns launch controls and an invalid draft cannot be launched', async ({ page }) => {
  await page.goto('/models?view=manage');
  await page.getByRole('button', { name: /Модель: не загружена/ }).click();
  await expect(page.getByRole('button', { name: 'Запустить', exact: true })).toBeDisabled();
  await expect(page.getByRole('link', { name: 'Настройки модели' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Выгрузить', exact: true })).toBeDisabled();
});

test('system settings persist through the real API and show session hardware', async ({
  page,
  request,
}) => {
  await page.goto('/models?view=manage');
  await page.getByRole('button', { name: 'Система', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Ожидание запросов, мс' }).fill('1234');
  await page.getByRole('spinbutton', { name: 'Потоки компилятора' }).fill('3');
  await page.getByRole('button', { name: 'Сохранить настройки' }).click();
  await expect(page.getByText('Настройки сохранены')).toBeVisible();
  const settings = await (await request.get('/core/settings')).json();
  expect(settings.drain_timeout_ms).toBe(1234);
  expect(settings.compiler_jobs).toBe(3);
  await expect(page.getByRole('heading', { name: 'CPU и память' })).toBeVisible();
  await expect(page.getByText('RAM', { exact: true }).last()).toBeVisible();
});

test('build panel exposes compiler output and applies a candidate separately', async ({
  page,
  request,
}) => {
  await page.goto('/models?view=manage');
  await page.getByRole('button', { name: 'Сборки', exact: true }).click();
  await page.getByRole('button', { name: 'Собрать', exact: true }).click();
  await expect(page.getByText('fixture-compiler-started', { exact: false }).first()).toBeVisible();
  const builds = await (await request.get('/core/builds')).json();
  expect(builds.builds[0].status).toBe('building');
  await expect(page.getByText('Готова к применению', { exact: true })).toBeVisible();
  let state = await (await request.get('/core/runtime')).json();
  expect(state.current_build_id).toBeNull();
  await page.getByRole('button', { name: 'Применить', exact: true }).click();
  await expect(page.getByText('Текущая сборка', { exact: true })).toBeVisible();
  state = await (await request.get('/core/runtime')).json();
  expect(state.current_build_id).not.toBeNull();
  expect(state.active_instance).toBeNull();
});

test('library downloads a pinned file selection and creates an editable preset without loading', async ({
  page,
  request,
}) => {
  await page.goto('/models');
  await page.getByRole('button', { name: 'Hugging Face', exact: true }).click();
  await page.getByRole('textbox', { name: 'Поиск моделей' }).fill('small');
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await page.getByRole('button', { name: 'fixture/small', exact: true }).click();
  await page.getByRole('checkbox', { name: /model.gguf/ }).check();
  await page.getByRole('button', { name: 'Скачать выбранные файлы' }).click();
  await expect(page.getByText('Доступна локально', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Создать INI', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Исходный INI' })).toHaveValue(
    /model\s*=.*model\.gguf/,
  );
  const sets = await (await request.get('/core/model-sets')).json();
  expect(sets.model_sets[0].commit).toBe('0123456789012345678901234567890123456789');
  const runtime = await (await request.get('/core/runtime')).json();
  expect(runtime.active_instance).toBeNull();
});

test('log panel filters saved output and offers a downloadable segment', async ({
  page,
  request,
}) => {
  await request.post('/core/builds', {
    headers: { 'Idempotency-Key': 'browser-log-build' },
    data: { profile: 'cpu', jobs: 2, clean: false },
  });
  await page.goto('/models?view=manage');
  await page.getByRole('button', { name: 'Логи', exact: true }).click();
  await page.getByRole('textbox', { name: 'Поиск в журнале' }).fill('fixture-compiler-started');
  await expect(page.getByLabel('Строки журнала')).toContainText('fixture-compiler-started');
  await page.getByText(/Сохранённые сегменты/).click();
  const download = page.waitForEvent('download');
  await page
    .getByRole('link', { name: /Скачать сегмент/ })
    .first()
    .click();
  expect((await download).suggestedFilename()).toBe('core-log.jsonl');
});

test('header explicitly loads the selected saved preset and unloads it again', async ({
  page,
  request,
}) => {
  const command = (path: string, data?: unknown) =>
    request.post('/core' + path, { headers: { 'Idempotency-Key': crypto.randomUUID() }, data });
  const done = async (id: string) => {
    await expect
      .poll(async () => (await (await request.get(`/core/operations/${id}`)).json()).status, {
        timeout: 15000,
      })
      .toBe('succeeded');
  };
  if (!(await (await request.get('/core/runtime')).json()).current_build_id) {
    const build = await (
      await command('/builds', { profile: 'cpu', jobs: 2, clean: false })
    ).json();
    await done(build.operation_id);
    const record = await (await request.get(`/core/operations/${build.operation_id}`)).json();
    const apply = await (await command(`/builds/${record.resource_id}/apply`)).json();
    await done(apply.operation_id);
  }
  const download = await (
    await command('/downloads', {
      repo_id: 'fixture/small',
      commit: '0123456789012345678901234567890123456789',
      files: [{ path: 'model.gguf', role: 'weights' }],
    })
  ).json();
  await done(download.operation_id);
  const sets = await (await request.get('/core/model-sets')).json();
  const file = sets.model_sets[0].files[0].local_path;
  await command('/preset-files', {
    name: 'header.ini',
    text: `[header-test]\nmodel=../data/models/${file}\nctx-size=1024\n`,
  });
  await page.goto('/models?view=manage');
  await page.getByRole('button', { name: /Модель: не загружена/ }).click();
  await page.getByRole('combobox', { name: 'Пресет для запуска' }).click();
  await page.getByRole('option', { name: 'header-test', exact: true }).click();
  await page.getByRole('button', { name: 'Запустить', exact: true }).click();
  await expect(page.getByRole('button', { name: /Модель: header-test, Готова/ })).toBeVisible();
  const inference = await request.post('/core/v1/chat/completions', {
    data: { model: 'header-test', messages: [] },
  });
  expect(inference.status()).toBe(200);
  expect((await inference.json()).choices[0].message.content).toBe('ctx=1024');
  await page.getByRole('button', { name: /Модель: header-test, Готова/ }).click();
  await page.getByRole('button', { name: 'Выгрузить', exact: true }).click();
  await expect(
    page.getByRole('button', { name: /Модель: не загружена, Не загружена/ }),
  ).toBeVisible();
});

test('download controls pause, resume and cancel the real worker', async ({ page, request }) => {
  const accepted = await (
    await request.post('/core/downloads', {
      headers: { 'Idempotency-Key': 'browser-pause' },
      data: {
        repo_id: 'fixture/large',
        commit: '0123456789012345678901234567890123456789',
        files: [{ path: 'model.gguf', role: 'weights' }],
      },
    })
  ).json();
  await page.goto('/models');
  await page.getByRole('button', { name: 'Приостановить скачивание', exact: true }).click();
  await expect(page.getByText('Пауза', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Продолжить скачивание', exact: true }).click();
  await page.getByRole('button', { name: 'Приостановить скачивание', exact: true }).click();
  await expect(page.getByText('Пауза', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Продолжить скачивание', exact: true }).click();
  await page.getByRole('button', { name: 'Отменить скачивание', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await request.get(`/core/operations/${accepted.operation_id}`)).json()).status,
    )
    .toBe('cancelled');
});

test('download progress remains accessible from the header on another app page', async ({
  page,
  request,
}) => {
  const accepted = await (
    await request.post('/core/downloads', {
      headers: { 'Idempotency-Key': 'header-download' },
      data: {
        repo_id: 'fixture/large',
        commit: '0123456789012345678901234567890123456789',
        files: [{ path: 'model.gguf', role: 'weights' }],
      },
    })
  ).json();
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Скачивание HF/ })).toContainText('fixture/large');
  await page.getByRole('button', { name: /Скачивание HF/ }).click();
  await page.getByRole('button', { name: 'Приостановить скачивание', exact: true }).click();
  await expect(page.getByText('Пауза', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Отменить скачивание', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await request.get(`/core/operations/${accepted.operation_id}`)).json()).status,
    )
    .toBe('cancelled');
  await expect(page.getByRole('button', { name: /Скачивание HF/ })).toHaveCount(0);
});

test('model deletion previews related presets and leaves their source available for repair', async ({
  page,
  request,
}) => {
  const hub = await (await request.get('/core/hub/files?repo=fixture/small')).json();
  await request.post('/core/downloads', {
    headers: { 'Idempotency-Key': 'delete-preview-download' },
    data: {
      repo_id: hub.repo_id,
      commit: hub.commit,
      files: [{ path: 'model.gguf', role: 'weights' }],
    },
  });
  await expect
    .poll(
      async () =>
        (await (await request.get('/core/model-sets')).json()).model_sets.find(
          (item: { repo_id: string }) => item.repo_id === 'fixture/small',
        )?.availability,
    )
    .toBe('available');
  const set = (await (await request.get('/core/model-sets')).json()).model_sets.find(
    (item: { repo_id: string }) => item.repo_id === 'fixture/small',
  );
  const source = await (
    await request.post('/core/preset-files', {
      headers: { 'Idempotency-Key': 'delete-preview-source' },
      data: {
        name: 'delete-reference.ini',
        text: `[delete-reference]\nmodel=../data/models/${set.files[0].local_path}\n`,
      },
    })
  ).json();
  await page.goto('/models');
  const card = page
    .locator('.mantine-Paper-root')
    .filter({ has: page.getByRole('heading', { name: 'fixture/small', exact: true }) })
    .last();
  await card.getByRole('button', { name: 'Удалить комплект', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('delete-reference');
  await page.getByRole('button', { name: 'Подтвердить удаление комплекта' }).click();
  await expect(card).toHaveCount(0);
  expect((await (await request.get(`/core/preset-files/${source.id}`)).json()).text).toContain(
    '[delete-reference]',
  );
});

test('system charts restore core session history when the page is reopened', async ({ page }) => {
  await page.goto('/models?view=manage');
  await page.getByRole('button', { name: 'Система', exact: true }).click();
  await expect(page.getByRole('img', { name: 'CPU: история текущей сессии' })).toBeVisible();
  await expect(page.getByText(/Сохранено в памяти core: [1-9]/)).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Система', exact: true }).click();
  await expect(page.getByRole('img', { name: 'RAM: история текущей сессии' })).toBeVisible();
  await expect(page.getByText(/Сохранено в памяти core: [1-9]/)).toBeVisible();
});

test('preset editor can explicitly delete a saved source', async ({ page, request }) => {
  const source = await (
    await request.post('/core/preset-files', {
      headers: { 'Idempotency-Key': 'delete-ini-ui' },
      data: {
        name: 'delete-me.ini',
        text: '; retained until delete\n[delete-me]\nctx-size=1024\n',
      },
    })
  ).json();
  await page.goto(`/models?view=manage&file=${source.id}`);
  await page.getByRole('button', { name: 'Удалить INI', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('delete-me.ini');
  await page.getByRole('button', { name: 'Подтвердить удаление INI' }).click();
  await expect(page.getByRole('textbox', { name: 'Исходный INI' })).toHaveCount(0);
  expect((await request.get(`/core/preset-files/${source.id}`)).status()).toBe(404);
});

test('a delayed older runtime response cannot replace a newer ready snapshot', async ({
  page,
  request,
}) => {
  const command = (path: string, data?: unknown) =>
    request.post('/core' + path, { headers: { 'Idempotency-Key': crypto.randomUUID() }, data });
  const done = async (id: string) => {
    await expect
      .poll(async () => (await (await request.get(`/core/operations/${id}`)).json()).status, {
        timeout: 15000,
      })
      .toBe('succeeded');
  };
  if (!(await (await request.get('/core/runtime')).json()).current_build_id) {
    const build = await (await command('/builds', { profile: 'cpu', jobs: 2 })).json();
    await done(build.operation_id);
    const record = await (await request.get(`/core/operations/${build.operation_id}`)).json();
    const apply = await (await command(`/builds/${record.resource_id}/apply`)).json();
    await done(apply.operation_id);
  }
  const download = await (
    await command('/downloads', {
      repo_id: 'fixture/small',
      commit: '0123456789012345678901234567890123456789',
      files: [{ path: 'model.gguf', role: 'weights' }],
    })
  ).json();
  await done(download.operation_id);
  const sets = await (await request.get('/core/model-sets')).json();
  const file = sets.model_sets.find((item: { repo_id: string }) => item.repo_id === 'fixture/small')
    .files[0].local_path;
  const source = await (
    await command('/preset-files', {
      name: 'network-order.ini',
      text: `[network-order]\nmodel=../data/models/${file}\nctx-size=1024\n`,
    })
  ).json();
  let release!: () => void;
  let captured!: () => void;
  let released!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const oldCaptured = new Promise<void>((resolve) => {
    captured = resolve;
  });
  const oldReleased = new Promise<void>((resolve) => {
    released = resolve;
  });
  let first = true;
  await page.route('**/core/runtime', async (route) => {
    if (!first) return route.continue();
    first = false;
    const actualResponse = await route.fetch();
    captured();
    await gate;
    await route.fulfill({ response: actualResponse });
    released();
  });
  await page.goto('/models?view=manage');
  await oldCaptured;
  const load = await (
    await command('/runtime/switch', {
      preset_id: 'network-order',
      preset_revision: source.revision,
    })
  ).json();
  await done(load.operation_id);
  await expect(page.getByRole('button', { name: /Модель: network-order, Готова/ })).toBeVisible();
  release();
  await oldReleased;
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await expect(page.getByRole('button', { name: /Модель: network-order, Готова/ })).toBeVisible();
  const unload = await (await command('/runtime/switch', { preset_id: null })).json();
  await done(unload.operation_id);
});

test('events from a retired core session cannot overwrite its replacement measurements', async ({
  page,
  request,
}) => {
  await expect
    .poll(async () => (await (await request.get('/core/metrics')).json()).samples.length)
    .toBeGreaterThan(1);
  const samples = (await (await request.get('/core/metrics')).json()).samples;
  const old = samples[0];
  const latest = samples.at(-1);
  const runtime = await (await request.get('/core/runtime')).json();
  const settings = await (await request.get('/core/settings')).json();
  const operations = (await (await request.get('/core/operations')).json()).operations;
  const nextSession = `${runtime.session_id}-replacement`;
  const snapshot = {
    runtime,
    settings,
    operations,
    catalog_revisions: { presets: null, builds: '', model_sets: '' },
  };
  const envelope = (session: string, seq: number, type: string, payload: unknown) =>
    `event: ${type}\ndata: ${JSON.stringify({ session_id: session, seq, type, timestamp: latest.timestamp, payload })}\n\n`;
  // Network replay of captured real measurements, with an old packet delayed past a session boundary.
  await page.route('**/core/events', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body:
        envelope(runtime.session_id, 1, 'snapshot', snapshot) +
        envelope(runtime.session_id, 2, 'metric.sample', old) +
        envelope(nextSession, 1, 'snapshot', {
          ...snapshot,
          runtime: { ...runtime, session_id: nextSession },
        }) +
        envelope(nextSession, 2, 'metric.sample', { ...latest, session_id: nextSession }) +
        envelope(runtime.session_id, 999, 'metric.sample', old),
    }),
  );
  await page.goto('/models?view=manage');
  await page.getByRole('button', { name: 'Система', exact: true }).click();
  await expect(page.getByTitle(latest.cpu.total.sampled_at, { exact: true }).first()).toBeVisible();
});

test('a transient management read failure recovers without reloading the page', async ({
  page,
}) => {
  let unavailable = true;
  let failures = 0;
  await page.route('**/core/runtime', async (route) => {
    if (unavailable) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'temporary_failure',
            message: 'Temporary network failure',
            retryable: true,
            details: null,
          },
          request_id: 'fixture',
        }),
      });
      failures += 1;
    } else await route.continue();
  });
  await page.goto('/models?view=manage');
  const create = page.getByRole('button', { name: 'Новый INI', exact: true });
  await expect(create).toBeDisabled();
  await expect.poll(() => failures).toBeGreaterThanOrEqual(2);
  await expect(page.getByText('Связь с core потеряна. Действия недоступны.')).toBeVisible();
  unavailable = false;
  await expect(create).toBeEnabled({ timeout: 4000 });
  await expect(page.getByText('Связь с core потеряна. Действия недоступны.')).toHaveCount(0);
});
