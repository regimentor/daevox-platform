import { Stack, Text, Title } from '@mantine/core';
import type { MetaFunction } from 'react-router';

export const meta: MetaFunction = () => [
  { title: 'Daevox' },
  { content: 'Daevox web client', name: 'description' },
];

export default function Home() {
  return (
    <Stack gap="xs">
      <Title>Daevox web client</Title>
      <Text c="dimmed">Vite, React Router and Mantine are ready.</Text>
    </Stack>
  );
}
