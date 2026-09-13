import { useEffect, useState } from 'react';
import { Paper, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import type { MetricSample, MetricValue } from '@daevox/core/client';
import { api, useCore } from './state';

function Chart({
  title,
  samples,
  measure,
  maximum,
}: {
  title: string;
  samples: MetricSample[];
  measure: (sample: MetricSample) => MetricValue | undefined;
  maximum: number;
}) {
  const end = samples.length ? Date.parse(samples[samples.length - 1].timestamp) : Date.now();
  const begin = Math.max(
    end - 3600_000,
    samples.length ? Date.parse(samples[0].timestamp) : end - 1000,
  );
  let previous = 0;
  const path = samples
    .map((sample) => {
      const metric = measure(sample);
      const time = Date.parse(sample.timestamp);
      if (metric?.availability !== 'available' || metric.value === null) {
        previous = 0;
        return '';
      }
      const move = !previous || time - previous > 1500;
      previous = time;
      return `${move ? 'M' : 'L'}${20 + ((time - begin) / Math.max(1000, end - begin)) * 560},${140 - Math.min(1, metric.value / Math.max(1, maximum)) * 120}`;
    })
    .join(' ');
  return (
    <Paper withBorder p="sm">
      <Text size="sm">{title}</Text>
      <svg
        role="img"
        aria-label={`${title}: история текущей сессии`}
        viewBox="0 0 600 180"
        style={{ width: '100%', display: 'block' }}
      >
        <line x1="20" y1="140" x2="580" y2="140" stroke="var(--mantine-color-default-border)" />
        <path d={path} fill="none" stroke="var(--mantine-color-blue-5)" strokeWidth="2" />
        <text x="20" y="166" fontSize="12" fill="currentColor">
          {new Date(begin).toLocaleTimeString()}
        </text>
        <text x="580" y="166" textAnchor="end" fontSize="12" fill="currentColor">
          {new Date(end).toLocaleTimeString()}
        </text>
      </svg>
    </Paper>
  );
}
export function SessionCharts() {
  const { metric, runtime } = useCore();
  const [samples, setSamples] = useState<MetricSample[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let closed = false;
    const load = async () => {
      try {
        const result = await api.metrics();
        if (!closed) {
          setSamples(result.samples.filter((sample) => sample.session_id === runtime?.session_id));
          setError('');
        }
      } catch (caught) {
        if (!closed) setError(String(caught));
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, [runtime?.session_id]);
  useEffect(() => {
    if (metric)
      setSamples((previous) =>
        [
          ...previous.filter(
            (sample) =>
              sample.session_id === metric.session_id && sample.timestamp < metric.timestamp,
          ),
          metric,
        ].slice(-3600),
      );
  }, [metric]);
  return (
    <Stack>
      <Title order={3}>Графики сессии</Title>
      <Text size="sm" c="dimmed">
        Сохранено в памяти core: {samples.length} измерений · до 60 минут. Разрывы обозначают
        недоступные измерения.
      </Text>
      {error && <Text c="orange">История недоступна: {error}</Text>}
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Chart title="CPU" samples={samples} measure={(sample) => sample.cpu.total} maximum={100} />
        <Chart
          title="RAM"
          samples={samples}
          measure={(sample) => sample.ram.used}
          maximum={metric?.ram.total.value ?? 1}
        />
        {metric?.gpus.map((gpu) => (
          <Chart
            key={gpu.id ?? gpu.nvml_index}
            title={`${gpu.name ?? 'GPU'} · нагрузка`}
            samples={samples}
            measure={(sample) => sample.gpus.find((item) => item.id === gpu.id)?.utilisation}
            maximum={100}
          />
        ))}
      </SimpleGrid>
      {metric?.inference && (
        <Text size="sm">
          Запросы сессии: {metric.inference.succeeded} успешных · {metric.inference.failed} ошибок ·{' '}
          {metric.inference.cancelled} отмен. Токены: {metric.inference.prompt_tokens} входящих /{' '}
          {metric.inference.completion_tokens} выходящих.
        </Text>
      )}
    </Stack>
  );
}
