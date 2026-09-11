import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { DubbingPanel } from './DubbingPanel';
import type { Voiceover } from './types';

const record: Voiceover = {
  id: 'video',
  revision: 1,
  status: 'synthesizing',
  source: { kind: 'file' },
  transcript: [
    { id: 'a', start: 0, end: 4, text: 'English original.', speaker_id: 'one' },
    { id: 'b', start: 5, end: 9, text: 'Next phrase.', speaker_id: 'one' },
  ],
  translations: [
    {
      id: 'a',
      source_segment_ids: ['a'],
      text: 'Полный перевод.',
      status: 'processing',
      step: 'shorten',
      attempt: 1,
      measured_duration: 8.4,
      available_seconds: 5,
      speed: 1.5,
      fitted_duration: 5.6,
      attempts: [
        {
          number: 1,
          text: 'Полный перевод.',
          measured_duration: 8.4,
          available_seconds: 5,
          speed: 1.5,
          fitted_duration: 5.6,
          fits: false,
        },
      ],
    },
  ],
  speakers: [{ id: 'one', label: 'Спикер 1' }],
  voice_assignments: { one: 'demo' },
  problems: [],
  assets: {},
  error: null,
  stages: {},
  dubbing: { phrase_id: 'a', step: 'shorten' },
};

it('shows the active phrase and measurements without counting synthesis as ready', async () => {
  render(<DubbingPanel record={record} pending={false} onRetry={vi.fn()} onVoices={vi.fn()} />);
  expect(screen.getByRole('progressbar', { name: 'Готовые фразы' })).toHaveAttribute('value', '0');
  expect(screen.getByText(/Ускорения недостаточно/)).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: /Next phrase/ }));
  expect(screen.getByText('Перевод появится при обработке этой фразы.')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Следить за текущей' }));
  expect(screen.getByText(/Ускорения недостаточно/)).toBeVisible();
});

it('retries the selected conflicting phrase with the edited text', async () => {
  const retry = vi.fn().mockResolvedValue(true);
  const complete: Voiceover = {
    ...record,
    status: 'incomplete',
    translations: [
      {
        ...record.translations[0],
        status: 'timing_conflict',
        step: 'conflict',
        full_text: 'Полный перевод.',
        adapted_text: 'Коротко.',
      },
    ],
  };
  render(<DubbingPanel record={complete} pending={false} onRetry={retry} onVoices={vi.fn()} />);
  await userEvent.clear(screen.getByLabelText('Текст озвучки'));
  await userEvent.type(screen.getByLabelText('Текст озвучки'), 'Новая версия.');
  await userEvent.click(screen.getByRole('button', { name: 'Повторить эту фразу' }));
  expect(retry).toHaveBeenCalledWith('a', 'Новая версия.');
});
