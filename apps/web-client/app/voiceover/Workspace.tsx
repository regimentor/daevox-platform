import { TranslationText } from './TranslationText';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Alert, Button, Drawer, FileInput, Select, TextInput, Checkbox } from '@mantine/core';
import { Player } from './Player';
import { VoiceSamples } from './VoiceSamples';
import { type LibraryItem, type Voiceover, stageLabels, statuses } from './types';
import { request, type VoiceoverError } from './client';
import {
  activeStatuses,
  currentProgress,
  duration,
  errorAdvice,
  percent,
  pipeline,
  stageName,
  youtubeId,
} from './presentation';
import './Workspace.css';

type Panel = 'new' | 'text' | 'voices' | 'materials' | 'error' | 'audio' | 'delete' | number | null;
type Props = {
  items: LibraryItem[];
  record: Voiceover | null;
  selectedId?: string;
  activity: { kind: string; id: string; status: string } | null;
  loading: boolean;
  pending: boolean;
  connectionLost: boolean;
  error: VoiceoverError | null;
  nextCursor: string | null;
  onRefresh: () => void;
  onSourceChange: () => void;
  onCreate: (
    file: File | null,
    url: string,
    options: { asr_gpu: string | null; tts_gpu: string | null; auto_synthesize: boolean },
  ) => Promise<boolean>;
  onAssign: (assignments: Record<string, string>) => Promise<boolean>;
  onSynthesize: () => Promise<boolean>;
  onDelete: () => Promise<boolean>;
  onLoadMore: () => Promise<boolean>;
};
function Meter({ value, state, label }: { value: number | null; state: string; label: string }) {
  return (
    <div
      className={`vo-meter ${state} ${value === null ? 'indeterminate' : ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuenow={value ?? undefined}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={value === null ? 'Объём работы уточняется' : `${value}%`}
    >
      <i style={{ width: `${value ?? 35}%` }} />
    </div>
  );
}
function Thumbnail({ source, title }: { source: Voiceover['source']; title: string }) {
  const id = youtubeId(source.url);
  const [failed, setFailed] = useState(false);
  return (
    <span className="vo-library-thumb">
      {id && !failed ? (
        <img
          src={`https://i.ytimg.com/vi/${id}/mqdefault.jpg`}
          alt=""
          onError={() => setFailed(true)}
        />
      ) : (
        <span aria-label={`Превью недоступно: ${title}`}>▷</span>
      )}
      <span className="vo-thumb-source">{id ? 'YT' : 'FILE'}</span>
    </span>
  );
}
function SourcePlayer({ record }: { record: Voiceover }) {
  const id = youtubeId(record.source.url);
  const [play, setPlay] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div className="vo-player-section">
      <div className="vo-player-toolbar">
        <strong>Исходное видео</strong>
        <span>Оригинальная дорожка</span>
      </div>
      <div className="vo-player">
        {id ? (
          play ? (
            <iframe
              title="Плеер YouTube"
              src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`}
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
            />
          ) : (
            <button
              className="vo-player-poster"
              aria-label="Смотреть исходное видео"
              onClick={() => setPlay(true)}
            >
              {!failed && (
                <img
                  src={`https://i.ytimg.com/vi/${id}/mqdefault.jpg`}
                  alt=""
                  onError={() => setFailed(true)}
                />
              )}
              <span className="vo-play-icon">▶</span>
            </button>
          )
        ) : (
          <div className="vo-player-unavailable">
            <span>▷</span>
            <strong>{record.source.name ?? 'Видеофайл'}</strong>
            <p>Плеер появится после подготовки видео и озвучки.</p>
          </div>
        )}
      </div>
      {id && (
        <div className="vo-player-foot">
          <small>Переведённая дорожка появится после сборки.</small>
          <a href={`https://www.youtube.com/watch?v=${id}`} target="_blank" rel="noreferrer">
            Открыть на YouTube ↗
          </a>
        </div>
      )}
    </div>
  );
}
function Transcript({ record }: { record: Voiceover }) {
  return (
    <>
      {record.transcript.length === 0 && <p>Распознанных фраз пока нет.</p>}
      {record.transcript.map((phrase) => (
        <div className="vo-phrase" key={phrase.id}>
          <small>
            {duration(phrase.start)}–{duration(phrase.end)} ·{' '}
            {record.speakers.find((s) => s.id === phrase.speaker_id)?.label ?? 'Неизвестный спикер'}
          </small>
          <p>{phrase.text}</p>
          <TranslationText
            value={record.translations.find((t) => t.source_segment_ids.includes(phrase.id))}
          />
        </div>
      ))}
    </>
  );
}
export function VoiceoverWorkspace(props: Props) {
  const { items, record, pending, error, selectedId } = props;
  const [panel, setPanel] = useState<Panel>(null);
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [devices, setDevices] = useState<{ value: string; label: string }[]>([]);
  const [deviceError, setDeviceError] = useState('');
  const [asrGpu, setAsrGpu] = useState<string | null>(null);
  const [ttsGpu, setTtsGpu] = useState<string | null>(null);
  const [automatic, setAutomatic] = useState(true);
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (panel !== 'new') return;
    let cancelled = false;
    request<{ items: { value: string; label: string }[] }>('/voiceover-devices')
      .then((value) => {
        if (!cancelled) {
          setDevices(value.items ?? []);
          setDeviceError(
            value.items?.length
              ? ''
              : 'Видеокарты не обнаружены. Будут использованы настройки сервера.',
          );
        }
      })
      .catch(() => {
        if (!cancelled)
          setDeviceError('Не удалось загрузить видеокарты. Будут использованы настройки сервера.');
      });
    return () => {
      cancelled = true;
    };
  }, [panel]);
  const groupElapsed = (entries: Voiceover['stages'][string][]) => {
    const measured = entries.filter((stage) => stage.first_started_at !== undefined);
    if (!measured.length) return Math.max(0, ...entries.map((stage) => stage.elapsed_seconds ?? 0));
    return Math.max(
      0,
      Math.max(...measured.map((stage) => stage.finished_at ?? now)) -
        Math.min(...measured.map((stage) => stage.first_started_at!)),
    );
  };
  const elapsed = (stage: { elapsed_seconds?: number; started_at?: number | null }) =>
    (stage.elapsed_seconds ?? 0) + (stage.started_at ? Math.max(0, now - stage.started_at) : 0);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  useEffect(() => {
    setPanel((previous) => (previous === 'new' ? previous : null));
  }, [selectedId]);
  const visible = items.filter(
    (item) =>
      item.title.toLowerCase().includes(query.toLowerCase()) &&
      (filter === 'all' ||
        (filter === 'attention' &&
          ['failed', 'incomplete', 'delete_failed', 'awaiting_voices'].includes(item.status)) ||
        (filter === 'done' && ['completed', 'incomplete'].includes(item.status))),
  );
  const groups = record ? pipeline(record) : [];
  const current = record ? currentProgress(record) : null;
  const failed = record?.error;
  const voiceOptions = record?.available_voices?.length
    ? record.available_voices
    : ['aidar', 'baya', 'kseniya', 'xenia', 'eugene'];
  const playerOwnsDrawer = !!record?.assets.video && ['text', 'audio'].includes(String(panel));
  const title =
    typeof panel === 'number'
      ? `Этап: ${groups[panel]?.label}`
      : {
          new: 'Новое видео',
          text: 'Текст и перевод',
          voices: 'Голоса спикеров',
          materials: 'Готовые материалы',
          error: 'Подробности ошибки',
          audio: 'Настройки звука',
          delete: 'Удаление записи',
        }[panel ?? 'new'];
  return (
    <div className="vo">
      <header className="vo-header">
        <div>
          <h1>Перевод видео</h1>
          <p>Источник → речь → перевод → голоса → озвучка → сборка</p>
        </div>
        <Button color="teal" size="sm" onClick={() => setPanel('new')}>
          ＋ Добавить видео
        </Button>
      </header>
      <div className="vo-summary">
        <span>
          <i />
          {items.filter((item) => activeStatuses.includes(item.status)).length} в работе
        </span>
        <button onClick={() => setFilter('attention')}>
          {
            items.filter((item) =>
              ['failed', 'delete_failed', 'incomplete', 'awaiting_voices'].includes(item.status),
            ).length
          }{' '}
          требуют внимания ↗
        </button>
        <span>
          {items.filter((item) => ['completed', 'incomplete'].includes(item.status)).length} готово
        </span>
        <small>Среди загруженных видео · EN → RU</small>
      </div>
      {props.activity && (
        <div className="vo-activity">
          <Link
            to={
              props.activity.kind === 'voiceover'
                ? `/voiceover/${props.activity.id}`
                : '/transcription'
            }
          >
            {props.activity.kind === 'voiceover' ? 'Текущий перевод' : 'Текущая транскрибация'}
          </Link>
        </div>
      )}
      {props.connectionLost && (
        <Alert color="yellow" mt="xs">
          Связь с обработкой потеряна. Переподключаемся…
        </Alert>
      )}
      {error && (
        <div className="vo-notice error" role="alert">
          <span>{error.message}</span>
          <button onClick={() => setPanel('error')}>Подробнее ↗</button>
        </div>
      )}
      <div className="vo-toolbar">
        <div>
          {[
            { key: 'all', label: 'Все видео' },
            { key: 'attention', label: 'Требуют внимания' },
            { key: 'done', label: 'Готовые' },
          ].map((tab) => (
            <button
              key={tab.key}
              className={filter === tab.key ? 'active' : ''}
              onClick={() => setFilter(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <TextInput
          size="xs"
          aria-label="Найти видео"
          placeholder="Найти видео…"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </div>
      <div className="vo-focus">
        <nav className="vo-video-list" aria-label="Библиотека видео">
          <div className="vo-list-label">
            БИБЛИОТЕКА <span>{items.length}</span>
          </div>
          {visible.map((item) => {
            const progress = currentProgress(item);
            return (
              <Link
                className={selectedId === item.id ? 'selected' : ''}
                key={item.id}
                to={`/voiceover/${item.id}`}
                aria-current={selectedId === item.id ? 'page' : undefined}
                aria-label={item.title}
              >
                <span className="vo-library-top">
                  <Thumbnail
                    key={item.source?.url ?? item.id}
                    source={item.source ?? { kind: 'file' }}
                    title={item.title}
                  />
                  <span className="vo-library-info">
                    <strong>{item.title}</strong>
                    <small>
                      {item.source?.kind === 'youtube' ? 'YouTube' : 'Файл'} ·{' '}
                      {duration(item.duration)}
                    </small>
                  </span>
                </span>
                <Meter
                  value={progress.value}
                  state={progress.state}
                  label={`${item.title}: ${progress.label}`}
                />
                <span className={`vo-dot-label ${progress.state}`}>
                  {activeStatuses.includes(item.status)
                    ? `${progress.label} · ${progress.value === null ? 'обработка' : `${progress.value}%`}`
                    : (statuses[item.status] ?? item.status)}
                </span>
              </Link>
            );
          })}
          {!visible.length && (
            <p className="vo-list-empty">
              {props.loading
                ? 'Загрузка библиотеки…'
                : items.length
                  ? 'Ничего не найдено'
                  : 'В библиотеке пока нет видео'}
            </p>
          )}
          {props.nextCursor && (
            <Button
              size="xs"
              m="sm"
              variant="default"
              disabled={pending}
              onClick={() => void props.onLoadMore()}
            >
              Показать ещё
            </Button>
          )}
        </nav>
        <section className="vo-workspace">
          {record ? (
            <>
              <div className="vo-focus-heading">
                <div>
                  <small>ВИДЕО</small>
                  <h2>
                    {record.source.name ??
                      (record.source.kind === 'youtube' ? 'Видео YouTube' : 'Видео')}
                  </h2>
                  <span>{duration(record.duration)} · Английский → Русский</span>
                </div>
                <span className={`vo-badge ${current?.state}`} role="status">
                  {statuses[record.status] ?? record.status}
                </span>
              </div>
              <div className="vo-video-tabs">
                <span className="vo-video-tab" aria-current="page">
                  ▷ Видео
                </span>
                <button onClick={() => setPanel('text')}>Текст и перевод ↗</button>
                <button onClick={() => setPanel('voices')}>Голоса ↗</button>
                <button onClick={() => setPanel('materials')}>Материалы ↗</button>
              </div>
              {record.assets.video ? (
                <Player
                  key={record.id}
                  record={record}
                  details={panel === 'text' || panel === 'audio' ? panel : null}
                  onDetails={setPanel}
                />
              ) : (
                <SourcePlayer key={record.id} record={record} />
              )}
              {record.stages.translation && (
                <div className="vo-translation-progress">
                  <div>
                    <strong>Перевод текста</strong>
                    <span>
                      Обработано{' '}
                      {record.stages.translation.total_units
                        ? record.stages.translation.completed_units
                        : record.translations.length}{' '}
                      из {record.stages.translation.total_units ?? record.transcript.length} фраз
                    </span>
                  </div>
                  <Meter
                    value={percent({
                      ...record.stages.translation,
                      completed_units: record.stages.translation.total_units
                        ? record.stages.translation.completed_units
                        : record.translations.length,
                      total_units:
                        record.stages.translation.total_units ?? record.transcript.length,
                    })}
                    state={
                      record.stages.translation.state === 'running' && record.status === 'preparing'
                        ? 'running'
                        : record.stages.translation.state === 'completed'
                          ? 'completed'
                          : 'failed'
                    }
                    label="Прогресс перевода текста"
                  />
                  {record.translations.some((phrase) => phrase.status === 'failed') && (
                    <small>
                      Не удалось перевести:{' '}
                      {record.translations.filter((phrase) => phrase.status === 'failed').length}.
                      Подробности — в тексте.
                    </small>
                  )}
                </div>
              )}
              {record.translations.some((phrase) => phrase.warnings?.length) && (
                <button className="vo-quality-warning" onClick={() => setPanel('text')}>
                  ⚠ Требуют проверки:{' '}
                  {record.translations.filter((phrase) => phrase.warnings?.length).length} фраз.
                  Открыть подробности
                </button>
              )}
              <small>
                Время обработки:{' '}
                {duration(
                  (record.elapsed_seconds ?? 0) +
                    (record.processing_started_at
                      ? Math.max(0, now - record.processing_started_at)
                      : 0),
                )}
              </small>
              {record.stages.synthesis && (
                <div className="vo-translation-progress">
                  <strong>
                    Синтез речи · {record.stages.synthesis.completed_units} из{' '}
                    {record.stages.synthesis.total_units ?? 0} фраз
                  </strong>
                  <Meter
                    value={percent(record.stages.synthesis)}
                    state={record.stages.synthesis.state}
                    label="Прогресс синтеза речи"
                  />
                </div>
              )}
              <div className="vo-pipeline-label">
                <strong>Пайплайн подготовки</strong>
                <span>
                  {groups.filter((group) => group.state === 'completed').length} из 6 этапов
                  завершено
                </span>
              </div>
              <div className="vo-pipeline large">
                {groups.map((group, index) => (
                  <button
                    key={group.label}
                    className={`vo-step ${group.state}`}
                    aria-current={group.state === 'running' ? 'step' : undefined}
                    onClick={() =>
                      setPanel(
                        group.state === 'failed' && failed
                          ? 'error'
                          : index === 3 && record.status === 'awaiting_voices'
                            ? 'voices'
                            : index,
                      )
                    }
                  >
                    <span>
                      <b>
                        {group.state === 'completed'
                          ? '✓'
                          : group.state === 'failed'
                            ? '!'
                            : `0${index + 1}`}
                      </b>{' '}
                      {group.label} · {duration(groupElapsed(group.entries))}
                    </span>
                    <Meter value={group.value} state={group.state} label={group.label} />
                    <small>
                      {group.state === 'completed'
                        ? 'Завершено'
                        : group.state === 'running'
                          ? group.value === null
                            ? 'Обработка…'
                            : `${group.value}%`
                          : group.state === 'failed'
                            ? 'Остановлено'
                            : group.state === 'waiting'
                              ? 'Нужен ваш выбор'
                              : 'Ожидание'}
                    </small>
                  </button>
                ))}
              </div>
              <div className={`vo-current ${current?.state}`}>
                <div>
                  <small>ТЕКУЩЕЕ СОСТОЯНИЕ</small>
                  <h3>
                    {failed?.message ??
                      (record.status === 'awaiting_voices'
                        ? 'Назначьте голоса спикерам'
                        : (statuses[record.status] ?? record.status))}
                  </h3>
                  <p>
                    {props.connectionLost
                      ? 'Соединение восстанавливается. Последние известные данные.'
                      : current?.state === 'running'
                        ? `${current.label}: ${current.value === null ? 'общий объём ещё неизвестен' : `${current.value}% текущих операций`}`
                        : record.status === 'incomplete'
                          ? `Проблемных фрагментов: ${record.problems.length}. Подробности — в тексте.`
                          : record.status === 'awaiting_upload'
                            ? 'Исходный файл ещё не загружен.'
                            : 'Нажмите на этап, чтобы посмотреть подробности.'}
                  </p>
                </div>
                <Button
                  size="xs"
                  color={failed ? 'red' : 'teal'}
                  variant="light"
                  onClick={() =>
                    setPanel(
                      failed
                        ? 'error'
                        : record.status === 'awaiting_voices'
                          ? 'voices'
                          : record.status === 'incomplete'
                            ? 'text'
                            : record.status === 'completed'
                              ? 'materials'
                              : Math.max(
                                  0,
                                  groups.findIndex(
                                    (group) => group === current || group.label === current?.label,
                                  ),
                                ),
                    )
                  }
                >
                  {failed
                    ? 'Разобрать ошибку ↗'
                    : record.status === 'awaiting_voices'
                      ? 'Выбрать голоса ↗'
                      : 'Открыть детали ↗'}
                </Button>
              </div>
              <div className="vo-record-actions">
                <span>
                  {record.storage_bytes
                    ? `${(record.storage_bytes / 1024 / 1024).toFixed(1)} МБ`
                    : ''}
                </span>
                <Button
                  variant="subtle"
                  color="red"
                  size="compact-xs"
                  disabled={pending || record.status === 'deleting'}
                  onClick={() => setPanel('delete')}
                >
                  {activeStatuses.includes(record.status) || record.status === 'awaiting_voices'
                    ? 'Отменить и удалить'
                    : 'Удалить'}
                </Button>
              </div>
            </>
          ) : (
            <div className="vo-empty">
              {selectedId
                ? error
                  ? 'Не удалось загрузить видео. Откройте подробности ошибки.'
                  : 'Загрузка видео…'
                : props.loading
                  ? 'Загрузка…'
                  : 'Добавьте видео, чтобы подготовить перевод.'}
            </div>
          )}
        </section>
      </div>
      <Drawer
        opened={panel !== null && !playerOwnsDrawer}
        onClose={() => setPanel(null)}
        position="right"
        size={460}
        title={title}
        closeButtonProps={{ 'aria-label': 'Закрыть детали' }}
        overlayProps={{ backgroundOpacity: 0.2, blur: 1 }}
        classNames={{ content: 'vo-drawer', header: 'vo-drawer-header' }}
      >
        <div className="vo-drawer-body">
          {record && panel !== 'new' && <small>{record.source.name ?? record.source.url}</small>}
          {error && panel !== 'error' && (
            <Alert color="red">
              {error.message}
              <p>{errorAdvice(error.code)}</p>
            </Alert>
          )}
          {panel === 'new' && (
            <>
              <FileInput
                label="Видеофайл"
                accept="video/*"
                value={file}
                disabled={pending}
                onChange={(value) => {
                  setFile(value);
                  setUrl('');
                  props.onSourceChange();
                }}
                clearable
              />
              <span className="vo-or">или</span>
              <TextInput
                label="Ссылка YouTube"
                type="url"
                placeholder="https://youtube.com/watch?v=…"
                value={url}
                disabled={pending}
                onChange={(event) => {
                  setUrl(event.currentTarget.value);
                  setFile(null);
                  props.onSourceChange();
                }}
              />
              <p>Перевод с английского на русский. Голоса выбираются после подготовки текста.</p>
              {props.activity && (
                <Alert color="yellow">Обработчик занят. Дождитесь завершения текущей задачи.</Alert>
              )}
              <Select
                label="Видеокарта для распознавания"
                placeholder="По настройкам сервера"
                data={devices}
                value={asrGpu}
                clearable
                onChange={(value) => {
                  setAsrGpu(value);
                  props.onSourceChange();
                }}
                disabled={pending}
              />
              <Select
                label="Видеокарта для озвучки"
                placeholder="По настройкам сервера"
                data={devices}
                value={ttsGpu}
                clearable
                onChange={(value) => {
                  setTtsGpu(value);
                  props.onSourceChange();
                }}
                disabled={pending}
              />
              {deviceError && <small>{deviceError}</small>}
              <Checkbox
                label="Озвучить автоматически"
                checked={automatic}
                onChange={(event) => {
                  setAutomatic(event.currentTarget.checked);
                  props.onSourceChange();
                }}
              />
              <Button
                color="teal"
                loading={pending}
                disabled={!!props.activity || (!file && !youtubeId(url))}
                onClick={() =>
                  void props
                    .onCreate(file, url, {
                      asr_gpu: asrGpu,
                      tts_gpu: ttsGpu,
                      auto_synthesize: automatic,
                    })
                    .then((ok) => {
                      if (ok) {
                        setPanel(null);
                        setFile(null);
                        setUrl('');
                      }
                    })
                }
              >
                Подготовить перевод
              </Button>
            </>
          )}
          {panel === 'text' && record && <Transcript record={record} />}
          {panel === 'voices' && record && (
            <>
              <p>
                {record.status === 'awaiting_voices'
                  ? 'Назначьте голос каждому спикеру и запустите озвучку.'
                  : 'Выберите другой голос и запустите переозвучку. Повторное распознавание не требуется.'}
              </p>
              {record.available_voices?.length ? (
                <VoiceSamples voices={voiceOptions} />
              ) : (
                <p>Образцы голосов пока не подготовлены.</p>
              )}
              {Object.entries(record.voice_assignments).map(([speaker, voice]) => (
                <Select
                  key={speaker}
                  label={
                    record.speakers.find((s) => s.id === speaker)?.label ?? 'Неизвестный спикер'
                  }
                  data={voiceOptions}
                  value={voice}
                  disabled={
                    pending ||
                    !['awaiting_voices', 'completed', 'incomplete'].includes(record.status)
                  }
                  onChange={(value) => {
                    if (value)
                      void props.onAssign({ ...record.voice_assignments, [speaker]: value });
                  }}
                />
              ))}
              <Button
                color="teal"
                loading={pending}
                disabled={!['awaiting_voices', 'completed', 'incomplete'].includes(record.status)}
                onClick={() =>
                  void props.onSynthesize().then((ok) => {
                    if (ok) setPanel(null);
                  })
                }
              >
                {record.status === 'awaiting_voices' ? 'Начать озвучку' : 'Переозвучить'}
              </Button>
            </>
          )}
          {panel === 'materials' && record && (
            <>
              {record.assets.video || record.assets.audio ? (
                <>
                  {record.assets.video && (
                    <a href={record.assets.video} download>
                      Скачать видео с оригинальной дорожкой
                    </a>
                  )}
                  {record.assets.audio && (
                    <a href={record.assets.audio} download>
                      Скачать переведённую аудиодорожку
                    </a>
                  )}
                  <p>В плеере видео и перевод воспроизводятся синхронно.</p>
                </>
              ) : (
                <p>Материалы появятся после завершения сборки.</p>
              )}
            </>
          )}
          {typeof panel === 'number' && record && (
            <>
              {groups[panel]?.entries.length ? (
                groups[panel].entries.map((stage) => (
                  <div key={stage.key} className="vo-stage-detail">
                    <strong>
                      {stageLabels[stage.key] ?? stage.key} · {duration(elapsed(stage))}
                    </strong>
                    <Meter
                      value={percent(stage)}
                      state={
                        stage.state === 'running' && activeStatuses.includes(record.status)
                          ? 'running'
                          : stage.state
                      }
                      label={stageLabels[stage.key] ?? stage.key}
                    />
                    <p>
                      {stage.completed_units} {stage.total_units ? `/ ${stage.total_units}` : ''}{' '}
                      {stage.unit} ·{' '}
                      {{ running: 'Выполняется', completed: 'Завершено', failed: 'Ошибка' }[
                        stage.state
                      ] ?? stage.state}
                    </p>
                    {stage.elapsed_seconds !== undefined && (
                      <small>Затрачено: {duration(elapsed(stage))}</small>
                    )}
                  </div>
                ))
              ) : (
                <p>Этап ещё не начался.</p>
              )}
              <small>
                Проценты рассчитываются только при известном общем объёме. Анимация без процента
                означает, что обработка идёт, но объём пока неизвестен.
              </small>
            </>
          )}
          {panel === 'error' && (
            <>
              <div className="vo-error-box">
                <small>{record ? stageName(record) : 'Запрос к сервису'}</small>
                <h2>{error?.message ?? failed?.message ?? 'Ошибка обработки'}</h2>
              </div>
              <h3>Что произошло и что делать</h3>
              <p>{errorAdvice(error?.code ?? failed?.code ?? 'unknown')}</p>
              {record && (
                <>
                  <h3>Доступные данные</h3>
                  <p>
                    Распознанных фраз: {record.transcript.length}. Переведённых:{' '}
                    {record.translations.length}.{' '}
                    {record.assets.video
                      ? 'Готовое видео доступно в плеере.'
                      : 'Готовое видео пока недоступно.'}
                  </p>
                  {record.status === 'failed' && (
                    <p>
                      Продолжение с места сбоя не поддерживается. После исправления причины создайте
                      новый перевод из исходного файла или ссылки.
                    </p>
                  )}
                </>
              )}
              <div className="vo-diagnostics">
                <dl>
                  <dt>Код</dt>
                  <dd>{error?.code ?? failed?.code ?? 'unknown'}</dd>
                  {error?.status && (
                    <>
                      <dt>HTTP</dt>
                      <dd>{error.status}</dd>
                    </>
                  )}
                  {record && (
                    <>
                      <dt>Запись</dt>
                      <dd>{record.id}</dd>
                      <dt>Этап</dt>
                      <dd>{stageName(record)}</dd>
                      <dt>Версия</dt>
                      <dd>{record.revision}</dd>
                    </>
                  )}
                </dl>
              </div>
              <Button
                variant="light"
                color="teal"
                onClick={() => {
                  props.onRefresh();
                  setPanel(null);
                }}
              >
                Обновить данные
              </Button>
            </>
          )}
          {panel === 'delete' && record && (
            <>
              <p>
                Будут удалены исходник, перевод и все материалы записи.{' '}
                {activeStatuses.includes(record.status) || record.status === 'awaiting_voices'
                  ? 'Текущая обработка будет остановлена.'
                  : ''}{' '}
                Восстановление недоступно.
              </p>
              <Button
                color="red"
                loading={pending}
                onClick={() =>
                  void props.onDelete().then((ok) => {
                    if (ok) setPanel(null);
                  })
                }
              >
                Удалить запись
              </Button>
            </>
          )}
        </div>
      </Drawer>
    </div>
  );
}
