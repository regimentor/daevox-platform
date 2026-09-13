import { useState } from 'react';
import { Button, Group, Progress, Select, Stack, Text } from '@mantine/core';
import type { ModelFile, Operation } from '@daevox/core/client';
import { api, useCore } from './state';
const labels: Record<Operation['status'], string> = {
  queued: 'В очереди',
  running: 'Скачивается',
  paused: 'Пауза',
  succeeded: 'Завершено',
  failed: 'Ошибка скачивания',
  cancelled: 'Скачивание отменено',
  interrupted: 'Прервано',
};
export function DownloadControls({
  operation,
  files = [],
}: {
  operation: Operation;
  files?: ModelFile[];
}) {
  const { connected, refresh } = useCore();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [file, setFile] = useState<string | null>(null);
  const action = async (run: () => Promise<unknown>) => {
    setPending(true);
    setError('');
    try {
      await run();
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  };
  const disabled =
    !connected || pending || operation.phase === 'pausing' || operation.phase === 'cancelling';
  return (
    <Stack gap="xs" mt="sm">
      <Text size="sm">
        {operation.phase === 'pausing'
          ? 'Остановка worker для паузы'
          : operation.phase === 'cancelling'
            ? 'Отмена скачивания'
            : labels[operation.status]}
      </Text>
      {operation.progress?.percent !== undefined && operation.progress.percent !== null && (
        <Progress value={operation.progress.percent} aria-label="Прогресс скачивания" />
      )}
      {operation.progress && (
        <Text size="xs" c="dimmed">
          {operation.progress.bytes_done ?? '—'} /{' '}
          {operation.progress.bytes_total ?? 'размер неизвестен'} байт
          {operation.progress.percent === null
            ? ''
            : ` · ${operation.progress.percent.toFixed(1)}%`}
        </Text>
      )}
      <Group>
        {operation.allowed_actions.includes('pause') && (
          <Button
            size="xs"
            variant="light"
            disabled={disabled}
            onClick={() => void action(() => api.pauseDownload(operation.id))}
          >
            Приостановить скачивание
          </Button>
        )}
        {operation.allowed_actions.includes('resume') && (
          <Button
            size="xs"
            variant="light"
            disabled={disabled}
            onClick={() => void action(() => api.resumeDownload(operation.id))}
          >
            Продолжить скачивание
          </Button>
        )}
        {operation.allowed_actions.includes('cancel') && (
          <Button
            size="xs"
            variant="subtle"
            color="red"
            disabled={disabled}
            onClick={() => void action(() => api.cancelDownload(operation.id))}
          >
            Отменить скачивание
          </Button>
        )}
      </Group>
      {operation.allowed_actions.includes('restart-file') && files.length > 0 && (
        <details>
          <summary>Скачать отдельный файл заново</summary>
          <Text size="xs" c="dimmed">
            Сохранённая незавершённая часть выбранного файла будет удалена.
          </Text>
          <Select
            label="Файл для перезапуска"
            value={file}
            onChange={setFile}
            data={files
              .filter((item) => item.availability !== 'available')
              .map((item) => ({ value: item.id, label: item.path }))}
          />
          <Button
            mt="xs"
            color="orange"
            size="xs"
            disabled={disabled || !file}
            onClick={() => {
              if (file) void action(() => api.restartFile(operation.id, { file_id: file }));
            }}
          >
            Скачать файл заново
          </Button>
        </details>
      )}
      {operation.error && (
        <Text size="sm" c="red">
          {operation.error.message}
        </Text>
      )}
      {error && (
        <Text role="alert" size="sm" c="red">
          {error}
        </Text>
      )}
    </Stack>
  );
}
