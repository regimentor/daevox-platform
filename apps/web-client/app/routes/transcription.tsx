import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Container,
  FileInput,
  Group,
  Loader,
  Pagination,
  Paper,
  Progress,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { base, isTerminal, request, subscribe, type Snapshot } from '../transcription/client';

export const meta = () => [{ title: 'Транскрибация · Daevox' }];
const stages: Record<string, string> = {
  acquisition: 'Получение источника',
  preparation: 'Подготовка аудио',
  asr_model: 'Модель распознавания',
  diarization_model: 'Модель спикеров',
  asr: 'Распознавание речи',
  diarization: 'Разделение по спикерам',
  saving: 'Сохранение',
};
const statuses = {
  awaiting_upload: 'Ожидание файла',
  running: 'Обработка',
  cancelling: 'Отмена и сохранение',
  completed: 'Готово',
  cancelled: 'Отменено',
  failed: 'Завершено с ошибкой',
};
const phaseStates = {
  pending: 'Ожидание',
  running: 'Выполняется',
  completed: 'Завершён',
  cancelled: 'Остановлен',
  failed: 'Ошибка',
};
const time = (seconds: number) => {
  const value = Math.floor(seconds);
  return `${Math.floor(value / 3600)
    .toString()
    .padStart(2, '0')}:${Math.floor((value / 60) % 60)
    .toString()
    .padStart(2, '0')}:${(value % 60).toString().padStart(2, '0')}`;
};

