import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Modal, SegmentedControl, Stack, Text } from '@mantine/core';
import type { ChatSummary as Summary, SecretaryContext } from '@daevox/telegram-contract/secretary';

export function ChatSummary({
  accountId,
  chatId,
  title,
  onClose,
}: {
  accountId: string;
  chatId: string;
  title: string;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<'all' | 'latest'>('all');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const sequence = useRef(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setSummary(null);
    setError(null);
    setLoading(true);
    setSending(false);
    const load = async () => {
      const request = ++sequence.current;
      try {
        const params = new URLSearchParams({ accountId, chatId, scope });
        const response = await fetch(`/api/secretary/summary?${params}`, { cache: 'no-store' });
        if (!response.ok) throw new Error('failed');
        const body = (await response.json()) as {
          context: SecretaryContext;
          summary: Summary | null;
        };
        if (body.context.accountId !== accountId) throw new Error('account');
        if (!cancelled && request === sequence.current) {
          setSummary(body.summary);
          setLoading(false);
        }
      } catch {
        if (!cancelled && request === sequence.current) {
          setError('Не удалось загрузить сводку. Повторяем запрос…');
          setLoading(false);
        }
      }
      if (!cancelled) timer = setTimeout(() => void load(), 2000);
    };
    void load();
    return () => {
      cancelled = true;
      sequence.current++;
      if (timer) clearTimeout(timer);
    };
  }, [accountId, chatId, scope]);
  const generate = async () => {
    const request = ++sequence.current;
    setSending(true);
    setError(null);
    try {
      const response = await fetch('/api/secretary/summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, chatId, scope }),
      });
      if (!response.ok)
        throw new Error(
          response.status === 422
            ? 'В выбранной истории нет текстовых сообщений.'
            : response.status === 429
              ? 'Модель уже обрабатывает другой чат. Попробуйте позже.'
              : 'Не удалось запустить суммаризацию.',
        );
      const body = (await response.json()) as { context: SecretaryContext; summary: Summary };
      if (body.context.accountId !== accountId) throw new Error('Аккаунт изменился.');
      if (request === sequence.current) setSummary(body.summary);
    } catch (cause) {
      if (request === sequence.current)
        setError(cause instanceof Error ? cause.message : 'Ошибка запроса');
    } finally {
      setSending(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={`Сводка · ${title}`} size="lg">
      <Stack>
        <Text size="sm" c="dimmed">
          Локальная модель составит краткую сводку: главное, договорённости, задачи и открытые
          вопросы.
        </Text>
        <SegmentedControl
          value={scope}
          disabled={sending}
          onChange={(value) => setScope(value as 'all' | 'latest')}
          data={[
            { value: 'all', label: 'Последние 200 сообщений' },
            { value: 'latest', label: 'Последнее обновление' },
          ]}
        />
        {loading && <Text role="status">Загружаем сводку…</Text>}
        {error && (
          <Alert color="red" role="alert">
            {error}
          </Alert>
        )}
        {summary?.status === 'running' && (
          <Text role="status">Составляем сводку… Можно закрыть окно, обработка продолжится.</Text>
        )}
        {summary?.error && (
          <Alert color="red" role="alert">
            {summary.error}
          </Alert>
        )}
        {summary?.stale && <Alert color="yellow">Переписка изменилась. Обновите сводку.</Alert>}
        {summary?.text && (
          <Text style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{summary.text}</Text>
        )}
        {summary && (
          <Text size="xs" c="dimmed">
            Учтено текстовых сообщений: {summary.messageCount}
            {summary.truncated ? ' · Объём ограничен контекстом модели' : ''}
            {summary.completedAt
              ? ` · ${new Date(summary.completedAt).toLocaleString('ru-RU')}`
              : ''}
          </Text>
        )}
        <Button
          disabled={loading || sending || summary?.status === 'running'}
          onClick={() => void generate()}
        >
          {sending ? 'Запускаем…' : summary ? 'Обновить сводку' : 'Суммаризировать чат'}
        </Button>
        <Text size="xs" c="dimmed">
          Сводка создана моделью и может содержать ошибки. Номера [№ …] указывают на исходные
          сообщения.
        </Text>
      </Stack>
    </Modal>
  );
}
