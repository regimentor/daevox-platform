import { MantineProvider } from '@mantine/core';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { Snapshot } from '@daevox/telegram-contract';
import type { SecretaryChat, SecretaryChatsPage } from '@daevox/telegram-contract/secretary';
import Telegram from './telegram';

const initial: Snapshot = {
  instanceId: 'test',
  revision: 1,
  controlVersion: 1,
  client: 'running',
  connection: 'ready',
  authorization: { kind: 'password' },
  allowedActions: ['submit_password'],
  operation: null,
  error: null,
};
afterEach(() => vi.unstubAllGlobals());

it('shows observed chats outside the first page before searching and after clearing or changing the query', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const observed: SecretaryChat = {
    id: '99',
    title: 'Лапуля',
    type: 'private',
    username: null,
    archived: false,
    available: true,
    enabled: true,
    autoReply: { enabled: false, version: 0, state: 'disabled', reason: null, lastResult: null },
    observationVersion: 1,
    collection: 'catching_up',
    reason: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextAttemptAt: null,
    lastUpdate: null,
    historyImport: null,
    completeness: { hasGaps: false, protectedContentSkipped: false, approximateBoundary: true },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/secretary/daily-summaries')
        return new Response(
          JSON.stringify({
            context: { accountId: '42' },
            summaries: [
              {
                day: '2026-09-09',
                status: 'ready',
                text: '## Главное\n\n**Договорились встретиться завтра.**\n\n- Подготовить отчёт\n\n<script>alert(1)</script>\n\n![tracker](https://example.com/tracker.png)',
                message_count: 12,
                completed_chunks: 1,
                total_chunks: 1,
              },
            ],
          }),
        );
      if (url.pathname === '/api/secretary/history')
        return new Response(
          JSON.stringify({
            context: { accountId: '42' },
            lastUpdate: {
              id: 'update',
              processedAt: '2026-09-09T12:00:00Z',
              status: 'processed',
              saved: 1,
              skipped: 0,
              deleted: 0,
            },
            messages: [
              {
                id: '501',
                date: 123,
                outgoing: false,
                author: 'Test',
                text: 'Сохранённое сообщение',
                caption: null,
                mediaType: null,
                deleted: false,
                skipped: false,
              },
            ],
            nextCursor: null,
          }),
        );
      if (url.pathname === '/api/secretary/chats') {
        const page: SecretaryChatsPage = {
          context: { instanceId: 'test', accountId: '42', accountEpoch: 1, revision: 1 },
          catalog: { status: 'ready', revision: 1, knownCount: 99 },
          chats: url.searchParams.get('q') === 'лапу' ? [observed] : [],
          observedChats: [observed],
          totalKnown: 99,
          nextCursor: null,
        };
        return new Response(JSON.stringify(page));
      }
      return new Response(
        JSON.stringify({
          ...initial,
          authorization: {
            kind: 'connected',
            account: { id: '42', displayName: 'Test', username: null },
          },
          allowedActions: ['disconnect'],
        }),
      );
    }),
  );
  const user = userEvent.setup();
  render(
    <MantineProvider>
      <Telegram />
    </MantineProvider>,
  );
  expect(await screen.findByRole('button', { name: 'История · Лапуля' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'История · Лапуля' }));
  await waitFor(() => expect(screen.getByText('Договорились встретиться завтра.')).toBeVisible());
  expect(screen.getByRole('region', { name: 'Сводки по дням · Лапуля' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Главное' })).toBeVisible();
  expect(screen.getByText('Договорились встретиться завтра.').tagName).toBe('STRONG');
  expect(screen.getByText('Подготовить отчёт').tagName).toBe('LI');
  expect(screen.queryByRole('img', { name: 'tracker' })).not.toBeInTheDocument();
  expect(document.querySelector('script')).toBeNull();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByText('Сохранённое сообщение')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'История' }));
  expect(await screen.findByText('Сохранённое сообщение')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Сводки' }));
  expect(await screen.findByText('Договорились встретиться завтра.')).toBeVisible();
  const search = screen.getByLabelText('Поиск по названию или ID');
  await user.type(search, 'лапу');
  expect(await screen.findByRole('switch', { name: 'Наблюдать за Лапуля' })).toBeChecked();
  await user.clear(search);
  expect(screen.getByRole('switch', { name: 'Наблюдать за Лапуля' })).toBeChecked();
  expect(screen.getByRole('button', { name: 'История · Лапуля' })).toBeVisible();
  await user.type(search, 'нет совпадений');
  expect(screen.getByRole('button', { name: 'История · Лапуля' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Назад к чатам' }));
  expect(screen.queryByRole('switch')).not.toBeInTheDocument();
});

it('clears and disables the password immediately on submission, then renders the confirmed account', async () => {
  let accept!: (response: Response) => void;
  const fetcher = vi.fn<typeof fetch>();
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify(initial)));
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        accept = resolve;
      }),
  );
  fetcher.mockResolvedValue(
    new Response(
      JSON.stringify({
        ...initial,
        revision: 2,
        controlVersion: 2,
        authorization: { kind: 'connected', account: null },
        allowedActions: ['disconnect'],
      }),
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  const user = userEvent.setup();
  render(
    <MantineProvider>
      <Telegram />
    </MantineProvider>,
  );
  const password = await screen.findByLabelText('Пароль Telegram');
  await waitFor(() => expect(password).toBeEnabled());
  await user.type(password, 'temporary-password');
  await user.click(screen.getByRole('button', { name: 'Продолжить' }));
  expect(password).toHaveValue('');
  expect(password).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Продолжить' })).toBeDisabled();
  expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  accept(
    new Response(JSON.stringify({ instanceId: 'test', operationId: 'command' }), { status: 202 }),
  );
  expect(await screen.findByRole('heading', { name: 'Аккаунт подключён' })).toBeVisible();
  expect(screen.getByText('Сведения об аккаунте пока недоступны.')).toBeVisible();
});
