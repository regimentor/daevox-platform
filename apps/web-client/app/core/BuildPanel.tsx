import { useEffect, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Checkbox,
  Group,
  Paper,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import type { Build, LogEntry, Operation } from '@daevox/core/client';
import { api, useCore } from './state';
const statusNames: Record<Build['status'], string> = {
  building: 'Собирается',
  ready: 'Готова к применению',
  failed: 'Ошибка сборки',
  cancelled: 'Отменена',
  interrupted: 'Прервана',
};
export function BuildPanel() {
  const { runtime, connected, refresh } = useCore();
  const [builds, setBuilds] = useState<Build[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [profile, setProfile] = useState<'cuda' | 'cpu'>('cuda');
  const [jobs, setJobs] = useState('8');
  const [clean, setClean] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [follow, setFollow] = useState(true);
  const consoleRef = useRef<HTMLPreElement>(null);
  const load = async () => {
    const [buildResult, operationResult, logResult] = await Promise.all([
      api.builds(),
      api.operations(),
      api.logs({ source: 'build' }),
    ]);
    setBuilds(buildResult.builds);
    setOperations(operationResult.operations);
    setLogs(logResult.entries);
  };
  useEffect(() => {
    let closed = false;
    const tick = async () => {
      try {
        if (!closed) await load();
      } catch (caught) {
        if (!closed) setError(String(caught));
      }
    };
    void tick();
    void api.settings().then((settings) => {
      if (!closed) setJobs(String(settings.compiler_jobs));
    });
    const timer = setInterval(() => void tick(), 500);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (follow && consoleRef.current)
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
  }, [logs, follow]);
  const command = async (action: () => Promise<unknown>) => {
    setPending(true);
    setError('');
    try {
      await action();
      await load();
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  };
  const building = operations.find(
    (operation) => operation.type === 'build' && operation.status === 'running',
  );
  return (
    <Stack>
      <Title order={3}>Сборки llama.cpp</Title>
      <Group align="end">
        <Select
          label="Профиль сборки"
          value={profile}
          data={[
            { value: 'cuda', label: 'CUDA + CPU' },
            { value: 'cpu', label: 'Только CPU' },
          ]}
          onChange={(value) => setProfile(value === 'cpu' ? 'cpu' : 'cuda')}
        />
        <TextInput
          type="number"
          min={1}
          step={1}
          label="Compiler jobs"
          value={jobs}
          onChange={(event) => setJobs(event.currentTarget.value)}
        />
        <Checkbox
          label="Чистая пересборка"
          checked={clean}
          onChange={(event) => setClean(event.currentTarget.checked)}
        />
      </Group>
      <Group className="cp-action-bar">
        <Button
          disabled={
            !connected ||
            pending ||
            !!building ||
            !Number.isInteger(Number(jobs)) ||
            Number(jobs) <= 0
          }
          onClick={() =>
            void command(() => api.createBuild({ profile, jobs: Number(jobs), clean }))
          }
        >
          Собрать
        </Button>
        {building && (
          <>
            <Text>{building.phase}</Text>
            <Button
              variant="light"
              disabled={!connected || pending}
              onClick={() => void command(() => api.cancelOperation(building.id))}
            >
              Отменить сборку
            </Button>
          </>
        )}
      </Group>
      {builds.map((build) => (
        <Paper withBorder p="md" radius="md" key={build.id}>
          <Group justify="space-between">
            <Text fw={600}>
              {build.profile.toUpperCase()} · {build.id.slice(0, 8)}
            </Text>
            <Badge color={build.status === 'ready' ? 'teal' : 'gray'}>
              {build.current
                ? 'Текущая сборка'
                : build.previous
                  ? 'Предыдущая сборка'
                  : statusNames[build.status]}
            </Badge>
          </Group>
          <Text size="xs" c="dimmed">
            Commit: {build.commit ?? 'проверяется'}
          </Text>
          <Text size="sm">
            Inference:{' '}
            {Array.isArray(build.checks)
              ? 'не проверен'
              : build.checks.inference === 'not_checked'
                ? 'не проверен'
                : build.checks.inference}
          </Text>
          {!Array.isArray(build.checks) && build.checks.driver_compatibility === 'failed' && (
            <Text c="red">
              Проверка совместимости драйвера не пройдена: {build.checks.compatibility_error}
            </Text>
          )}
          <Group mt="sm">
            <Button
              size="xs"
              disabled={
                !connected ||
                pending ||
                build.status !== 'ready' ||
                (!Array.isArray(build.checks) && build.checks.driver_compatibility === 'failed') ||
                build.current ||
                !!runtime?.current_operation_id ||
                runtime?.state === 'recovery_required'
              }
              onClick={() => void command(() => api.applyBuild(build.id))}
            >
              {build.previous ? 'Вернуться к сборке' : 'Применить'}
            </Button>
            <Button
              size="xs"
              color="red"
              variant="subtle"
              disabled={
                !connected ||
                pending ||
                build.current ||
                build.previous ||
                build.status === 'building'
              }
              onClick={() => void command(() => api.deleteBuild(build.id))}
            >
              Удалить сборку
            </Button>
          </Group>
          {operations
            .filter((operation) => operation.resource_id === build.id && operation.error)
            .map((operation) => (
              <Text key={operation.id} c="red" size="sm">
                {operation.error?.message}
              </Text>
            ))}
          <details>
            <summary>Fingerprint и проверки</summary>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {JSON.stringify(
                {
                  fingerprint: build.fingerprint,
                  configuration: build.configuration,
                  checks: build.checks,
                },
                null,
                2,
              )}
            </pre>
          </details>
        </Paper>
      ))}
      <Group justify="space-between">
        <Title order={4}>Журнал сборки</Title>
        <Checkbox
          label="Автопрокрутка"
          checked={follow}
          onChange={(event) => setFollow(event.currentTarget.checked)}
        />
      </Group>
      <pre
        ref={consoleRef}
        aria-label="Журнал сборки"
        style={{
          maxHeight: 320,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          background: 'light-dark(#f5f6f8,#12171d)',
          padding: 16,
        }}
      >
        {logs
          .map(
            (entry) => `${entry.timestamp} ${entry.message}${entry.truncated ? ' [фрагмент]' : ''}`,
          )
          .join('\n') || 'Записей пока нет'}
      </pre>
      {error && (
        <Text role="alert" c="red">
          {error}
        </Text>
      )}
    </Stack>
  );
}
