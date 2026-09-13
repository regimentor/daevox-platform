import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import type { HubFiles, HubModels, ModelReferences, ModelSet } from '@daevox/core/client';
import { DownloadControls } from './DownloadControls';
import { api, useCore } from './state';
export function Library() {
  const { connected, refresh, operations } = useCore();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'local' | 'hub'>('local');
  const [query, setQuery] = useState('');
  const [sets, setSets] = useState<ModelSet[]>([]);
  const [results, setResults] = useState<HubModels | null>(null);
  const [files, setFiles] = useState<HubFiles | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [deletion, setDeletion] = useState<ModelReferences | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let closed = false;
    const load = async () => {
      try {
        const result = await api.modelSets();
        if (!closed) setSets(result.model_sets);
      } catch (caught) {
        if (!closed) setError(String(caught));
      }
    };
    void load();
    const timer = setInterval(() => void load(), 500);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, []);
  const command = async (action: () => Promise<void>) => {
    setPending(true);
    setError('');
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  };
  const search = (cursor?: string) =>
    command(async () => {
      const result = await api.hubModels({ q: query, cursor });
      setResults(
        cursor && results ? { ...result, models: [...results.models, ...result.models] } : result,
      );
    });
  const choose = (repo: string) =>
    command(async () => {
      setFiles(await api.hubFiles({ repo }));
      setSelected([]);
    });
  const download = () =>
    command(async () => {
      if (!files) return;
      await api.download({
        repo_id: files.repo_id,
        commit: files.commit,
        files: files.files
          .filter((file) => selected.includes(file.path))
          .map((file) => ({ path: file.path, role: file.role })),
      });
      setTab('local');
      setQuery('');
    });
  const createPreset = (set: ModelSet) =>
    command(async () => {
      const weights = set.files
        .filter((file) => file.role !== 'projector')
        .toSorted((a, b) => a.path.localeCompare(b.path))[0];
      if (!weights) throw new Error('В комплекте нет весов');
      const name = `${set.repo_id
        .split('/')
        .at(-1)!
        .replace(/[^a-zA-Z0-9_-]/g, '_')}-${set.id.slice(0, 8)}`;
      const projector = set.files.find((file) => file.role === 'projector');
      const source = await api.createSource({
        name: `${name}.ini`,
        text: `; ${set.repo_id} @ ${set.commit}\n[*]\nmodel = ../data/models/${weights.local_path}\n${projector ? `mmproj = ../data/models/${projector.local_path}\n` : ''}\n[${name}]\nctx-size = 4096\n`,
      });
      await refresh();
      navigate(`/models?view=manage&file=${encodeURIComponent(source.id)}`);
    });
  const chosen = files?.files.filter((file) => selected.includes(file.path)) ?? [];
  const total = chosen.every((file) => file.size_bytes !== null)
    ? chosen.reduce((sum, file) => sum + file.size_bytes!, 0)
    : null;
  return (
    <Paper withBorder p="lg" radius="md" mt="lg">
      <Stack>
        <Group justify="space-between">
          <Title order={3}>Каталог моделей</Title>
          <Group>
            <Button variant={tab === 'local' ? 'filled' : 'subtle'} onClick={() => setTab('local')}>
              Локальные
            </Button>
            <Button variant={tab === 'hub' ? 'filled' : 'subtle'} onClick={() => setTab('hub')}>
              Hugging Face
            </Button>
          </Group>
        </Group>
        <Group align="end">
          <TextInput
            label="Поиск моделей"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && tab === 'hub') void search();
            }}
            style={{ flex: 1 }}
          />
          {tab === 'hub' && (
            <Button disabled={!connected || pending} onClick={() => void search()}>
              Найти
            </Button>
          )}
        </Group>
        {tab === 'hub' ? (
          <>
            {results?.models.map((model) => (
              <Paper withBorder p="md" key={model.id}>
                <Button
                  variant="subtle"
                  disabled={pending || !connected}
                  onClick={() => void choose(model.id)}
                >
                  {model.id}
                </Button>
                <Text size="xs" c="dimmed">
                  Публичный GGUF · загрузок {model.downloads ?? '—'}
                </Text>
              </Paper>
            ))}
            {results?.cursor && (
              <Button
                variant="light"
                disabled={pending || !connected}
                onClick={() => void search(results.cursor!)}
              >
                Ещё результаты
              </Button>
            )}
            {files && (
              <Paper withBorder p="md">
                <Title order={4}>{files.repo_id}</Title>
                <Text size="xs" c="dimmed">
                  Commit: {files.commit}
                </Text>
                <Stack my="md">
                  {files.files.map((file) => (
                    <Checkbox
                      key={file.path}
                      label={`${file.path} · ${file.role} · ${file.size_bytes === null ? 'размер неизвестен' : `${file.size_bytes} байт`}`}
                      checked={selected.includes(file.path)}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        setSelected((current) =>
                          checked
                            ? [...current, file.path]
                            : current.filter((path) => path !== file.path),
                        );
                      }}
                    />
                  ))}
                </Stack>
                <Group className="cp-action-bar">
                  <Text size="sm">
                    {total === null ? 'Общий размер неизвестен' : `${total} байт`}
                  </Text>
                  <Button
                    disabled={
                      !connected ||
                      pending ||
                      chosen.length === 0 ||
                      !chosen.some((file) => file.role !== 'projector')
                    }
                    onClick={() => void download()}
                  >
                    Скачать выбранные файлы
                  </Button>
                </Group>
              </Paper>
            )}
          </>
        ) : (
          <>
            {sets.length === 0 && (
              <Text c="dimmed">Локальных комплектов пока нет. Найдите модель в Hugging Face.</Text>
            )}
            {sets
              .filter((set) => set.repo_id.toLowerCase().includes(query.toLowerCase()))
              .map((set) => (
                <Paper withBorder p="md" radius="md" key={set.id}>
                  <Group justify="space-between">
                    <Title order={4}>{set.repo_id}</Title>
                    <Badge color={set.availability === 'available' ? 'teal' : 'gray'}>
                      {set.availability === 'available'
                        ? 'Доступна локально'
                        : set.availability === 'missing'
                          ? 'Файлы отсутствуют'
                          : set.availability === 'failed'
                            ? 'Ошибка'
                            : 'Скачивается'}
                    </Badge>
                  </Group>
                  <Text size="xs" c="dimmed">
                    Commit: {set.commit}
                  </Text>
                  <Stack gap={4} my="sm">
                    {set.files.map((file) => (
                      <Text size="sm" key={file.id}>
                        {file.path} · {file.role} · {file.downloaded_bytes} /{' '}
                        {file.size_bytes ?? '—'} байт
                      </Text>
                    ))}
                  </Stack>
                  <>
                    {operations
                      .filter((operation) => operation.id === set.download_operation_id)
                      .map((operation) => (
                        <DownloadControls
                          key={operation.id}
                          operation={operation}
                          files={set.files}
                        />
                      ))}
                  </>
                  <Text size="sm">Пресеты: {set.preset_ids.join(', ') || 'не созданы'}</Text>
                  <Group mt="sm">
                    <Button
                      disabled={!connected || pending || set.availability !== 'available'}
                      onClick={() => void createPreset(set)}
                    >
                      Создать INI
                    </Button>
                    <Button
                      variant="light"
                      color="red"
                      disabled={!connected || pending}
                      onClick={() =>
                        void command(async () => setDeletion(await api.modelReferences(set.id)))
                      }
                    >
                      Удалить комплект
                    </Button>
                  </Group>
                </Paper>
              ))}
          </>
        )}
        <Modal
          opened={deletion !== null}
          onClose={() => {
            if (!pending) setDeletion(null);
          }}
          title="Удаление комплекта"
        >
          <Stack>
            <Text>
              Связанные пресеты: {deletion?.preset_ids.join(', ') || 'нет'}. Исходники останутся;
              отсутствующие файлы нужно будет восстановить.
            </Text>
            <Text size="sm">
              Удаляемых файлов: {deletion?.files.filter((file) => file.will_delete).length}. Общие
              файлы других комплектов сохранятся.
            </Text>
            <Button
              color="red"
              disabled={!connected || pending}
              onClick={() =>
                void command(async () => {
                  if (!deletion) return;
                  await api.deleteModelSet(deletion.model_set_id, { revision: deletion.revision });
                  setSets((current) => current.filter((set) => set.id !== deletion.model_set_id));
                  setDeletion(null);
                  await refresh();
                })
              }
            >
              Подтвердить удаление комплекта
            </Button>
            {error && (
              <Text role="alert" c="red">
                {error}
              </Text>
            )}
          </Stack>
        </Modal>
        {error && (
          <Text role="alert" c="red">
            {error}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}
