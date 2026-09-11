export interface Phrase {
  id: string;
  start: number;
  end: number;
  text: string;
  speaker_id: string | null;
}
export interface Translation {
  id: string;
  source_segment_ids: string[];
  warnings?: { code: string; message: string }[];
  text: string;
  full_text?: string;
  adapted_text?: string;
  status: string;
  audio_asset?: string;
  audio_cache_key?: string;
  playback_start?: number;
  playback_end?: number;
  step?: string;
  attempt?: number;
  selected_attempt?: number;
  original_duration?: number;
  measured_duration?: number;
  fitted_duration?: number;
  available_seconds?: number;
  speed?: number;
  lag_seconds?: number;
  deadline?: number;
  attempts?: {
    number: number;
    text: string;
    measured_duration: number;
    fitted_duration: number;
    available_seconds: number;
    speed: number;
    fits: boolean;
  }[];
}
export interface Voiceover {
  id: string;
  revision: number;
  elapsed_seconds?: number;
  processing_started_at?: number | null;
  devices?: Record<string, string>;
  duration?: number | null;
  storage_bytes?: number;
  created_at?: string;
  status: string;
  source: { kind: string; name?: string; url?: string };
  transcript: Phrase[];
  translations: Translation[];
  speakers: { id: string; label: string }[];
  available_voices?: string[];
  voice_assignments: Record<string, string>;
  speaker_samples?: Record<
    string,
    {
      kind: 'reference' | 'manual' | 'fallback';
      asset?: string;
      fallback_voice?: string;
      reason?: string;
    }
  >;
  background?: { mode: 'separated' | 'speech_only' | 'original_ducked'; reason?: string | null };
  problems: { start: number; end: number; reason: string }[];
  assets: { video?: string; audio?: string };
  error: { code: string; message: string } | null;
  stages: Record<
    string,
    {
      state: string;
      completed_units: number;
      total_units?: number;
      unit: string;
      elapsed_seconds?: number;
      started_at?: number | null;
      first_started_at?: number;
      finished_at?: number;
    }
  >;
  dubbing?: {
    phrase_id?: string;
    step?: string;
    active_phrase_ids?: string[];
    concurrency?: number;
    queue_mode?: string;
  };
}
export const statuses: Record<string, string> = {
  awaiting_upload: 'Ожидание видео',
  preparing: 'Подготовка перевода',
  awaiting_voices: 'Готово к озвучке',
  synthesizing: 'Подготовка озвучки',
  completed: 'Готово',
  incomplete: 'Перевод неполный',
  failed: 'Ошибка обработки',
  deleting: 'Удаление',
  delete_failed: 'Не удалось удалить',
};

export const stageLabels: Record<string, string> = {
  dubbing: 'Озвучка фраз',
  acquisition: 'Получение видео',
  preparation: 'Подготовка аудио',
  asr_model: 'Загрузка распознавания',
  diarization_model: 'Загрузка разметки спикеров',
  asr: 'Распознавание речи',
  diarization: 'Определение спикеров',
  separation: 'Разделение речи и фона',
  context: 'Контекст видео',
  translation: 'Перевод',
  voice_samples: 'Образцы голосов',
  synthesis: 'Синтез речи',
  shorten: 'Уточнение длины перевода',
  fit: 'Подгонка длительности речи',
  pauses: 'Обработка пауз',
  rendering: 'Подготовка плеера',
};

export interface LibraryItem {
  id: string;
  revision: number;
  title: string;
  status: string;
  source: Voiceover['source'];
  stages: Voiceover['stages'];
  created_at: string;
  storage_bytes: number;
  duration: number | null;
}
