import { useState } from 'react';
import { Alert, Button, Modal, Stack, Text } from '@mantine/core';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { DailySummary } from '@daevox/telegram-contract/secretary';
import styles from './DailySummaries.module.css';
import { useInfiniteFeed } from './useInfiniteFeed';

const labels = { queued: 'В очереди', running: 'Суммаризация…', ready: 'Готово', error: 'Ошибка' };
export function DailySummaries({
  accountId,
  chatId,
  title,
  onClose,
  onManual,
  inline = false,
}: {
  accountId: string;
  chatId: string;
  title: string;
  onClose: () => void;
  onManual: () => void;
  inline?: boolean;
}) {
  const {
    pages,
    loading,
    error: loadError,
    hasMore,
    sentinel,
    refresh,
  } = useInfiniteFeed<{
    context: { accountId: string | null };
    summaries: DailySummary[];
    nextCursor: string | null;
  }>(`/api/secretary/daily-summaries?${new URLSearchParams({ accountId, chatId })}`, accountId);
  const items = pages.length
    ? [...new Map(pages.flatMap((page) => page.summaries).map((item) => [item.day, item])).values()]
    : null;
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const retry = async (day: string) => {
    setPending(true);
    setError(null);
    try {
      const response = await fetch('/api/secretary/daily-summaries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, chatId, day }),
      });
      if (!response.ok) throw new Error('failed');
      refresh();
    } catch {
      setError('Не удалось поставить сводку в очередь.');
    } finally {
      setPending(false);
    }
  };
  const content = (
    <Stack>
      <Text size="sm" c="dimmed">
        Создаются автоматически после загрузки 30-дневной истории. Даты — по времени Алматы (UTC+5).
        Можно закрыть окно: задачи продолжат работать в фоне.
      </Text>
      {(error || loadError) && (
        <Alert color="red" role="alert">
          {error ?? 'Не удалось обновить сводки. Повторяем запрос…'}
        </Alert>
      )}
      {!items && !error && <Text role="status">Загружаем сводки…</Text>}
      {items?.length === 0 && (
        <Text>Сводки появятся после загрузки дней с текстовыми сообщениями.</Text>
      )}
      {items && (
        <Text size="sm">
          Среди загруженных дней готово: {items.filter((item) => item.status === 'ready').length} из{' '}
          {items.length}
        </Text>
      )}
      <div className={styles.feed} role="region" aria-label={`Сводки по дням · ${title}`}>
        {items
          ?.toSorted((a, b) => b.day.localeCompare(a.day))
          .map((item) => (
            <article key={item.day} className={styles.card} aria-label={`Сводка за ${item.day}`}>
              <header className={styles.day}>
                <time dateTime={item.day}>{item.day}</time> · {labels[item.status]}
                {item.status === 'running'
                  ? ` · ${item.completed_chunks}/${item.total_chunks} частей`
                  : ''}
              </header>
              <Stack gap="sm">
                <Text size="xs" c="dimmed">
                  Сообщений: {item.message_count}
                </Text>
                {item.error && <Text c="red">{item.error}</Text>}
                {item.text && (
                  <div className={styles.markdown}>
                    <Markdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={['img']}>
                      {item.text}
                    </Markdown>
                  </div>
                )}
                {(item.status === 'error' || item.status === 'ready') && (
                  <Button
                    size="xs"
                    variant="light"
                    disabled={pending}
                    onClick={() => void retry(item.day)}
                  >
                    {item.status === 'error' ? 'Повторить' : 'Обновить'}
                  </Button>
                )}
              </Stack>
            </article>
          ))}
        {hasMore && <div ref={sentinel} style={{ minHeight: 1 }} aria-hidden="true" />}
        {loading && items && <Text role="status">Загружаем сводки…</Text>}
      </div>
      <Button variant="subtle" onClick={onManual}>
        Разовая сводка по запросу
      </Button>
    </Stack>
  );
  return inline ? (
    <div className={styles.scroll}>{content}</div>
  ) : (
    <Modal opened onClose={onClose} title={`Сводки по датам · ${title}`} size="lg">
      {content}
    </Modal>
  );
}
