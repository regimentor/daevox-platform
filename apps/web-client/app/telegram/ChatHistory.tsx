import { useState } from 'react';
import { Alert, Modal, Paper, SegmentedControl, Stack, Text } from '@mantine/core';
import type {
  SecretaryChat,
  SecretaryChatUpdate,
  SecretaryHistoryPage,
} from '@daevox/telegram-contract/secretary';
import styles from './ChatHistory.module.css';
import { useInfiniteFeed } from './useInfiniteFeed';

export function UpdateStatus({ update }: { update: SecretaryChatUpdate | null }) {
  if (!update)
    return (
      <Text size="sm" c="dimmed">
        Обновлений сообщений ещё не было.
      </Text>
    );
  return (
    <Text size="sm" c={update.status === 'error' ? 'red' : undefined}>
      Последнее обновление: {new Date(update.processedAt).toLocaleString('ru-RU')} —{' '}
      {update.status === 'error'
        ? 'ошибка сохранения'
        : `обработано · сохранено: ${update.saved}, пропущено: ${update.skipped}, удалено: ${update.deleted}`}
    </Text>
  );
}

export function ChatHistory({
  accountId,
  chat,
  onClose,
  inline = false,
}: {
  accountId: string;
  chat: SecretaryChat;
  onClose: () => void;
  inline?: boolean;
}) {
  const [scope, setScope] = useState(inline ? 'all' : 'latest');
  const { pages, loading, error, hasMore, sentinel } = useInfiniteFeed<SecretaryHistoryPage>(
    `/api/secretary/history?${new URLSearchParams({ accountId, chatId: chat.id, scope })}`,
    accountId,
  );
  const page = pages[0];
  const messages = [
    ...new Map(
      pages.flatMap((entry) => entry.messages).map((message) => [message.id, message]),
    ).values(),
  ];
  const history = (
    <Stack className={inline ? styles.history : undefined}>
      {!inline && <UpdateStatus update={page?.lastUpdate ?? chat.lastUpdate} />}
      {!inline && (
        <Text size="sm" c="dimmed">
          Сообщения, обработанные секретарём и сохранённые в локальном архиве. Новые сообщения
          сверху.
        </Text>
      )}
      <SegmentedControl
        value={scope}
        onChange={(value) => {
          setScope(value);
        }}
        data={[
          { value: 'latest', label: 'Последнее обновление' },
          { value: 'all', label: 'Весь архив' },
        ]}
      />
      {error && (
        <Alert color="red" role="alert">
          Не удалось обновить историю. Повторяем загрузку…
        </Alert>
      )}
      {!page && !error && <Text role="status">Загружаем историю…</Text>}
      {page?.messages.length === 0 && <Text c="dimmed">Обработанных сообщений нет.</Text>}
      <div className={inline ? styles.messages : undefined}>
        {messages.map((message) => (
          <Paper
            key={message.id}
            withBorder={!inline}
            p="sm"
            className={inline ? styles.bubble : undefined}
            data-outgoing={message.outgoing}
          >
            <Text size="xs" c="dimmed">
              {message.date
                ? new Date(message.date * 1000).toLocaleString('ru-RU')
                : 'Дата неизвестна'}{' '}
              · {message.outgoing ? 'Вы' : (message.author ?? 'Автор неизвестен')} · № {message.id}
            </Text>
            <Text style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {message.deleted
                ? 'Сообщение удалено'
                : message.skipped
                  ? 'Защищённое содержимое пропущено'
                  : message.text ||
                    message.caption ||
                    (message.mediaType ? 'Вложение' : 'Сообщение без текста')}
            </Text>
          </Paper>
        ))}
        {hasMore && (
          <div ref={sentinel} style={{ minHeight: 1, flexShrink: 0 }} aria-hidden="true" />
        )}
        {loading && page && <Text role="status">Загружаем сообщения…</Text>}
      </div>
    </Stack>
  );
  return inline ? (
    history
  ) : (
    <Modal
      opened
      onClose={onClose}
      title={`Обработанная история · ${chat.title || chat.id}`}
      size="lg"
    >
      {history}
    </Modal>
  );
}
