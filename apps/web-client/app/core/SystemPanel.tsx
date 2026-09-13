import { useEffect, useState } from 'react';
import { Button, Group, Paper, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import type { MetricValue, Settings } from '@daevox/core/client';
import { api, useCore } from './state';
import { SessionCharts } from './SessionCharts';
export function Measurement({ label, metric }: { label: string; metric: MetricValue | undefined }) {
  const available = metric?.availability === 'available' && metric.value !== null;
  const value = available
    ? metric.unit === 'bytes'
      ? `${(metric.value! / 2 ** 30).toFixed(2)} ГиБ`
      : `${metric.value!.toFixed(1)} ${metric.unit}`
    : 'Нет измерения';
  return (
    <div>
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text title={metric?.reason ?? metric?.sampled_at}>{value}</Text>
      {!available && metric?.reason && (
        <Text size="xs" c="dimmed">
          {metric.reason}
        </Text>
      )}
    </div>
  );
}
export function SystemPanel() {
  const { connected, metric } = useCore();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [drain, setDrain] = useState('');
  const [jobs, setJobs] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const load = async () => {
    try {
      const loaded = await api.settings();
      setSettings(loaded);
      setDrain(String(loaded.drain_timeout_ms));
      setJobs(String(loaded.compiler_jobs));
    } catch (caught) {
      setMessage(String(caught));
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const save = async () => {
    if (!settings) return;
    setPending(true);
    setMessage('');
    try {
      setSettings(
        await api.saveSettings({
          ...settings,
          drain_timeout_ms: Number(drain),
          compiler_jobs: Number(jobs),
        }),
      );
      setMessage('Настройки сохранены');
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  };
  return (
    <Stack gap="lg">
      <Title order={3}>Настройки core</Title>
      <Group align="end">
        <TextInput
          type="number"
          min={1}
          step={1}
          label="Ожидание запросов, мс"
          value={drain}
          onChange={(event) => setDrain(event.currentTarget.value)}
        />
        <TextInput
          type="number"
          min={1}
          step={1}
          label="Потоки компилятора"
          value={jobs}
          onChange={(event) => setJobs(event.currentTarget.value)}
        />
      </Group>
      <Group className="cp-action-bar">
        <Button
          disabled={
            !settings ||
            !connected ||
            pending ||
            !Number.isInteger(Number(drain)) ||
            Number(drain) <= 0 ||
            !Number.isInteger(Number(jobs)) ||
            Number(jobs) <= 0
          }
          onClick={() => void save()}
        >
          Сохранить настройки
        </Button>
        <Button variant="default" disabled={!connected || pending} onClick={() => void load()}>
          Перечитать настройки
        </Button>
      </Group>
      {message && <Text role="status">{message}</Text>}
      <SessionCharts />
      <Title order={3}>CPU и память</Title>
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Measurement label="CPU" metric={metric?.cpu.total} />
        <Measurement label="RAM" metric={metric?.ram.used} />
        <Measurement label="Всего RAM" metric={metric?.ram.total} />
        <Measurement label="Swap" metric={metric?.ram.swap_used} />
      </SimpleGrid>
      <details>
        <summary>Логические ядра и температуры</summary>
        <SimpleGrid cols={{ base: 2, md: 6 }}>
          {metric?.cpu.logical.map((cpu) => (
            <Paper withBorder p="xs" key={cpu.name}>
              <Measurement label={cpu.name} metric={cpu.usage} />
              <Measurement label="Частота" metric={cpu.frequency} />
            </Paper>
          ))}
        </SimpleGrid>
        <Group>
          {metric?.cpu.temperatures.map((sensor) => (
            <Measurement key={sensor.name} label={sensor.name} metric={sensor.temperature} />
          ))}
        </Group>
      </details>
      {metric?.gpus.map((gpu) => (
        <Paper withBorder p="md" radius="md" key={gpu.uuid ?? gpu.nvml_index}>
          <Title order={4}>{gpu.name ?? 'GPU'}</Title>
          <Text size="xs" c="dimmed">
            {gpu.uuid} · PCI {gpu.pci ?? '—'} · CUDA {gpu.cuda_index ?? 'не сопоставлен'}
          </Text>
          <SimpleGrid mt="md" cols={{ base: 2, md: 6 }}>
            <Measurement label="Нагрузка GPU" metric={gpu.utilisation} />
            <Measurement label="VRAM" metric={gpu.vram_used} />
            <Measurement label="Всего VRAM" metric={gpu.vram_total} />
            <Measurement label="Температура" metric={gpu.temperature} />
            <Measurement label="Мощность" metric={gpu.power} />
            <Measurement label="Вентилятор" metric={gpu.fan} />
          </SimpleGrid>
        </Paper>
      ))}
      <details>
        <summary>Процессы core</summary>
        <Stack mt="sm">
          {metric?.processes?.map((process) => (
            <Paper key={process.pid} withBorder p="sm">
              <Text fw={600}>
                PID {process.pid} ·{' '}
                {process.role === 'core' ? 'Core' : 'Собственный дочерний процесс'}
              </Text>
              <Group mt="xs">
                <Measurement label="CPU процесса" metric={process.cpu} />
                <Measurement label="RAM процесса" metric={process.ram} />
                {process.gpu_memory.map((gpu) => (
                  <Measurement key={gpu.gpu_id} label={`VRAM ${gpu.gpu_id}`} metric={gpu.memory} />
                ))}
              </Group>
            </Paper>
          ))}
        </Stack>
      </details>
      <Text size="xs" c="dimmed">
        Измерение: {metric?.timestamp ?? 'ожидание'} · Сбор продолжается при закрытой вкладке.
      </Text>
    </Stack>
  );
}
