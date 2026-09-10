import { useState } from 'react';
import { MantineProvider, Modal, Button, Switch } from '@mantine/core';
import type { SecretaryChat, SecretaryChatsPage } from '@daevox/telegram-contract/secretary';
import { ChatHistory, UpdateStatus } from './ChatHistory';
import { ChatSummary } from './ChatSummary';
import { DailySummaries } from './DailySummaries';
import styles from './TelegramWorkspace.module.css';

export function TelegramWorkspace({
  accountId,
  name,
  page,
  query,
  onQuery,
  error,
  offline,
  canDisconnect,
  onDisconnect,
  onObserve,
  onAutoReply,
  pendingChat,
}: {
  accountId: string;
  name: string;
  page: SecretaryChatsPage | null;
  query: string;
  onQuery: (value: string) => void;
  error: string | null;
  offline: boolean;
  canDisconnect: boolean;
  onDisconnect: () => void;
  pendingChat: string | null;
  onAutoReply: (chat: SecretaryChat, enabled: boolean) => void;
  onObserve: (chat: SecretaryChat, enabled: boolean) => void;
}) {
  const [selected, setSelected] = useState<SecretaryChat | null>(null);
  const [observedOnly, setObservedOnly] = useState(false);
  const [settings, setSettings] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [summaryChat, setSummaryChat] = useState<SecretaryChat | null>(null);
  const [manualSummary, setManualSummary] = useState(false);
  const [view, setView] = useState<{ chatId: string; enabled: boolean; history: boolean } | null>(
    null,
  );
  const observed = page?.observedChats ?? [];
  const rows = [
    ...new Map(
      [...(observedOnly ? [] : (page?.chats ?? [])), ...observed].map((chat) => [chat.id, chat]),
    ).values(),
  ];
  rows.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.title.localeCompare(b.title));
  const chat = rows.find((row) => row.id === selected?.id) ?? selected;
  const showHistory =
    chat &&
    (view?.chatId === chat.id && view.enabled === chat.enabled ? view.history : !chat.enabled);
  return (
    <MantineProvider forceColorScheme="dark">
      {summaryChat &&
        (manualSummary ? (
          <ChatSummary
            key={`${accountId}:${summaryChat.id}`}
            accountId={accountId}
            chatId={summaryChat.id}
            title={summaryChat.title || summaryChat.id}
            onClose={() => setSummaryChat(null)}
          />
        ) : (
          <DailySummaries
            key={`${accountId}:${summaryChat.id}`}
            accountId={accountId}
            chatId={summaryChat.id}
            title={summaryChat.title || summaryChat.id}
            onClose={() => setSummaryChat(null)}
            onManual={() => setManualSummary(true)}
          />
        ))}
      <div className={styles.workspace} data-chat-open={!!chat}>
        <nav className={styles.rail} aria-label="Разделы Telegram">
          <button
            onClick={() => setSettings(true)}
            aria-label="Настройки аккаунта"
            className={styles.railButton}
          >
            ☰
          </button>
          <button
            className={styles.railButton}
            aria-pressed={!observedOnly}
            onClick={() => setObservedOnly(false)}
          >
            <span>◉</span>Все чаты
          </button>
          <button
            className={styles.railButton}
            aria-pressed={observedOnly}
            onClick={() => setObservedOnly(true)}
          >
            <span>✓</span>Наблюдение<small>{observed.length}</small>
          </button>
          <div className={styles.railFooter}>D</div>
        </nav>
        <aside className={styles.sidebar} aria-label="Telegram-чаты">
          <div className={styles.search}>
            <input
              aria-label="Поиск по названию или ID"
              placeholder="Поиск по названию или ID"
              value={query}
              onChange={(event) => onQuery(event.target.value)}
            />
          </div>
          <div className={styles.listHeading}>
            {observedOnly ? 'Наблюдаемые чаты' : 'Все чаты'}
            <span>{rows.length}</span>
          </div>
          {offline && (
            <div className={styles.notice} role="status">
              Нет связи с сервером
            </div>
          )}
          {error && (
            <div className={styles.notice} role="alert">
              {error}
            </div>
          )}
          <div className={styles.chatList}>
            {rows.map((item) => (
              <button
                key={item.id}
                className={styles.chatRow}
                aria-label={`История · ${item.title || item.id}`}
                aria-pressed={chat?.id === item.id}
                onClick={() => {
                  setSelected(item);
                  setView(null);
                }}
              >
                <span
                  className={styles.avatar}
                  style={{ background: `hsl(${Math.abs(Number(item.id)) % 360} 48% 48%)` }}
                >
                  {(item.title || '?').slice(0, 2).toUpperCase()}
                </span>
                <span className={styles.rowBody}>
                  <span className={styles.rowTitle}>{item.title || `Чат ${item.id}`}</span>
                  <span className={styles.preview}>
                    {item.lastUpdate?.status === 'error'
                      ? 'Ошибка сохранения'
                      : item.lastUpdate
                        ? `Обработано сообщений: ${item.lastUpdate.saved + item.lastUpdate.skipped + item.lastUpdate.deleted}`
                        : 'Обновлений ещё не было'}
                  </span>
                </span>
                <span className={styles.rowMeta}>
                  {item.lastUpdate && (
                    <time>
                      {new Date(item.lastUpdate.processedAt).toLocaleTimeString('ru-RU', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                  )}
                  {item.enabled && (
                    <span className={styles.observedDot} title="Наблюдение включено">
                      ✓
                    </span>
                  )}
                </span>
              </button>
            ))}
            {!page && <p className={styles.empty}>Загружаем чаты…</p>}
            {page && !rows.length && <p className={styles.empty}>Чаты не найдены</p>}
          </div>
          <div className={styles.sidebarFooter}>Секретарь наблюдает: {observed.length}</div>
        </aside>
        <main className={styles.conversation}>
          {chat ? (
            <>
              <header className={styles.chatHeader}>
                <button
                  className={styles.back}
                  onClick={() => setSelected(null)}
                  aria-label="Назад к чатам"
                >
                  ←
                </button>
                <div className={styles.headerTitle}>
                  <strong>{chat.title || `Чат ${chat.id}`}</strong>
                  <small>
                    {chat.enabled ? 'Наблюдение включено' : 'Наблюдение выключено'} · локальный
                    архив
                  </small>
                </div>
                <Button
                  size="xs"
                  variant="light"
                  onClick={() => {
                    setView({ chatId: chat.id, enabled: chat.enabled, history: !showHistory });
                  }}
                >
                  {showHistory ? 'Сводки' : 'История'}
                </Button>
                <Switch
                  aria-label={`Наблюдать за ${chat.title}`}
                  disabled={offline || pendingChat === chat.id}
                  checked={chat.enabled}
                  onChange={(event) => onObserve(chat, event.currentTarget.checked)}
                />
              </header>
              <div className={styles.updateBar}>
                <Switch
                  label="Автоответчик"
                  aria-label={`Автоответчик · ${chat.title || chat.id}`}
                  checked={chat.autoReply?.enabled ?? false}
                  disabled={offline || pendingChat === chat.id || !chat.autoReply}
                  onChange={(event) => onAutoReply(chat, event.currentTarget.checked)}
                />
                <div role="status">
                  {offline ? 'Нет связи' : autoReplyLabel(chat.autoReply?.state ?? 'disabled')}
                  {!offline && chat.autoReply?.reason && ` · ${chat.autoReply.reason}`}
                  {!offline &&
                    chat.autoReply?.lastResult?.reason &&
                    chat.autoReply.lastResult.reason !== chat.autoReply.reason &&
                    ` · ${chat.autoReply.lastResult.reason}`}
                </div>
              </div>
              <div className={styles.updateBar}>
                {chat.historyImport && (
                  <div role="status">
                    {chat.historyImport.status === 'ready'
                      ? `История за 30 дней загружена · ${chat.historyImport.processed} сообщений`
                      : !chat.enabled
                        ? 'Загрузка истории приостановлена'
                        : chat.historyImport.status === 'error'
                          ? chat.historyImport.error
                          : `Загружаем историю за 30 дней… Обработано: ${chat.historyImport.processed}`}
                  </div>
                )}
                <UpdateStatus update={chat.lastUpdate} />
                {chat.completeness.hasGaps && <small>В архиве есть пропуск</small>}
              </div>
              {showHistory ? (
                <ChatHistory
                  key={`${accountId}:${chat.id}`}
                  accountId={accountId}
                  chat={chat}
                  inline
                  onClose={() => setSelected(null)}
                />
              ) : (
                <DailySummaries
                  key={`${accountId}:${chat.id}`}
                  accountId={accountId}
                  chatId={chat.id}
                  title={chat.title || chat.id}
                  inline
                  onClose={() => setSelected(null)}
                  onManual={() => {
                    setManualSummary(true);
                    setSummaryChat(chat);
                  }}
                />
              )}
              <footer className={styles.readOnly}>
                {showHistory ? 'Архив переписки · только просмотр' : 'Сводки секретаря · по дням'}
                <span>Обновляется автоматически</span>
              </footer>
            </>
          ) : (
            <div className={styles.welcome}>
              <div className={styles.welcomeIcon}>↗</div>
              <h2>Ваши Telegram-чаты</h2>
              <p>Выберите чат, чтобы увидеть обработанную историю</p>
              <small>Наблюдаемые чаты всегда остаются в списке</small>
            </div>
          )}
        </main>
        <Modal
          opened={settings}
          onClose={() => {
            setSettings(false);
            setConfirm(false);
          }}
          title="Аккаунт подключён"
        >
          <p>{name}</p>
          <p>
            {confirm
              ? 'Отключить аккаунт? Для повторного подключения потребуется вход в Telegram.'
              : 'Закрытие страницы не останавливает наблюдение за чатами.'}
          </p>
          <Button
            color="red"
            disabled={!canDisconnect}
            onClick={() => {
              if (confirm) onDisconnect();
              else setConfirm(true);
            }}
          >
            {confirm ? 'Подтвердить отключение' : 'Отключить аккаунт'}
          </Button>
        </Modal>
      </div>
    </MantineProvider>
  );
}

function autoReplyLabel(state: string) {
  const labels: Record<string, string> = {
    disabled: 'Автоответчик выключен',
    working: 'Автоответчик работает',
    waiting_telegram: 'Автоответчик ожидает синхронизации Telegram',
    preparing: 'Автоответчик готовит саммари',
    insufficient_data: 'Недостаточно данных',
    paused: 'Автоответчик приостановлен',
    error: 'Ошибка автоответчика',
  };
  return labels[state] ?? 'Состояние автоответчика неизвестно';
}
