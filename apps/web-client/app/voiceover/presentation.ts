import { stageLabels, type Voiceover } from './types';

export const pipelineGroups = [
  { label: 'Источник', keys: ['acquisition', 'preparation'] },
  { label: 'Распознавание', keys: ['asr_model', 'diarization_model', 'asr', 'diarization'] },
  { label: 'Перевод', keys: ['translation'] },
  { label: 'Голоса', keys: ['voice_samples'] },
  { label: 'Озвучка', keys: ['synthesis', 'shorten', 'fit', 'pauses'] },
  { label: 'Сборка', keys: ['rendering'] },
];
export const activeStatuses = ['awaiting_upload', 'preparing', 'synthesizing'];
export function youtubeId(url?: string) {
  try {
    const parsed = new URL(url ?? '');
    const host = parsed.hostname.replace(/^www\./, '');
    const id =
      host === 'youtu.be'
        ? parsed.pathname.slice(1)
        : ['youtube.com', 'm.youtube.com', 'youtube-nocookie.com'].includes(host)
          ? (parsed.searchParams.get('v') ??
            parsed.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)?.[1])
          : undefined;
    return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}
export function percent(stage?: Voiceover['stages'][string]) {
  if (!stage) return null;
  if (stage.state === 'completed') return 100;
  if (!stage.total_units || stage.total_units <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((stage.completed_units / stage.total_units) * 100)));
}
export function pipeline(record: Pick<Voiceover, 'status' | 'stages'>) {
  const stages = record.stages ?? {};
  const last = Math.max(
    -1,
    ...pipelineGroups.map((group, index) => (group.keys.some((key) => stages[key]) ? index : -1)),
    record.status === 'awaiting_voices' ? 3 : -1,
    record.status === 'synthesizing' ? 4 : -1,
  );
  return pipelineGroups.map((group, index) => {
    const entries = group.keys.flatMap((key) => (stages[key] ? [{ key, ...stages[key] }] : []));
    const running = entries.filter((stage) => stage.state === 'running');
    const failed = entries.some((stage) => stage.state === 'failed');
    let state = 'pending';
    if (['completed', 'incomplete'].includes(record.status)) state = 'completed';
    else if (failed) state = 'failed';
    else if (index === 3 && record.status === 'awaiting_voices') state = 'waiting';
    else if (index < last) state = 'completed';
    else if (running.length) state = activeStatuses.includes(record.status) ? 'running' : 'failed';
    else if (
      index < last ||
      (entries.length && entries.every((stage) => stage.state === 'completed'))
    )
      state = 'completed';
    else if (index === 0 && record.status === 'awaiting_upload') state = 'waiting';
    else if (index === last && record.status === 'failed') state = 'failed';
    else if (index === Math.max(0, last) && activeStatuses.includes(record.status))
      state = 'running';
    const measured = running.length ? running : entries.filter((stage) => stage.state === 'failed');
    const values = measured.map(percent);
    const value =
      state === 'completed'
        ? 100
        : state === 'pending' || state === 'waiting'
          ? 0
          : values.length && values.every((v) => v !== null)
            ? Math.round(values.reduce<number>((sum, v) => sum + (v ?? 0), 0) / values.length)
            : null;
    return { ...group, state, value, entries };
  });
}
export function currentProgress(record: Pick<Voiceover, 'status' | 'stages'>) {
  const groups = pipeline(record);
  return (
    groups.find((group) => ['running', 'failed', 'waiting'].includes(group.state)) ??
    groups.find((group) => group.state === 'pending') ??
    groups[5]
  );
}
export function duration(seconds?: number | null) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, '0')}`;
}
export function stageName(record: Voiceover) {
  return (
    Object.entries(record.stages)
      .filter(([, stage]) => stage.state === 'failed')
      .map(([key]) => stageLabels[key] ?? key)
      .join(', ') || currentProgress(record).label
  );
}
export function errorAdvice(code: string) {
  if (['missing_dependency', 'ModuleNotFoundError'].includes(code))
    return 'Не удалось запустить зависимость Python для обработки. Проверьте окружение соответствующего worker. Для Qwen путь должен вести на Python внутри qwen-env, а не на базовый интерпретатор.';
  if (code === 'invalid_media')
    return 'Проверьте, что файл содержит видео и аудиодорожку. Для YouTube нужна доступная публичная запись, а не трансляция или плейлист.';
  if (code === 'no_speech')
    return 'В аудиодорожке не найдена распознаваемая речь. Проверьте звук и язык исходного видео.';
  if (code === 'interrupted')
    return 'Обработка была прервана перезапуском сервиса. Автоматическое продолжение не поддерживается; создайте новый перевод из исходника.';
  if (['storage_error', 'cleanup_error'].includes(code))
    return 'Проверьте свободное место и права записи в каталоге данных сервиса. После исправления повторите действие.';
  if (code === 'revision_conflict')
    return 'Запись изменилась во время запроса. Дождитесь обновления данных и повторите действие.';
  if (code === 'busy')
    return 'Обработчик занят переводом или транскрибацией. Дождитесь завершения текущей задачи.';
  if (code === 'network_error')
    return 'Не удалось связаться с сервисом. Проверьте подключение и доступность backend. Данные на экране могут быть устаревшими.';
  if (code === 'translation_error')
    return 'Сервис перевода не завершил обработку. Проверьте доступность модели перевода и её настройки на сервере.';
  return 'Сервис не сообщил точную причину. Проверьте журналы backend, доступность моделей и ресурсы GPU. Передайте администратору код ошибки и идентификатор записи.';
}