export default function Transcription() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [online, setOnline] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState('file');
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [language, setLanguage] = useState('auto');
  const [page, setPage] = useState(1);
  const [follow, setFollow] = useState(true);
  const upload = useRef<AbortController | null>(null);
  const requestId = useRef<string | null>(null);
  const active = !!snapshot && !isTerminal(snapshot);
  const operationId = snapshot?.operation_id;

  useEffect(() => {
    let disposed = false;
    request<Snapshot | null>(`${base}/current`)
      .then((value) => {
        if (!disposed) setSnapshot(value);
      })
      .catch(() => {
        if (!disposed)
          setError('Сервис транскрибации недоступен. Запустите backend и обновите страницу.');
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
      upload.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!snapshot || isTerminal(snapshot)) return;
    return subscribe(snapshot, setSnapshot, setOnline);
    // The subscription owns subsequent revisions until this operation changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operationId]);

  async function start() {
    setSending(true);
    setError(null);
    setFollow(true);
    requestId.current ??= crypto.randomUUID();
    try {
      const next = await request<Snapshot>(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_kind: kind,
          filename: kind === 'file' ? file?.name : undefined,
          url: kind === 'youtube' ? url : undefined,
          language,
          client_request_id: requestId.current,
        }),
      });
      setSnapshot(next);
      if (kind === 'file' && file && next.status === 'awaiting_upload') {
        upload.current = new AbortController();
        await request<Snapshot>(`${base}/${next.operation_id}/source`, {
          method: 'PUT',
          body: file,
          signal: upload.current.signal,
        });
        upload.current = null;
      }
      requestId.current = null;
    } catch (failure) {
      if (!(failure instanceof DOMException && failure.name === 'AbortError'))
        setError(failure instanceof Error ? failure.message : 'Не удалось начать обработку');
    } finally {
      setSending(false);
    }
  }
  async function cancel() {
    if (!snapshot) return;
    try {
      await request<Snapshot>(`${base}/${snapshot.operation_id}/cancel`, { method: 'POST' });
      upload.current?.abort();
    } catch {
      setError('Не удалось отменить операцию. Проверьте подключение и повторите.');
    }
  }
  const pages = Math.max(1, Math.ceil((snapshot?.segments.length ?? 0) / 100));
  const currentPage = follow ? pages : Math.min(page, pages);
  const labels = new Map(snapshot?.speakers.map((speaker) => [speaker.id, speaker.label]));

  return (
    <Container size="lg" py="xl">
      <Stack gap="lg">
        <div>
          <Title order={1}>Транскрибация</Title>
          <Text c="dimmed">
            Аудио, видео и публичные записи YouTube. Распознавание и разделение по спикерам
            выполняются локально.
          </Text>
        </div>
        {error && (
          <Alert color="red" role="alert">
            {error}
          </Alert>
        )}
        {loading ? (
          <Loader aria-label="Загрузка состояния" />
        ) : (
          <Paper withBorder p="lg">
            <Stack>
              <Group grow align="start">
                <Select
                  label="Источник"
                  data={[
                    { value: 'file', label: 'Аудио или видео' },
                    { value: 'youtube', label: 'YouTube' },
                  ]}
                  value={kind}
                  onChange={(value) => {
                    setKind(value ?? 'file');
                    requestId.current = null;
                  }}
                  disabled={active || sending}
                />
                <Select
                  label="Язык"
                  data={[
                    { value: 'auto', label: 'Определить автоматически' },
                    { value: 'ru', label: 'Русский' },
                    { value: 'en', label: 'English' },
                  ]}
                  value={language}
                  onChange={(value) => {
                    setLanguage(value ?? 'auto');
                    requestId.current = null;
                  }}
                  disabled={active || sending}
                />
              </Group>
              <Text size="sm" c="dimmed">
                Русский — GigaAM-v3, английский — Whisper large-v3. В режиме авто модель выбирается
                после определения языка.
              </Text>
              {kind === 'file' ? (
                <FileInput
                  label="Аудио или видеофайл"
                  placeholder="Выберите файл"
                  accept="audio/*,video/*,.mkv,.m4a,.ogg,.flac"
                  value={file}
                  onChange={(value) => {
                    setFile(value);
                    requestId.current = null;
                  }}
                  disabled={active || sending}
                />
              ) : (
                <TextInput
                  label="Ссылка на публичное видео YouTube"
                  placeholder="https://www.youtube.com/watch?v=…"
                  value={url}
                  onChange={(event) => {
                    setUrl(event.currentTarget.value);
                    requestId.current = null;
                  }}
                  disabled={active || sending}
                />
              )}
              <Text size="sm" c="dimmed">
                При передаче файла держите вкладку открытой. После передачи обработка продолжится
                независимо от вкладки. При первом запуске потребуется скачивание моделей.
              </Text>
              <Group>
                <Button
                  onClick={start}
                  loading={sending}
                  disabled={active || (kind === 'file' ? !file : !url)}
                >
                  Начать транскрибацию
                </Button>
                {active && (
                  <Button
                    variant="outline"
                    color="red"
                    onClick={cancel}
                    disabled={snapshot?.status === 'cancelling'}
                  >
                    Отменить
                  </Button>
                )}
              </Group>
            </Stack>
          </Paper>
        )}
        {snapshot && (
          <>
            <Group>
              <Title order={2}>{snapshot.source.name ?? snapshot.source.url}</Title>
              <Badge>{statuses[snapshot.status]}</Badge>
            </Group>
            {!online && active && (
              <Alert color="yellow">
                Подключение потеряно. Восстанавливаем состояние; обработка на сервере продолжается.
              </Alert>
            )}
            {snapshot.error && (
              <Alert color="red" role="alert">
                {snapshot.error.message} ({snapshot.error.code})
              </Alert>
            )}
            <Paper withBorder p="lg">
              <Stack>
                {Object.entries(snapshot.stages).map(([name, stage]) => (
                  <div key={name}>
                    <Group justify="space-between">
                      <Text size="sm">
                        {stages[name]} · {phaseStates[stage.state]}
                      </Text>
                      {stage.state === 'running' && stage.total_units === null && (
                        <Loader size="xs" />
                      )}
                    </Group>
                    {stage.total_units !== null && stage.total_units > 0 && (
                      <Progress
                        aria-label={stages[name]}
                        value={Math.min(100, (stage.completed_units / stage.total_units) * 100)}
                        mt={4}
                      />
                    )}
                    {(stage.completed_units > 0 || stage.detail) && (
                      <Text size="xs" c="dimmed">
                        {stage.detail}{' '}
                        {stage.completed_units.toLocaleString(undefined, {
                          maximumFractionDigits: 1,
                        })}
                        {stage.total_units !== null
                          ? ` / ${stage.total_units.toLocaleString()}`
                          : ''}{' '}
                        {stage.unit === 'seconds'
                          ? 'сек.'
                          : stage.unit === 'bytes'
                            ? 'байт'
                            : stage.unit === 'batches'
                              ? 'пакетов'
                              : ''}
                      </Text>
                    )}
                  </div>
                ))}
              </Stack>
            </Paper>
            {isTerminal(snapshot) &&
              (!snapshot.completeness.asr || !snapshot.completeness.diarization) && (
                <Alert color="yellow">
                  Неполный результат:{' '}
                  {!snapshot.completeness.asr ? 'распознавание не завершено. ' : ''}
                  {!snapshot.completeness.diarization ? 'разметка спикеров не завершена.' : ''}
                </Alert>
              )}
            {Object.entries(snapshot.output_paths).map(([format, path]) => (
              <Text key={format} size="sm" style={{ overflowWrap: 'anywhere' }}>
                {format.toUpperCase()}: {path}
              </Text>
            ))}
            <Group justify="space-between">
              <Title order={2}>Распознанный текст</Title>
              <Button variant="subtle" onClick={() => setFollow(true)}>
                К последнему тексту
              </Button>
            </Group>
            {!snapshot.segments.length && (
              <Text c="dimmed">Текст появится после начала распознавания.</Text>
            )}
            <Stack gap="sm">
              {snapshot.segments
                .slice((currentPage - 1) * 100, currentPage * 100)
                .map((segment) => (
                  <Paper key={segment.id} withBorder p="md">
                    <Group gap="xs">
                      <Text size="xs" c="dimmed">
                        {time(segment.start)}
                      </Text>
                      <Text fw={600} size="sm">
                        {segment.speaker_id
                          ? labels.get(segment.speaker_id)
                          : segment.speaker_status === 'pending'
                            ? 'Спикер определяется'
                            : 'Неизвестный спикер'}
                      </Text>
                      {segment.overlap && <Badge color="orange">Одновременная речь</Badge>}
                    </Group>
                    <Text style={{ whiteSpace: 'pre-wrap' }}>{segment.text}</Text>
                  </Paper>
                ))}
            </Stack>
            {pages > 1 && (
              <Pagination
                total={pages}
                value={currentPage}
                onChange={(value) => {
                  setFollow(false);
                  setPage(value);
                }}
              />
            )}
          </>
        )}
      </Stack>
    </Container>
  );
}
