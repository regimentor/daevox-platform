import { TranslationText } from './TranslationText';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Drawer, Paper, Stack, Text } from '@mantine/core';
import type { Voiceover } from './types';

export function Player({
  record,
  details,
  onDetails,
  onRetryPhrase,
}: {
  record: Voiceover;
  details: 'text' | 'audio' | null;
  onDetails: (details: 'text' | 'audio' | null) => void;
  onRetryPhrase: (phraseId: string, adaptedText: string) => Promise<boolean>;
}) {
  const shell = useRef<HTMLDivElement>(null);
  const transcriptContainer = useRef<HTMLDivElement>(null);
  const [time, setTime] = useState(0);
  const [original, setOriginal] = useState(1);
  const [translation, setTranslation] = useState(1);
  const [onlyOriginal, setOnlyOriginal] = useState(false);
  const [muted, setMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideControls = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const levels = useRef({ original, translation, onlyOriginal, muted });
  levels.current = { original, translation, onlyOriginal, muted };
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
    const tracks = () => (levels.current.onlyOriginal ? [v, a] : [a, v]);
    async function alignAndPlay() {
      if (!desired.current || starting.current) return;
      const [master, follower] = tracks();
      if (master.seeking || master.readyState < 3) return;
      starting.current = true;
      try {
        const starts: Promise<void>[] = [];
        if (master.paused) starts.push(master.play());
        if (!follower.seeking && !follower.ended && follower.readyState >= 3 && follower.paused)
          starts.push(follower.play());
        await Promise.all(starts);
        if (disposed || !desired.current) hold();
      } catch (cause) {
        // Seeking or pausing while play() is pending legitimately cancels it.
        if (
          !disposed &&
          desired.current &&
          !(cause instanceof DOMException && cause.name === 'AbortError')
        ) {
          desired.current = false;
          setPlaying(false);
          setError(String(cause));
          hold();
        }
      } finally {
        starting.current = false;
      }
    }
    const waiting = (event: Event) => {
      const [master, follower] = tracks();
      if (event.target === master) follower.pause();
    };
    resume.current = () => {
      void alignAndPlay();
    };
    const ready = () => {
      void alignAndPlay();
    };
    const end = (event: Event) => {
      if (event.target !== tracks()[0]) return;
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
      media.addEventListener('waiting', waiting);
      media.addEventListener('seeking', waiting);
      media.addEventListener('canplay', ready);
      media.addEventListener('seeked', ready);
    }
    v.addEventListener('ended', end);
    a.addEventListener('ended', end);
    let frame: number;
    let lastDisplayTime = -1;
    const tick = () => {
      const [master, follower] = tracks();
      if (desired.current && !master.paused && !master.seeking && !follower.seeking) {
        const drift = master.currentTime - follower.currentTime;
        // Never seek the audible track to correct clock drift.
        const rate = Math.abs(drift) > 0.06 ? (drift > 0 ? 1.03 : 0.97) : 1;
        if (master.playbackRate !== 1) master.playbackRate = 1;
        if (Math.abs(drift) > 0.5) follower.currentTime = master.currentTime;
        if (follower.playbackRate !== rate) follower.playbackRate = rate;
      }
      if (Math.abs(master.currentTime - lastDisplayTime) >= 0.2) {
        setTime(master.currentTime);
        lastDisplayTime = master.currentTime;
      }
      if (desired.current && (v.paused || a.paused)) void alignAndPlay();
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
        media.removeEventListener('waiting', waiting);
        media.removeEventListener('seeking', waiting);
        media.removeEventListener('canplay', ready);
        media.removeEventListener('seeked', ready);
      }
      v.removeEventListener('ended', end);
      a.removeEventListener('ended', end);
    };
  }, [record.assets.video, record.assets.audio]);
  useEffect(() => {
    const v = video.current!,
      a = audio.current!;
    v.volume = onlyOriginal && !muted ? original : 0;
    a.volume = !onlyOriginal && !muted ? translation : 0;
    const master = onlyOriginal ? v : a;
    master.playbackRate = 1;
  }, [onlyOriginal, original, translation, muted]);
  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement === shell.current);
    changed();
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);
  useEffect(() => {
    setControlsVisible(true);
    if (hideControls.current) clearTimeout(hideControls.current);
    if (playing) hideControls.current = setTimeout(() => setControlsVisible(false), 2500);
    return () => {
      if (hideControls.current) clearTimeout(hideControls.current);
    };
  }, [playing]);
  function revealControls() {
    setControlsVisible(true);
    if (hideControls.current) clearTimeout(hideControls.current);
    if (playing) hideControls.current = setTimeout(() => setControlsVisible(false), 2500);
  }
  function togglePlay() {
    desired.current = !desired.current;
    setPlaying(desired.current);
    setError('');
    if (desired.current && (video.current?.ended || audio.current?.ended)) seek(0);
    if (desired.current) resume.current();
    else {
      video.current?.pause();
      audio.current?.pause();
    }
    revealControls();
  }
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement === shell.current) await document.exitFullscreen();
      else await shell.current?.requestFullscreen();
    } catch {
      setError('Браузер не разрешил полноэкранный режим.');
    }
  }
  function seek(position: number) {
    const v = video.current!;
    const a = audio.current!;
    position = Math.max(0, Math.min(position, mediaDuration || position));
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
    <div
      ref={shell}
      className={`vo-live-player ${playing && !controlsVisible ? 'vo-controls-hidden' : ''}`}
      tabIndex={0}
      role="region"
      aria-label="Видеоплеер"
      onPointerMove={revealControls}
      onPointerDown={revealControls}
      onFocus={revealControls}
      onKeyDown={(event) => {
        if ((event.target as HTMLElement).closest('input, textarea, select, [role="dialog"]'))
          return;
        const key = event.key.toLowerCase();
        if (key === ' ' && (event.target as HTMLElement).closest('button')) return;
        if (![' ', 'k', 'f', 'm', 'arrowleft', 'arrowright', 'j', 'l'].includes(key)) return;
        event.preventDefault();
        revealControls();
        if (key === ' ' || key === 'k') togglePlay();
        if (key === 'f') void toggleFullscreen();
        if (key === 'm') setMuted((value) => !value);
        if (key === 'arrowleft' || key === 'j') seek(time - (key === 'j' ? 10 : 5));
        if (key === 'arrowright' || key === 'l') seek(time + (key === 'l' ? 10 : 5));
      }}
    >
      {error && (
        <Alert className="vo-player-error" color="red" p="xs">
          {error}
        </Alert>
      )}
      <video
        ref={video}
        aria-label="Видео"
        playsInline
        preload="metadata"
        src={record.assets.video}
        onClick={togglePlay}
        onDoubleClick={() => void toggleFullscreen()}
        onLoadedMetadata={(event) =>
          setMediaDuration(
            Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0,
          )
        }
      />
      <audio ref={audio} aria-label="Перевод" preload="auto" src={record.assets.audio} />
      {!playing && (
        <button className="vo-center-play" aria-label="Начать просмотр" onClick={togglePlay}>
          <PlayerIcon name="play" />
        </button>
      )}
      <div className="vo-player-controls">
        <input
          className="vo-player-seek"
          aria-label="Перемотка"
          aria-valuetext={`${formatTime(time)} из ${formatTime(mediaDuration)}`}
          type="range"
          min="0"
          max={mediaDuration}
          step="0.05"
          value={time}
          style={{
            background: `linear-gradient(to right, #ff3434 ${mediaDuration ? (time / mediaDuration) * 100 : 0}%, #ffffff55 0)`,
          }}
          onChange={(event) => seek(Number(event.target.value))}
        />
        <div className="vo-player-toolbar">
          <button
            aria-label={playing ? 'Пауза' : 'Воспроизвести'}
            title="Воспроизведение / пауза (K)"
            onClick={togglePlay}
          >
            <PlayerIcon name={playing ? 'pause' : 'play'} />
          </button>
          <button
            aria-label={muted ? 'Включить звук' : 'Выключить звук'}
            title="Звук (M)"
            onClick={() => setMuted(!muted)}
          >
            <PlayerIcon name={muted ? 'muted' : 'volume'} />
          </button>
          <input
            className="vo-player-volume"
            aria-label="Громкость"
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={muted ? 0 : onlyOriginal ? original : translation}
            onChange={(event) => {
              setMuted(false);
              (onlyOriginal ? setOriginal : setTranslation)(Number(event.target.value));
            }}
          />
          <span className="vo-player-time">
            {formatTime(time)} <span>/ {formatTime(mediaDuration)}</span>
          </span>
          <span className="vo-player-spacer" />
          <button
            className="vo-player-language"
            aria-label={onlyOriginal ? 'Включить перевод' : 'Включить оригинал'}
            title="Переключить звуковую дорожку"
            onClick={() => setOnlyOriginal(!onlyOriginal)}
          >
            {onlyOriginal ? 'Ориг.' : 'RU'}
          </button>
          <button aria-label="Звук" title="Настройки звука" onClick={() => onDetails('audio')}>
            <PlayerIcon name="settings" />
          </button>
          <button
            aria-label={fullscreen ? 'Выйти из полного экрана' : 'Полный экран'}
            title="Полный экран (F)"
            onClick={() => void toggleFullscreen()}
          >
            <PlayerIcon name={fullscreen ? 'shrink' : 'expand'} />
          </button>
        </div>
      </div>
      <Drawer
        portalProps={fullscreen ? { target: shell.current ?? undefined } : undefined}
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
              RU-дорожка уже содержит выбранный режим фона, поэтому оригинал при её воспроизведении
              выключен.
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
                    onRetry={onRetryPhrase}
                  />
                </Paper>
              ))}
            </div>
          </Stack>
        )}
      </Drawer>
    </div>
  );
}

