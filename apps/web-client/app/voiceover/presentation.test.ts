import { describe, expect, it } from 'vitest';
import { currentProgress, errorAdvice, percent, pipeline, youtubeId } from './presentation';

describe('pipeline progress', () => {
  it('does not invent percentages while the amount of work is unknown', () => {
    expect(
      currentProgress({
        status: 'preparing',
        stages: { preparation: { state: 'running', completed_units: 0, unit: '' } },
      }),
    ).toMatchObject({ label: 'Источник', state: 'running', value: null });
  });
  it('keeps a parallel stage running when the other worker has completed', () => {
    expect(
      pipeline({
        status: 'preparing',
        stages: {
          asr: { state: 'completed', completed_units: 10, total_units: 10, unit: 'seconds' },
          diarization: { state: 'running', completed_units: 3, total_units: 10, unit: 'seconds' },
        },
      })[1],
    ).toMatchObject({ state: 'running', value: 30 });
  });
  it('stops animations after a failed worker even if an old stage says running', () => {
    expect(
      currentProgress({
        status: 'failed',
        stages: {
          synthesis: { state: 'running', completed_units: 4, total_units: 10, unit: 'phrases' },
        },
      }),
    ).toMatchObject({ state: 'failed', value: 40 });
  });
  it('waits for human voice assignment despite completed samples', () => {
    expect(
      pipeline({
        status: 'awaiting_voices',
        stages: {
          voice_samples: { state: 'completed', completed_units: 5, total_units: 5, unit: 'voices' },
        },
      })[3],
    ).toMatchObject({ state: 'waiting', value: 0 });
  });
  it('shows completed preparation groups and pending synthesis at voice selection', () => {
    expect(pipeline({ status: 'awaiting_voices', stages: {} }).map((group) => group.state)).toEqual(
      ['completed', 'completed', 'completed', 'waiting', 'pending', 'pending'],
    );
  });
  it('clamps overestimates and recognises terminal completion', () => {
    expect(percent({ state: 'running', completed_units: 20, total_units: 10, unit: 'bytes' })).toBe(
      100,
    );
    expect(
      pipeline({ status: 'incomplete', stages: {} }).every((group) => group.value === 100),
    ).toBe(true);
  });
});
it('extracts only video identifiers from recognised YouTube URLs', () => {
  expect(youtubeId('https://youtu.be/YE7VzlLtp-4?t=5')).toBe('YE7VzlLtp-4');
  expect(youtubeId('https://www.youtube.com/watch?v=YE7VzlLtp-4')).toBe('YE7VzlLtp-4');
  expect(youtubeId('https://www.youtube.com/shorts/YE7VzlLtp-4')).toBe('YE7VzlLtp-4');
  expect(youtubeId('https://youtube.com.evil.test/watch?v=YE7VzlLtp-4')).toBeUndefined();
  expect(youtubeId('javascript:alert(1)')).toBeUndefined();
});
it('does not promise unsupported recovery on interruption', () => {
  expect(errorAdvice('interrupted')).toContain('Автоматическое продолжение не поддерживается');
});
it('treats stale download progress as completed once later phases begin', () => {
  expect(
    pipeline({
      status: 'failed',
      stages: {
        acquisition: { state: 'running', completed_units: 10, total_units: 10, unit: 'bytes' },
        preparation: { state: 'completed', completed_units: 1, total_units: 1, unit: 'file' },
        voice_samples: { state: 'failed', completed_units: 0, unit: '' },
      },
    })[0],
  ).toMatchObject({ state: 'completed', value: 100 });
});
