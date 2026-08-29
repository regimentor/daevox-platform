import {
  ActionIcon,
  Group,
  Text,
  useComputedColorScheme,
  useMantineColorScheme,
} from '@mantine/core';

import classes from './AppHeader.module.css';

export function AppHeader() {
  const colorScheme = useComputedColorScheme('light');
  const { setColorScheme } = useMantineColorScheme();
  const nextColorScheme = colorScheme === 'light' ? 'dark' : 'light';

  return (
    <Group className={classes.header} justify="space-between" px="md">
      <Text fw={700} size="lg">
        Daevox agentic platform
      </Text>
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