function formatTime(value: number) {
  const seconds = Math.max(0, Math.floor(value || 0));
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
    : `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function PlayerIcon({
  name,
}: {
  name: 'play' | 'pause' | 'volume' | 'muted' | 'settings' | 'expand' | 'shrink';
}) {
  const paths = {
    play: 'M8 5v14l11-7z',
    pause: 'M6 5h4v14H6zM14 5h4v14h-4z',
    volume: 'M3 9v6h4l5 4V5L7 9H3z M15 8v8c3-2 3-6 0-8z M18 4v2c5 3 5 9 0 12v2c8-4 8-12 0-16z',
    muted: 'M3 9v6h4l5 4V5L7 9H3z M16 8l-1 1 3 3-3 3 1 1 3-3 3 3 1-1-3-3 3-3-1-1-3 3z',
    settings:
      'M10 2h4l1 3 3 1 3 4v4l-3 4-3 1-1 3h-4l-1-3-3-1-3-4v-4l3-4 3-1z M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
    expand: 'M3 3h7v2H5v5H3zM14 3h7v7h-2V5h-5zM3 14h2v5h5v2H3zM19 14h2v7h-7v-2h5z',
    shrink: 'M8 3h2v7H3V8h5zM14 3h2v5h5v2h-7zM3 14h7v7H8v-5H3zM14 14h7v2h-5v5h-2z',
  };
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="24" height="24">
      <path fill="currentColor" fillRule="evenodd" d={paths[name]} />
    </svg>
  );
}
