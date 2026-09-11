import { MantineProvider } from '@mantine/core';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Player } from './Player';
import type { Voiceover } from './types';

const record: Voiceover = {
  id: 'video',
  revision: 1,
  status: 'completed',
  source: { kind: 'file' },
  transcript: [],
  translations: [],
  speakers: [],
  voice_assignments: {},
  problems: [],
  assets: { video: '/video.mp4', audio: '/translation.m4a' },
  error: null,
  stages: {},
  dubbing: {},
};
afterEach(() => vi.restoreAllMocks());

async function setup() {
  let frame: FrameRequestCallback = vi.fn();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frame = callback;
    return 1;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(
    async function (this: HTMLMediaElement) {
      Object.defineProperty(this, 'paused', { configurable: true, value: false });
    },
  );
  const pause = vi
    .spyOn(HTMLMediaElement.prototype, 'pause')
    .mockImplementation(function (this: HTMLMediaElement) {
      Object.defineProperty(this, 'paused', { configurable: true, value: true });
    });
  render(
    <MantineProvider>
      <Player record={record} details={null} onDetails={vi.fn()} onRetryPhrase={vi.fn()} />
    </MantineProvider>,
  );
  const video = screen.getByLabelText<HTMLVideoElement>('Видео');
  const audio = screen.getByLabelText<HTMLAudioElement>('Перевод');
  for (const media of [video, audio])
    Object.defineProperty(media, 'readyState', { configurable: true, value: 4 });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Воспроизвести' }));
  });
  pause.mockClear();
  return {
    video,
    audio,
    pause,
    tick: async () => {
      await act(async () => {
        frame(0);
      });
    },
  };
}

it('keeps audible translation uninterrupted when video drifts', async () => {
  const { video, audio, pause, tick } = await setup();
  audio.currentTime = 10;
  video.currentTime = 9.85;
  await tick();
  expect(audio.currentTime).toBe(10);
  expect(pause).not.toHaveBeenCalled();
  expect(audio.playbackRate).toBe(1);
  expect(video.playbackRate).toBeGreaterThan(1);
  video.currentTime = 8;
  await tick();
  expect(video.currentTime).toBe(10);
  expect(audio.currentTime).toBe(10);
  expect(pause).not.toHaveBeenCalled();
});

it('explicit seeking moves both tracks and pause stops both', async () => {
  const { video, audio } = await setup();
  Object.defineProperty(video, 'duration', { configurable: true, value: 60 });
  fireEvent.loadedMetadata(video);
  fireEvent.change(screen.getByLabelText('Перемотка'), { target: { value: '20' } });
  expect(video.currentTime).toBe(20);
  expect(audio.currentTime).toBe(20);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Пауза' }));
  });
  expect(video.paused).toBe(true);
  expect(audio.paused).toBe(true);
});

it('does not pause translation when the muted video buffers or seeks', async () => {
  const { video, audio, tick } = await setup();
  fireEvent.waiting(video);
  fireEvent.seeking(video);
  await tick();
  expect(audio.paused).toBe(false);
  Object.defineProperty(audio, 'readyState', { configurable: true, value: 2 });
  fireEvent.waiting(audio);
  await tick();
  expect(video.paused).toBe(true);
  Object.defineProperty(audio, 'readyState', { configurable: true, value: 4 });
  await act(async () => {
    fireEvent.canPlay(audio);
  });
  expect(video.paused).toBe(false);
});

it('makes the original the clock master when the user switches tracks', async () => {
  const { video, audio, tick, pause } = await setup();
  fireEvent.click(screen.getByRole('button', { name: 'Включить оригинал' }));
  expect(video.volume).toBe(1);
  expect(audio.volume).toBe(0);
  video.currentTime = 12;
  audio.currentTime = 10;
  await tick();
  expect(video.currentTime).toBe(12);
  expect(audio.currentTime).toBe(12);
  expect(video.playbackRate).toBe(1);
  expect(pause).not.toHaveBeenCalled();
});

it('requests fullscreen for the video and its controls and reflects external exit', async () => {
  await setup();
  const shell = screen.getByRole('region', { name: 'Видеоплеер' });
  const enter = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(shell, 'requestFullscreen', { configurable: true, value: enter });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Полный экран' }));
  });
  expect(enter).toHaveBeenCalledOnce();
  expect(shell).toContainElement(screen.getByLabelText('Перемотка'));
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: shell });
  fireEvent(document, new Event('fullscreenchange'));
  expect(screen.getByRole('button', { name: 'Выйти из полного экрана' })).toBeVisible();
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
  fireEvent(document, new Event('fullscreenchange'));
  expect(screen.getByRole('button', { name: 'Полный экран' })).toBeVisible();
});
