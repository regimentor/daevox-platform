import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { TranslationText } from './TranslationText';

it('shows full and adapted translations and retries only the problem phrase', async () => {
  const retry = vi.fn().mockResolvedValue(true);
  render(
    <TranslationText
      value={{
        id: 'phrase-1',
        source_segment_ids: ['phrase-1'],
        text: 'Коротко.',
        full_text: 'Полный перевод со всеми подробностями.',
        adapted_text: 'Коротко.',
        status: 'timing_conflict',
        audio_asset: '/phrase.wav',
      }}
      onRetry={retry}
    />,
  );

  expect(screen.getByText('Полный перевод со всеми подробностями.')).toBeVisible();
  expect(screen.getByLabelText('Текст озвучки')).toHaveValue('Коротко.');
  expect(screen.getByRole('link', { name: 'Прослушать проблемную фразу' })).toHaveAttribute(
    'href',
    '/phrase.wav',
  );
  await userEvent.clear(screen.getByLabelText('Текст озвучки'));
  await userEvent.type(screen.getByLabelText('Текст озвучки'), 'Новая версия.');
  await userEvent.click(screen.getByRole('button', { name: 'Повторить эту фразу' }));
  expect(retry).toHaveBeenCalledWith('phrase-1', 'Новая версия.');
});
