import { useState } from 'react';
import { Anchor, Badge, Button, Group, Popover, Select, Stack, Text } from '@mantine/core';
import { api, phases, useCore } from './state';

export function HeaderStatus() {
  const { runtime, catalog, connected, refresh, metric, operations } = useCore();
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const chosen = selected ?? runtime?.last_selected_preset_id ?? catalog?.presets[0]?.id ?? null;
  const preset = catalog?.presets.find((item) => item.id === chosen);
  const measured = metric?.inference?.last_request;
  const fresh =
    measured?.instance_id === runtime?.active_instance?.id &&
    measured?.status === 'succeeded' &&
    Date.now() - Date.parse(measured.timestamp) < 60_000;
  const tps = fresh ? (measured?.tokens_per_second ?? null) : null;
  const operation = operations.find((op) => op.id === runtime?.current_operation_id);
  const busy = !!runtime?.current_operation_id;
  const command = async (action: () => Promise<unknown>) => {
    setPending(true);
    setError('');
    try {
      await action();
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  };
  return (
    <Popover width={320} position="bottom-end" withArrow shadow="md">
      <Popover.Target>
        <Button
          variant="default"
          size="compact-md"
          aria-label={`Модель: ${runtime?.active_instance?.preset_id ?? 'не загружена'}, ${connected && runtime ? phases[runtime.state] : 'нет связи'}`}
        >
          <Group gap="xs">
            <Badge
              size="xs"
              color={connected ? (runtime?.state === 'ready' ? 'teal' : 'gray') : 'orange'}
              circle
              aria-hidden
            >
              {' '}
            </Badge>
            <span>
              {connected
                ? (runtime?.active_instance?.preset_id ?? 'Модель не загружена')
                : 'Core недоступен'}
            </span>
            <Text component="span" size="xs" c="dimmed">
              {tps === null ? '—' : tps.toFixed(1)} tok/s ⌄
            </Text>
          </Group>
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="sm">
          <Text fw={600}>{runtime?.active_instance?.preset_id ?? 'Нет активной модели'}</Text>
          <Text size="sm" c="dimmed">
            {connected && runtime ? phases[runtime.state] : 'Связь с core потеряна'}
          </Text>
          <Text size="sm">Запросов в работе: {runtime?.inflight_requests ?? '—'}</Text>
          {tps !== null && measured && (
            <Text size="xs" c="dimmed">
              {measured.source} · {new Date(measured.timestamp).toLocaleTimeString()}
            </Text>
          )}
          {runtime?.target?.preset_id && <Text size="sm">Цель: {runtime.target.preset_id}</Text>}
          {runtime?.error && (
            <Text role="alert" c="red">
              {runtime.error.message}
            </Text>
          )}
          {runtime?.recovery.map((process) => (
            <Stack gap="xs" key={process.id}>
              <Text size="sm">
                PID {process.pid ?? '—'}: {process.reason}
              </Text>
              {process.allowed_actions.includes('stop') && (
                <Button
                  color="orange"
                  disabled={!connected || pending}
                  onClick={() => void command(() => api.stopRecovery(process.id))}
                >
                  Остановить остаточный процесс {process.pid}
                </Button>
              )}
            </Stack>
          ))}
          <Select
            label="Пресет для запуска"
            value={chosen}
            onChange={setSelected}
            data={
              [...new Set(catalog?.presets.map((item) => item.id))].map((id) => ({
                value: id,
                label: id,
              })) ?? []
            }
            disabled={!connected || busy || pending}
          />
          {preset?.applied_revision && preset.saved_revision !== preset.applied_revision && (
            <Text c="orange" size="sm">
              Есть неприменённые изменения пресета
            </Text>
          )}
          <Group grow>
            <Button
              disabled={!connected || pending || !preset?.can_launch || busy}
              onClick={() => {
                if (preset)
                  void command(() =>
                    api.switchPreset({
                      preset_id: preset.id,
                      preset_revision: preset.saved_revision,
                    }),
                  );
              }}
            >
              Запустить
            </Button>
            <Button
              variant="light"
              disabled={!connected || pending || !runtime?.active_instance || busy}
              onClick={() => void command(() => api.switchPreset({ preset_id: null }))}
            >
              Выгрузить
            </Button>
          </Group>
          {busy && runtime?.current_operation_id && (
            <Group>
              <Button
                disabled={!connected || pending || !operation?.allowed_actions.includes('cancel')}
                variant="light"
                onClick={() =>
                  void command(() => api.cancelOperation(runtime.current_operation_id!))
                }
              >
                Отменить
              </Button>
              {operation?.allowed_actions.includes('force') && (
                <Button
                  disabled={!connected || pending}
                  color="orange"
                  onClick={() =>
                    void command(() => api.forceOperation(runtime.current_operation_id!))
                  }
                >
                  Принудительно
                </Button>
              )}
            </Group>
          )}
          {error && (
            <Text role="alert" c="red" size="sm">
              {error}
            </Text>
          )}
          <Anchor href="/models?view=manage">Настройки модели</Anchor>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
