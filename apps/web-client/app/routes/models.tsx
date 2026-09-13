import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  Anchor,
  Badge,
  Button,
  Group,
  Modal,
  Paper,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { CoreApiError, type PresetSource } from '@daevox/core/client';
import { api, phases, useCore } from '../core/state';
import './models.css';
import { LogsPanel } from '../core/LogsPanel';
import { Library } from '../core/Library';
import { BuildPanel } from '../core/BuildPanel';
import { SystemPanel } from '../core/SystemPanel';

export default function Models() {
  const [section, setSection] = useState('presets');
  const [params] = useSearchParams();
  const management = params.get('view') === 'manage';
  const { runtime, metric, connected, gap } = useCore();
  return (
    <div className="cp-page">
      <Group justify="space-between" mb="lg">
        <Title order={1}>{management ? 'Управление моделями' : 'Модели LLM'}</Title>
        <Anchor component={Link} to={management ? '/models' : '/models?view=manage'}>
          {management ? 'Библиотека моделей' : 'Управление'}
        </Anchor>
      </Group>
      {!connected && (
        <Text role="status" c="orange">
          Связь с core потеряна. Действия недоступны.
        </Text>
      )}
      {gap && (
        <Text c="orange" size="sm">
          В потоке событий есть пропуск. Состояние перечитано из core.
        </Text>
      )}
      <div className="cp-overview">
        <Paper withBorder p="lg" radius="md">
          <Text size="xs" c="dimmed">
            АКТИВНАЯ МОДЕЛЬ
          </Text>
          <Title order={3}>{runtime?.active_instance?.preset_id ?? 'Модель не загружена'}</Title>
          <Badge mt="sm">{runtime ? phases[runtime.state] : 'Подключение'}</Badge>
          <Text mt="sm" size="sm">
            Запросов в работе: {runtime?.inflight_requests ?? '—'}
          </Text>
          <Text size="sm" c="dimmed">
            Выбор и запуск пресета — в панели модели в шапке.
          </Text>
        </Paper>
        <Paper withBorder p="lg" radius="md">
          <Text size="xs" c="dimmed">
            ЭТА МАШИНА
          </Text>
          <Title order={3}>
            {metric
              ? `${metric.gpus.length} GPU · ${metric.cpu.logical.length} потоков`
              : 'Ожидание измерений'}
          </Title>
          <Text mt="sm">{metric?.gpus.map((g) => g.name ?? g.uuid).join(' / ')}</Text>
          <Text size="sm" c="dimmed">
            {metric?.ram.total.value === undefined || metric.ram.total.value === null
              ? 'RAM: нет измерения'
              : `${(metric.ram.total.value / 2 ** 30).toFixed(1)} ГиБ RAM`}
          </Text>
        </Paper>
      </div>
      {!management ? (
        <Library />
      ) : (
        <>
          <nav className="cp-nav">
            {[
              ['presets', 'Пресеты'],
              ['system', 'Система'],
              ['builds', 'Сборки'],
              ['logs', 'Логи'],
            ].map(([id, name]) => (
              <button
                key={id}
                className={section === id ? 'selected' : ''}
                type="button"
                onClick={() => setSection(id)}
              >
                {name}
              </button>
            ))}
          </nav>
          <Paper withBorder p="lg" radius="md">
            {section === 'system' ? (
              <SystemPanel />
            ) : section === 'builds' ? (
              <BuildPanel />
            ) : section === 'logs' ? (
              <LogsPanel />
            ) : (
              <PresetEditor />
            )}
          </Paper>
        </>
      )}
    </div>
  );
}
function PresetEditor() {
  const { catalog, connected, refresh } = useCore();
  const [params] = useSearchParams();
  const fileId = params.get('file');
  const [source, setSource] = useState<PresetSource | null>(null);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const load = async (id: string) => {
    try {
      const file = await api.source(id);
      setSource(file);
      setName(file.name);
      setText(file.text);
      setEditing(true);
      setConflict(false);
      setError('');
    } catch (caught) {
      setError(String(caught));
    }
  };
  useEffect(() => {
    if (fileId) void load(fileId);
  }, [fileId]);
  const save = async (overwrite = false) => {
    setPending(true);
    setError('');
    try {
      const saved = source
        ? await api.saveSource(source.id, { text, base_revision: source.revision, overwrite })
        : await api.createSource({ name, text });
      setSource(saved);
      setText(saved.text);
      setConflict(false);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      if (caught instanceof CoreApiError && caught.status === 412) setConflict(true);
    } finally {
      setPending(false);
    }
  };
  return (
    <Stack>
      <Group justify="space-between">
        <Title order={3}>Исходные INI</Title>
        <Button
          disabled={!connected || pending}
          onClick={() => {
            setSource(null);
            setName('');
            setText('');
            setEditing(true);
            setConflict(false);
            setError('');
          }}
        >
          Новый INI
        </Button>
      </Group>
      <Select
        label="Исходный файл"
        data={catalog?.files.map((file) => ({ value: file.id, label: file.name })) ?? []}
        value={source?.id ?? null}
        onChange={(id) => {
          if (id) void load(id);
        }}
      />
      {editing && (
        <>
          <TextInput
            label="Имя файла"
            value={name}
            disabled={source !== null}
            onChange={(event) => setName(event.currentTarget.value)}
          />
          <Textarea
            label="Исходный INI"
            autosize
            minRows={14}
            value={text}
            onChange={(event) => setText(event.currentTarget.value)}
            styles={{ input: { fontFamily: 'monospace' } }}
          />
          <Group className="cp-action-bar">
            <Button disabled={!connected || pending || !name} onClick={() => void save()}>
              Сохранить
            </Button>
            {source && (
              <Button
                variant="default"
                disabled={pending || !connected}
                onClick={() => void load(source.id)}
              >
                Перечитать
              </Button>
            )}
            {source && (
              <Button
                variant="light"
                color="red"
                disabled={!connected || pending}
                onClick={() => setDeleting(true)}
              >
                Удалить INI
              </Button>
            )}
          </Group>
          <Modal
            opened={deleting}
            onClose={() => {
              if (!pending) setDeleting(false);
            }}
            title="Удаление исходника"
          >
            <Stack>
              <Text>
                Удалить {source?.name}? Уже запущенная модель продолжит работать с применённой
                версией.
              </Text>
              <Button
                color="red"
                disabled={!connected || pending}
                onClick={() => {
                  if (!source) return;
                  setPending(true);
                  void api
                    .deleteSource(source.id, { revision: source.revision })
                    .then(async () => {
                      setDeleting(false);
                      setSource(null);
                      setEditing(false);
                      setText('');
                      setName('');
                      await refresh();
                    })
                    .catch((caught) =>
                      setError(caught instanceof Error ? caught.message : String(caught)),
                    )
                    .finally(() => setPending(false));
                }}
              >
                Подтвердить удаление INI
              </Button>
              {error && (
                <Text role="alert" c="red">
                  {error}
                </Text>
              )}
            </Stack>
          </Modal>
          {conflict && (
            <Paper withBorder p="sm">
              <Text>Файл изменён. Можно перечитать его или явно заменить своим черновиком.</Text>
              <Button
                color="orange"
                disabled={pending || !connected}
                onClick={() => void save(true)}
              >
                Заменить моей версией
              </Button>
            </Paper>
          )}
          {source?.diagnostics.map((diagnostic, index) => (
            <Text
              key={`${diagnostic.code}-${index}`}
              c={diagnostic.severity === 'error' ? 'red' : 'orange'}
            >
              {diagnostic.message}
            </Text>
          ))}
        </>
      )}
      {error && (
        <Text role="alert" c="red">
          {error}
        </Text>
      )}
    </Stack>
  );
}
