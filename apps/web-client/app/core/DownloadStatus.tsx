import { Anchor, Button, Group, Loader, Popover, RingProgress, Stack, Text } from '@mantine/core';
import { DownloadControls } from './DownloadControls';
import { useCore } from './state';
export function DownloadStatus() {
  const { operations, modelSets } = useCore();
  const downloads = operations.filter(
    (operation) =>
      operation.type === 'download' &&
      !['succeeded', 'cancelled', 'interrupted'].includes(operation.status),
  );
  const operation = downloads.find((item) => item.status === 'running') ?? downloads[0];
  if (!operation) return null;
  const percent = operation.progress?.percent ?? null;
  const set = modelSets.find((item) => item.id === operation.resource_id);
  const label = set
    ? `${set.repo_id} · ${set.files.find((file) => file.role !== 'projector')?.path ?? ''}`
    : 'Hugging Face';
  return (
    <Popover width={340} position="bottom-end" withArrow shadow="md">
      <Popover.Target>
        <Button
          variant="default"
          size="compact-md"
          aria-label={`Скачивание HF: ${operation.status}`}
        >
          <Group gap={4}>
            <Text component="span" size="sm" maw={180} truncate title={label}>
              {label}
            </Text>
            {percent === null ? (
              <Loader size={16} />
            ) : (
              <RingProgress
                size={30}
                thickness={3}
                label={
                  <Text ta="center" fz={8}>
                    {percent.toFixed(0)}%
                  </Text>
                }
                sections={[
                  { value: percent, color: operation.status === 'paused' ? 'orange' : 'blue' },
                ]}
              />
            )}
            <Text component="span" size="xs">
              ⌄
            </Text>
          </Group>
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack>
          <Text fw={600}>{label}</Text>
          <DownloadControls operation={operation} />
          <Anchor href="/models">Открыть библиотеку</Anchor>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
