import { TranslationText } from './TranslationText';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Drawer, Paper, Stack, Text } from '@mantine/core';
import type { Voiceover } from './types';

export function Player({
  record,
  details,
  onDetails,
}: {
  record: Voiceover;
  details: 'text' | 'audio' | null;
  onDetails: (details: 'text' | 'audio' | null) => void;
}) {
  const shell = useRef<HTMLDivElement>(null);
  const transcriptContainer = useRef<HTMLDivElement>(null);
  const [time, setTime] = useState(0);
  const [original, setOriginal] = useState(1);
  const [translation, setTranslation] = useState(1);
  const [onlyOriginal, setOnlyOriginal] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const levels = useRef({ original, translation, onlyOriginal });
  levels.current = { original, translation, onlyOriginal };
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const desired = useRef(false);
  const starting = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState('');
  const [mediaDuration, setMediaDuration] = useState(0);
  const current = useRef(record);
  current.current = record;
  const resume = useRef(() => {});
  useEffect(() => {
    const v = video.current!;
    const a = audio.current!;
    let disposed = false;
    function hold() {
      v.pause();
      a.pause();
    }
    async function alignAndPlay() {
      if (!desired.current || starting.current || v.seeking || a.seeking) return;
      if (Math.abs(a.currentTime - v.currentTime) > 0.08) {
        hold();
        a.currentTime = v.currentTime;
        return;
      }
      if (v.readyState < 3 || a.readyState < 3) {
        hold();
        return;
      }
      starting.current = true;
      try {
        await Promise.all([v.play(), a.play()]);
        if (disposed || !desired.current) hold();
      } catch (cause) {
        if (!disposed && desired.current) {
          desired.current = false;
          setPlaying(false);
          setError(String(cause));
          hold();
        }
      } finally {
        starting.current = false;
      }
    }
    resume.current = () => {
      void alignAndPlay();
    };
    const ready = () => {
      void alignAndPlay();
    };
    const end = () => {
      desired.current = false;
      setPlaying(false);
      hold();
    };
    const mediaError = () => {
      desired.current = false;
      setPlaying(false);
      hold();
      setError(
        'Не удалось загрузить видео или дорожку перевода. Проверьте соединение и доступность файлов на сервере, затем обновите страницу.',
      );
    };
    for (const media of [v, a]) {
      media.addEventListener('error', mediaError);
      media.addEventListener('waiting', hold);
      media.addEventListener('seeking', hold);
      media.addEventListener('canplay', ready);
      media.addEventListener('seeked', ready);
    }
    v.addEventListener('ended', end);
    let frame: number;
    const tick = () => {
      v.playbackRate = a.playbackRate = 1;
      const speaking = current.current.translations.some(
        (t) =>
          t.playback_start !== undefined &&
          t.playback_end !== undefined &&
          v.currentTime >= t.playback_start &&
          v.currentTime < t.playback_end,
      );
      v.volume = levels.current.original * (speaking && !levels.current.onlyOriginal ? 0.2 : 1);
      a.volume = levels.current.onlyOriginal ? 0 : levels.current.translation;
      setTime(v.currentTime);
      if (desired.current) void alignAndPlay();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      disposed = true;
      desired.current = false;
      hold();
      cancelAnimationFrame(frame);
      for (const media of [v, a]) {
        media.removeEventListener('error', mediaError);
        media.removeEventListener('waiting', hold);
        media.removeEventListener('seeking', hold);
        media.removeEventListener('canplay', ready);
        media.removeEventListener('seeked', ready);
      }
      v.removeEventListener('ended', end);
    };
  }, [record.assets.video, record.assets.audio]);
  function seek(position: number) {
    const v = video.current!;
    const a = audio.current!;
    v.pause();
    a.pause();
    v.currentTime = position;
    a.currentTime = position;
    setTime(position);
    resume.current();
  }
  const firstActive = record.transcript.find((p) => p.start <= time && time < p.end)?.id;
  useEffect(() => {
    if (autoScroll && firstActive)
      transcriptContainer.current
        ?.querySelector(`[data-phrase-id="${CSS.escape(firstActive)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
  }, [firstActive, autoScroll]);
  return (
    <Stack ref={shell} gap="xs" className="vo-live-player">
      {error && (
        <Alert color="red" p="xs">
          Воспроизведение остановлено. <button onClick={() => onDetails('audio')}>Подробнее</button>
        </Alert>
      )}
      <video
        ref={video}
        aria-label="Видео"
        preload="metadata"
        src={record.assets.video}
        onLoadedMetadata={(event) =>
          setMediaDuration(
            Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0,
          )
        }
      />
      <audio ref={audio} aria-label="Перевод" preload="auto" src={record.assets.audio} />
      <div className="vo-player-controls">
        <Button
          size="compact-xs"
          color="teal"
          onClick={() => {
            desired.current = !desired.current;
            setPlaying(desired.current);
            setError('');
            if (desired.current) resume.current();
            else {
              video.current?.pause();
              audio.current?.pause();
            }
          }}
        >
          {playing ? 'Пауза' : 'Воспроизвести'}
        </Button>
        <input
          aria-label="Перемотка"
          type="range"
          min="0"
          max={mediaDuration}
          step="0.05"
          value={time}
          onChange={(event) => seek(Number(event.target.value))}
        />
        <Button size="compact-xs" variant="subtle" onClick={() => onDetails('audio')}>
          Звук
        </Button>
        <Button
          size="compact-xs"
          variant="subtle"
          onClick={() =>
            void shell.current?.requestFullscreen().catch((cause) => setError(String(cause)))
          }
        >
          Полный экран
        </Button>
      </div>
      <Drawer
        opened={details !== null}
        onClose={() => onDetails(null)}
        position="right"
        size={460}
        title={details === 'text' ? 'Текст и перевод' : 'Настройки звука'}
        closeButtonProps={{ 'aria-label': 'Закрыть детали' }}
        classNames={{ content: 'vo-drawer', header: 'vo-drawer-header' }}
        overlayProps={{ backgroundOpacity: 0.2, blur: 1 }}
      >
        {details === 'audio' ? (
          <Stack className="vo-audio-settings">
            {error && (
              <Alert color="red">
                <strong>Ошибка воспроизведения</strong>
                <p>{error}</p>
                <Text size="xs">Запись: {record.id}</Text>
              </Alert>
            )}
            <label>
              Громкость оригинала
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={original}
                onChange={(event) => setOriginal(Number(event.target.value))}
              />
            </label>
            <label>
              Громкость перевода
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={translation}
                onChange={(event) => setTranslation(Number(event.target.value))}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={onlyOriginal}
                onChange={(event) => setOnlyOriginal(event.target.checked)}
              />
              Только оригинал
            </label>
            <Text size="xs" c="dimmed">
              Во время переведённой речи оригинальная дорожка автоматически приглушается.
            </Text>
          </Stack>
        ) : (
          <Stack>
            <label>
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(event) => setAutoScroll(event.target.checked)}
              />{' '}
              Автопрокрутка текста
            </label>
            {record.problems.map((problem, index) => (
              <Button
                key={index}
                variant="light"
                color="orange"
                onClick={() => seek(problem.start)}
              >
                {problem.reason === 'timing_overflow'
                  ? 'Превышено отставание'
                  : 'Проблемный момент'}
                : {problem.start.toFixed(1)} с
              </Button>
            ))}
            <div ref={transcriptContainer} style={{ maxHeight: '40vh', overflow: 'auto' }}>
              {record.transcript.map((phrase) => (
                <Paper
                  key={phrase.id}
                  data-phrase-id={phrase.id}
                  withBorder
                  p="sm"
                  style={{
                    background:
                      phrase.start <= time && time < phrase.end
                        ? 'var(--mantine-color-blue-light)'
                        : undefined,
                  }}
                >
                  <Button
                    variant="subtle"
                    aria-label={`Перейти к ${phrase.start.toFixed(1)} с`}
                    onClick={() => seek(phrase.start)}
                  >
                    {phrase.start.toFixed(1)} с ·{' '}
                    {record.speakers.find((s) => s.id === phrase.speaker_id)?.label ||
                      'Неизвестный спикер'}
                  </Button>
                  <Text>{phrase.text}</Text>
                  <TranslationText
                    value={record.translations.find((t) =>
                      t.source_segment_ids.includes(phrase.id),
                    )}
                  />
                </Paper>
              ))}
            </div>
          </Stack>
        )}
      </Drawer>
    </Stack>
  );
}
