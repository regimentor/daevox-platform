import { useState } from 'react';
import type { Translation, Voiceover } from './types';
import { duration } from './presentation';
import './DubbingPanel.css';

const steps: Record<string, string> = {
  pending: 'В очереди',
  translation: 'Перевод',
  synthesis: 'Синтез речи',
  comparison: 'Сравнение длительности',
  fit: 'Подгонка ускорением',
  shorten: 'Сокращение перевода',
  ready: 'Готово',
  conflict: 'Нужна правка',
  failed: 'Ошибка',
};
const sequence = ['translation', 'synthesis', 'comparison', 'fit', 'shorten'];
const seconds = (value?: number) =>
  value === undefined ? '—' : `${value.toFixed(2).replace('.', ',')} с`;
const speed = (value?: number) =>
  value === undefined ? '—' : `${value.toFixed(2).replace('.', ',')}×`;
function state(value?: Translation) {
  return (
    value?.step ??
    (value?.status === 'ready'
      ? 'ready'
      : value?.status === 'timing_conflict'
        ? 'conflict'
        : value?.status === 'failed'
          ? 'failed'
          : 'pending')
  );
}

export function DubbingPanel({
  record,
  pending,
  onRetry,
  onVoices,
}: {
  record: Voiceover;
  pending: boolean;
  onRetry: (id: string, text: string) => Promise<boolean>;
  onVoices: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [following, setFollowing] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [retryError, setRetryError] = useState(false);
  const phrase =
    record.transcript.find((p) => p.id === (following ? record.dubbing?.phrase_id : selected)) ??
    record.transcript[0];
  if (!phrase) return null;
  const byId = new Map(record.translations.map((t) => [t.id, t]));
  const value = byId.get(phrase.id);
  const currentStep = state(value);
  const ready = record.translations.filter((t) => t.status === 'ready').length;
  const failed = record.translations.filter((t) =>
    ['timing_conflict', 'failed'].includes(t.status),
  ).length;
  const active = ['preparing', 'synthesizing'].includes(record.status);
  const canRetry = ['completed', 'incomplete'].includes(record.status) && !pending && !saving;
  const speaker =
    record.speakers.find((s) => s.id === phrase.speaker_id)?.label ?? 'Неизвестный спикер';
  const scale = Math.max(
    value?.original_duration ?? phrase.end - phrase.start,
    value?.measured_duration ?? 0,
    value?.available_seconds ?? 0,
    value?.fitted_duration ?? 0,
    0.01,
  );
  function select(id: string) {
    setSelected(id);
    setFollowing(false);
    setEditing(null);
    setRetryError(false);
  }
  return (
    <section className="vd" aria-label="Озвучка фраз">
      <header className="vd-header">
        <div>
          <h3>Озвучка</h3>
          <span>
            {ready} из {record.transcript.length} фраз готовы
            {failed > 0 ? ` · ${failed} требуют внимания` : ''}
          </span>
        </div>
        <button onClick={onVoices}>Голоса спикеров</button>
      </header>
      <progress aria-label="Готовые фразы" value={ready} max={record.transcript.length} />
      <p className="vd-caption">
        Фраза готова после подгонки. Ускорение — до 1,5×, затем сокращение и повторный синтез.
      </p>
      <div className="vd-split">
        <div className="vd-queue" aria-label="Список фраз">
          <div className="vd-list-heading">
            <span>ФРАЗЫ</span>
            {active && (
              <button
                disabled={following}
                onClick={() => {
                  setFollowing(true);
                  setEditing(null);
                }}
              >
                Следить за текущей
              </button>
            )}
          </div>
          {record.transcript.map((p, index) => {
            const translation = byId.get(p.id);
            return (
              <button
                key={p.id}
                className={`vd-row ${phrase.id === p.id ? 'selected' : ''}`}
                aria-pressed={phrase.id === p.id}
                onClick={() => select(p.id)}
              >
                <span className="vd-number">
                  {translation?.status === 'ready' ? '✓' : String(index + 1).padStart(2, '0')}
                </span>
                <span className="vd-row-text">
                  <strong>{translation?.adapted_text || translation?.text || p.text}</strong>
                  <small>
                    {duration(p.start)}–{duration(p.end)}
                  </small>
                </span>
                <span className={`vd-status ${state(translation)}`}>
                  {steps[state(translation)] ?? translation?.status}
                </span>
              </button>
            );
          })}
        </div>
        <article className="vd-detail" aria-label="Детали фразы">
          <div className="vd-detail-heading">
            <span>
              ФРАЗА {record.transcript.indexOf(phrase) + 1} / {record.transcript.length}
            </span>
            <span>{speaker}</span>
          </div>
          <p className="vd-original">{phrase.text}</p>
          <p className="vd-translation">
            {value?.adapted_text ||
              value?.text ||
              (currentStep === 'translation'
                ? 'Переводим с учётом контекста ролика…'
                : currentStep === 'failed'
                  ? 'Перевод отсутствует'
                  : 'Перевод появится при обработке этой фразы.')}
          </p>
          {value?.full_text && value.full_text !== (value.adapted_text || value.text) && (
            <details>
              <summary>Полный перевод</summary>
              <p>{value.full_text}</p>
            </details>
          )}
          <div className="vd-loop" aria-label="Шаги обработки">
            {sequence.map((key, i) => (
              <span
                key={key}
                className={currentStep === key && active ? 'active' : ''}
                aria-current={currentStep === key ? 'step' : undefined}
              >
                {i === 4 ? '↶' : `0${i + 1}`} {steps[key]}
              </span>
            ))}
          </div>
          <div className="vd-metrics">
            <div>
              <small>Оригинальная фраза</small>
              <strong>{seconds(value?.original_duration ?? phrase.end - phrase.start)}</strong>
            </div>
            <div>
              <small>Доступное окно</small>
              <strong>{seconds(value?.available_seconds)}</strong>
            </div>
            <div>
              <small>
                Синтез · попытка{' '}
                {(['ready', 'timing_conflict'].includes(value?.status ?? '')
                  ? value?.selected_attempt
                  : value?.attempt) ?? '—'}
              </small>
              <strong>{seconds(value?.measured_duration)}</strong>
            </div>
          </div>
          <div className="vd-bars">
            {[
              {
                label: 'Оригинал',
                value: value?.original_duration ?? phrase.end - phrase.start,
                kind: 'original',
              },
              { label: 'Синтез', value: value?.measured_duration, kind: 'raw' },
              {
                label: 'После ускорения',
                value: value?.fitted_duration,
                kind: currentStep === 'conflict' ? 'conflict' : 'fitted',
              },
            ].map((bar) => (
              <div className="vd-bar" key={bar.label}>
                <span>{bar.label}</span>
                <div>
                  <i
                    className={bar.kind}
                    style={{ width: `${((bar.value ?? 0) / scale) * 100}%` }}
                  />
                </div>
                <b>{seconds(bar.value)}</b>
              </div>
            ))}
          </div>
          <div className={`vd-decision ${currentStep}`} aria-live="polite">
            <strong>
              {steps[currentStep] ?? currentStep}
              {value?.speed !== undefined ? ` · ${speed(value.speed)}` : ''}
            </strong>
            <p>
              {currentStep === 'conflict'
                ? 'После попыток сокращения фраза не поместилась. Полный аудиофрагмент сохранён; исправьте текст и повторите озвучку.'
                : currentStep === 'shorten'
                  ? 'Ускорения недостаточно. Сокращаем формулировку с сохранением смысла, затем синтезируем и измеряем заново.'
                  : currentStep === 'failed'
                    ? 'Не удалось получить перевод или аудиофрагмент. Можно ввести текст и повторить эту фразу после завершения обработки.'
                    : currentStep === 'ready'
                      ? 'Фраза уложилась в исходную временную шкалу.'
                      : 'Учитываем паузу до следующей фразы и накопленное отставание. Голоса не накладываются друг на друга.'}
            </p>
            {value?.lag_seconds !== undefined && (
              <small>Отставание в начале: {seconds(value.lag_seconds)}</small>
            )}
          </div>
          {value?.audio_asset && (
            <audio
              key={`${value.audio_asset}-${value.audio_cache_key}-${value.speed}`}
              controls
              preload="none"
              src={`${value.audio_asset}?version=${value.audio_cache_key ?? 'legacy'}-${value.speed ?? 1}`}
              aria-label="Озвученная фраза"
            />
          )}
          {!!value?.attempts?.length && (
            <details className="vd-history" open={currentStep === 'conflict' || undefined}>
              <summary>История попыток · {value.attempts.length}</summary>
              {value.attempts.map((a) => (
                <div key={a.number}>
                  <strong>
                    Попытка {a.number}
                    {value.selected_attempt === a.number ? ' · выбрана' : ''}
                  </strong>
                  <p>
                    {seconds(a.measured_duration)} → {seconds(a.fitted_duration)} при{' '}
                    {speed(a.speed)} · {a.fits ? 'Уложилась' : 'Не помещается'}
                  </p>
                  <p>{a.text}</p>
                </div>
              ))}
            </details>
          )}
          {value && ['completed', 'incomplete'].includes(record.status) && (
            <div className="vd-edit">
              <label htmlFor={`phrase-edit-${phrase.id}`}>Текст озвучки</label>
              <textarea
                id={`phrase-edit-${phrase.id}`}
                value={editing ?? value.adapted_text ?? value.text}
                onChange={(e) => setEditing(e.target.value)}
              />
              <button
                disabled={!canRetry || !(editing ?? value.adapted_text ?? value.text).trim()}
                onClick={async () => {
                  setSaving(true);
                  setRetryError(false);
                  try {
                    const ok = await onRetry(
                      phrase.id,
                      (editing ?? value.adapted_text ?? value.text).trim(),
                    );
                    setRetryError(!ok);
                    if (ok) setEditing(null);
                  } catch {
                    setRetryError(true);
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                {saving ? 'Запускаем…' : 'Повторить эту фразу'}
              </button>
              {retryError && (
                <p role="alert">
                  Не удалось запустить повтор. Проверьте сообщение об ошибке и попробуйте ещё раз.
                </p>
              )}
            </div>
          )}
        </article>
      </div>
    </section>
  );
}
