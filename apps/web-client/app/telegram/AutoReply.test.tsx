import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi, afterEach } from 'vitest';
import type { SecretaryChat, SecretaryChatsPage } from '@daevox/telegram-contract/secretary';
import { TelegramWorkspace } from './TelegramWorkspace';
vi.mock('./ChatHistory', () => ({ ChatHistory: () => null, UpdateStatus: () => null }));
vi.mock('./DailySummaries', () => ({ DailySummaries: () => null }));
vi.mock('./ChatSummary', () => ({ ChatSummary: () => null }));
afterEach(() => vi.unstubAllGlobals());
it('auto-reply has an independent switch and displays offline, preparation and delivery uncertainty', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const user = userEvent.setup();
  const chat: SecretaryChat = {
    id: '10',
    title: 'Тест',
    type: 'private',
    username: null,
    archived: false,
    available: true,
    enabled: false,
    observationVersion: 2,
    collection: 'disabled',
    completeness: { hasGaps: false, protectedContentSkipped: false, approximateBoundary: true },
    reason: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextAttemptAt: null,
    lastUpdate: null,
    historyImport: null,
    autoReply: { enabled: true, version: 1, state: 'preparing', reason: null, lastResult: null },
  };
  const page: SecretaryChatsPage = {
    context: { instanceId: 'test', accountId: '42', accountEpoch: 1, revision: 1 },
    chats: [chat],
    observedChats: [],
    totalKnown: 1,
    nextCursor: null,
    catalog: { status: 'ready', revision: 1, knownCount: 1 },
  };
  const onAutoReply = vi.fn();
  const props = {
    accountId: '42',
    name: 'Test',
    page,
    query: '',
    onQuery: vi.fn(),
    error: null,
    offline: false,
    pendingChat: null,
    canDisconnect: true,
    onDisconnect: vi.fn(),
    onObserve: vi.fn(),
    onAutoReply,
  };
  const view = render(<TelegramWorkspace {...props} />);
  await user.click(screen.getByRole('button', { name: 'История · Тест' }));
  const control = screen.getByRole('switch', { name: 'Автоответчик · Тест' });
  expect(control).toBeChecked();
  expect(screen.getByText('Автоответчик готовит саммари')).toBeVisible();
  await user.click(control);
  expect(onAutoReply).toHaveBeenCalledWith(chat, false);
  view.rerender(<TelegramWorkspace {...props} offline />);
  expect(control).toBeDisabled();
  expect(screen.getByText('Нет связи', { exact: true })).toBeVisible();
  const unknown = {
    ...chat,
    autoReply: { ...chat.autoReply, state: 'error', reason: 'Результат отправки неизвестен' },
  };
  view.rerender(<TelegramWorkspace {...props} page={{ ...page, chats: [unknown] }} />);
  expect(screen.getByText(/Результат отправки неизвестен/)).toBeVisible();
  view.rerender(<TelegramWorkspace {...props} pendingChat="10" />);
  expect(control).toBeDisabled();
});
