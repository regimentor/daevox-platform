import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Alert, Button, Container, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { VoiceSamples } from '../voiceover/VoiceSamples';
import { Player } from '../voiceover/Player';
import { stageLabels, statuses, type Voiceover } from '../voiceover/types';

const base = '/trancription-api';
type LibraryItem = {
  id: string;
  title: string;
  status: string;
  created_at: string;
  storage_bytes: number;
  duration: number | null;
};
const voices = ['aidar', 'baya', 'kseniya', 'xenia', 'eugene'];
async function request(path: string, options?: RequestInit) {
  const response = await fetch(base + path, options);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      error.detail?.message ||
        (typeof error.detail === 'string' ? error.detail : 'Не удалось выполнить запрос'),
    );
  }
  return response.status === 204 ? null : response.json();
}
const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export default function VoiceoverPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [record, setRecord] = useState<Voiceover | null>(null);
  const [activity, setActivity] = useState<{ kind: string; id: string; status: string } | null>(
    null,
  );
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const loadedMore = useRef(false);
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [connectionLost, setConnectionLost] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const creationKey = useRef<string | null>(null);
  const synthesisKey = useRef<string | null>(null);
  useEffect(() => {
    let live = true;
    setRecord(null);
    loadedMore.current = false;
    setItems([]);
    setNextCursor(null);
    setError('');
    setConnectionLost(false);
    const refresh = async () => {
      try {
        if (id) {
          const value = await request(`/voiceovers/${id}`);
          if (live)
            setRecord((previous) =>
              !previous || previous.id !== value.id || value.revision >= previous.revision
                ? value
                : previous,
            );
        } else {
          const [library, active] = await Promise.all([
            request('/voiceovers'),
            request('/activity'),
          ]);
          if (live) {
            setItems((previous) =>
              loadedMore.current && library.items.length
                ? [
                    ...library.items,
                    ...previous.filter(
                      (item) =>
                        item.created_at < library.items[library.items.length - 1].created_at &&
                        !library.items.some((fresh: LibraryItem) => fresh.id === item.id),
                    ),
                  ]
                : library.items,
            );
            if (!loadedMore.current) setNextCursor(library.next_cursor);
            setActivity(active);
          }
        }
      } catch (cause) {
        if (live) {
          setError(String(cause));
          setRecord(null);
        }
      }
    };
    void refresh();
    const events = id ? new EventSource(`${base}/voiceovers/${id}/events`) : null;
    if (events) {
      events.addEventListener('open', () => {
        if (live) setConnectionLost(false);
      });
      events.addEventListener('error', () => {
        if (live) setConnectionLost(true);
      });
      for (const kind of ['snapshot', 'progress', 'transcript', 'translation', 'state']) {
        events.addEventListener(kind, (event) => {
          if (!live) return;
          const value: Voiceover = JSON.parse((event as MessageEvent<string>).data);
          setRecord((previous) =>
            !previous || value.revision >= previous.revision ? value : previous,
          );
          setConnectionLost(false);
          if (['completed', 'incomplete', 'failed', 'delete_failed'].includes(value.status))
            events.close();
        });
      }
      events.addEventListener('deleted', () => {
        setRecord(null);
        setError('Запись удалена');
        events.close();
      });
    }
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => {
      live = false;
      events?.close();
      window.clearInterval(timer);
    };
  }, [id]);
  async function act(action: () => Promise<void>) {
    setPending(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(false);
    }
  }
  async function start() {
    creationKey.current ??= crypto.randomUUID();
    const value: Voiceover = await request(
      '/voiceovers',
      json({
        ...(file ? { source_kind: 'file', filename: file.name } : { source_kind: 'youtube', url }),
        client_request_id: creationKey.current,
      }),
    );
    if (file && value.status === 'awaiting_upload')
      await request(`/voiceovers/${value.id}/source`, { method: 'PUT', body: file });
    creationKey.current = null;
    navigate(`/voiceover/${value.id}`);
  }
  return (
    <Container size="xl" py="lg">
      <Stack>
        <Group justify="space-between">
          <Title order={1}>Перевод видео</Title>
          <Link to="/voiceover">Библиотека</Link>
        </Group>
        {connectionLost && (
          <Alert color="yellow">Связь с обработкой потеряна. Переподключаемся…</Alert>
        )}
        {error && (
          <Alert color="red" role="alert">
            {error}
          </Alert>
        )}
        {!id && (
          <>
            {activity && (
              <Alert color="blue">
                <Link
                  to={
                    activity.kind === 'voiceover' ? `/voiceover/${activity.id}` : '/transcription'
                  }
                >
                  {activity.kind === 'voiceover' ? 'Текущий перевод' : 'Текущая транскрибация'}
                </Link>
              </Alert>
            )}
            <Paper withBorder p="md">
              <Stack>
                <label>
                  Видеофайл{' '}
                  <input
                    type="file"
                    accept="video/*"
                    onChange={(event) => {
                      setFile(event.target.files?.[0] ?? null);
                      creationKey.current = null;
                    }}
                  />
                </label>
                <label>
                  Ссылка YouTube{' '}
                  <input
                    type="url"
                    value={url}
                    onChange={(event) => {
                      setUrl(event.target.value);
                      setFile(null);
                      creationKey.current = null;
                    }}
                  />
                </label>
                <Button
                  disabled={pending || !!activity || (!file && !url)}
                  onClick={() => void act(start)}
                >
                  Подготовить перевод
                </Button>
              </Stack>
            </Paper>
            {items.map((item) => (
              <Paper withBorder p="md" key={item.id}>
                <Link to={`/voiceover/${item.id}`}>{item.title}</Link>
                <Text>
                  {statuses[item.status]} · {(item.storage_bytes / 1024 / 1024).toFixed(1)} МБ
                  {item.duration ? ` · ${Math.round(item.duration)} с` : ''}
                </Text>
              </Paper>
            ))}
            {nextCursor && (
              <Button
                variant="default"
                disabled={pending}
                onClick={() =>
                  void act(async () => {
                    const page = await request(
                      `/voiceovers?cursor=${encodeURIComponent(nextCursor)}`,
                    );
                    loadedMore.current = true;
                    setItems((previous) => [
                      ...previous,
                      ...page.items.filter(
                        (item: LibraryItem) => !previous.some((p) => p.id === item.id),
                      ),
                    ]);
                    setNextCursor(page.next_cursor);
                  })
                }
              >
                Показать ещё
              </Button>
            )}
          </>
        )}
        {record && (
          <>
            <Title order={2}>{record.source.name || 'YouTube'}</Title>
            <Text role="status">{statuses[record.status] || record.status}</Text>
            {record.error && <Alert color="red">{record.error.message}</Alert>}
            {Object.entries(record.stages)
              .filter(([, stage]) => stage.state === 'running')
              .map(([name, stage]) => (
                <Text key={name}>
                  {stageLabels[name] || 'Обработка'}: {stage.completed_units}{' '}
                  {stage.total_units ? `/ ${stage.total_units}` : ''} {stage.unit}
                </Text>
              ))}
            {record.status === 'awaiting_voices' && (
              <Paper withBorder p="md">
                <Stack>
                  <VoiceSamples
                    voices={record.available_voices?.length ? record.available_voices : voices}
                  />
                  {Object.entries(record.voice_assignments).map(([speaker, voice]) => (
                    <label key={speaker}>
                      {record.speakers.find((item) => item.id === speaker)?.label ||
                        'Неизвестный спикер'}
                      <select
                        value={voice}
                        disabled={pending}
                        onChange={(event) =>
                          void act(async () => {
                            setRecord(
                              await request(
                                `/voiceovers/${record.id}/voices`,
                                json(
                                  {
                                    expected_revision: record.revision,
                                    voice_assignments: {
                                      ...record.voice_assignments,
                                      [speaker]: event.target.value,
                                    },
                                  },
                                  'PUT',
                                ),
                              ),
                            );
                          })
                        }
                      >
                        {(record.available_voices?.length ? record.available_voices : voices).map(
                          (value) => (
                            <option key={value}>{value}</option>
                          ),
                        )}
                      </select>
                    </label>
                  ))}
                  <Button
                    disabled={pending}
                    onClick={() =>
                      void act(async () => {
                        synthesisKey.current ??= crypto.randomUUID();
                        setRecord(
                          await request(
                            `/voiceovers/${record.id}/synthesize`,
                            json({
                              expected_revision: record.revision,
                              client_request_id: synthesisKey.current,
                            }),
                          ),
                        );
                      })
                    }
                  >
                    Начать озвучку
                  </Button>
                </Stack>
              </Paper>
            )}
            {record.assets.video && <Player record={record} />}
            {!record.assets.video &&
              record.transcript.map((phrase) => (
                <Paper key={phrase.id} withBorder p="sm">
                  <Text size="sm">
                    {phrase.start.toFixed(1)} с ·{' '}
                    {record.speakers.find((s) => s.id === phrase.speaker_id)?.label ||
                      'Неизвестный спикер'}
                  </Text>
                  <Text>{phrase.text}</Text>
                  <Text>
                    {
                      record.translations.find((t) => t.source_segment_ids.includes(phrase.id))
                        ?.text
                    }
                  </Text>
                </Paper>
              ))}
            <Button
              color="red"
              variant="outline"
              disabled={pending}
              onClick={() =>
                void act(async () => {
                  await request(`/voiceovers/${record.id}`, { method: 'DELETE' });
                  navigate('/voiceover');
                })
              }
            >
              {['completed', 'incomplete', 'failed', 'delete_failed'].includes(record.status)
                ? 'Удалить'
                : 'Отменить'}
            </Button>
          </>
        )}
      </Stack>
    </Container>
  );
}
