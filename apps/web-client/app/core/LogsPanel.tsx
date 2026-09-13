import { useEffect, useRef, useState } from 'react';
import { Anchor, Checkbox, Group, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import type { Logs } from '@daevox/core/client';
import { api } from './state';
export function LogsPanel() {
  const [source, setSource] = useState('all');
  const [query, setQuery] = useState('');
  const [follow, setFollow] = useState(true);
  const [logs, setLogs] = useState<Logs | null>(null);
  const [error, setError] = useState('');
  const consoleRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let closed = false;
    const load = async () => {
      try {
        const result = await api.logs({ source, query });
        if (!closed) {
          setLogs(result);
          setError('');
        }
      } catch (caught) {
        if (!closed) setError(String(caught));
      }
    };
    void load();
    const timer = setInterval(() => void load(), 1000);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, [source, query]);
  useEffect(() => {
    if (follow && consoleRef.current)
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
  }, [logs, follow]);
  return (
    <Stack>
      <Title order={3}>Журналы core</Title>
      <Group align="end">
        <Select
          label="Источник журнала"
          value={source}
          onChange={(value) => setSource(value ?? 'all')}
          data={['all', 'core', 'router', 'model', 'build']}
        />
        <TextInput
          label="Поиск в журнале"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          style={{ flex: 1 }}
        />
        <Checkbox
          label="Автопрокрутка"
          checked={follow}
          onChange={(event) => setFollow(event.currentTarget.checked)}
        />
      </Group>
      {logs?.gap && <Text c="orange">Часть журнала недоступна: ротация или пропуск записи.</Text>}
      <pre
        ref={consoleRef}
        aria-label="Строки журнала"
        style={{
          minHeight: 180,
          maxHeight: 500,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          background: 'light-dark(#f5f6f8,#12171d)',
          padding: 16,
        }}
      >
        {logs?.entries
          .map(
            (entry) =>
              `${entry.timestamp} [${entry.source}/${entry.stream}] ${entry.message}${entry.truncated ? ' [фрагмент строки]' : ''}${entry.dropped_before ? ` [пропущено ${entry.dropped_before}]` : ''}`,
          )
          .join('\n') || 'Доступных записей нет'}
      </pre>
      <details>
        <summary>Сохранённые сегменты ({logs?.segments.length ?? 0})</summary>
        <Stack gap="xs" mt="sm">
          {logs?.segments.map((segment, index) => (
            <Anchor
              key={segment.id}
              href={`/core/logs/${encodeURIComponent(segment.id)}/download`}
              download
            >
              Скачать сегмент {index + 1} · {segment.size_bytes} байт
            </Anchor>
          ))}
        </Stack>
      </details>
      {error && (
        <Text role="alert" c="red">
          {error}
        </Text>
      )}
    </Stack>
  );
}
