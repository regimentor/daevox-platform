import {
  ActionIcon,
  Anchor,
  Group,
  Text,
  useComputedColorScheme,
  useMantineColorScheme,
} from '@mantine/core';

import { useMounted } from '@mantine/hooks';

import classes from './AppHeader.module.css';

export function AppHeader() {
  const computedColorScheme = useComputedColorScheme('light');
  const mounted = useMounted();
  const colorScheme = mounted ? computedColorScheme : 'light';
  const { setColorScheme } = useMantineColorScheme();
  const nextColorScheme = colorScheme === 'light' ? 'dark' : 'light';

  return (
    <Group className={classes.header} justify="space-between" px="md">
      <Text fw={700} size="lg">
        Daevox
      </Text>
      <Group>
        <Anchor href="/telegram">Telegram</Anchor>
        <Anchor href="/transcription">Транскрибация</Anchor>
        <Anchor href="/voiceover">Перевод видео</Anchor>
      </Group>
      <ActionIcon
        aria-label={`Switch to ${nextColorScheme} theme`}
        onClick={() => setColorScheme(nextColorScheme)}
        size="lg"
        variant="default"
      >
        <span aria-hidden="true">{colorScheme === 'light' ? '☾' : '☀'}</span>
      </ActionIcon>
    </Group>
  );
}
