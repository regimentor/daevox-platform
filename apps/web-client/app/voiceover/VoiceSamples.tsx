import { useEffect, useRef } from 'react';
import { Group, Stack, Text } from '@mantine/core';

export function VoiceSamples() {
  const players = useRef(new Map<string, HTMLAudioElement>());
  useEffect(() => {
    const mounted = players.current;
    return () => {
      for (const player of mounted.values()) player.pause();
    };
  }, []);
  return (
    <Group align="start">
      {['aidar', 'baya', 'kseniya', 'xenia', 'eugene'].map((voice) => (
        <Stack key={voice} gap="xs">
          <Text size="sm">{voice}</Text>
          <audio
            controls
            preload="none"
            aria-label={`Образец ${voice}`}
            src={`/trancription-api/voiceover-voices/${voice}/sample`}
            ref={(node) => {
              if (node) players.current.set(voice, node);
              else {
                players.current.get(voice)?.pause();
                players.current.delete(voice);
              }
            }}
            onPlay={(event) => {
              for (const player of players.current.values())
                if (player !== event.currentTarget) player.pause();
            }}
          />
        </Stack>
      ))}
    </Group>
  );
}
