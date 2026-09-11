import type { Translation } from './types';
import { useEffect, useState } from 'react';

export function TranslationText({
  value,
  onRetry,
}: {
  value?: Translation;
  onRetry?: (id: string, adaptedText: string) => Promise<boolean>;
}) {
  const [adapted, setAdapted] = useState(value?.adapted_text ?? value?.text ?? '');
  const [pending, setPending] = useState(false);
  useEffect(() => setAdapted(value?.adapted_text ?? value?.text ?? ''), [value]);
  const full = value?.full_text ?? value?.text;
  return (
    <div>
      <strong>
        {full || (value?.status === 'failed' ? 'Перевод отсутствует' : 'Перевод готовится…')}
      </strong>
      {value && value.adapted_text !== undefined && value.adapted_text !== full && (
        <p>
          <small>Текст озвучки: {value.adapted_text}</small>
        </p>
      )}
      {value?.status === 'timing_conflict' && (
        <div>
          <p>Фраза не помещается в исходное временное окно.</p>
          {value.audio_asset && <a href={value.audio_asset}>Прослушать проблемную фразу</a>}
          {onRetry && (
            <>
              <label>
                Текст озвучки
                <textarea
                  value={adapted}
                  onChange={(event) => setAdapted(event.currentTarget.value)}
                />
              </label>
              <button
                disabled={pending || !adapted.trim()}
                onClick={() => {
                  setPending(true);
                  void onRetry(value.id, adapted.trim()).finally(() => setPending(false));
                }}
              >
                Повторить эту фразу
              </button>
            </>
          )}
        </div>
      )}
      {value?.warnings?.map((warning, index) => (
        <p
          key={`${warning.code}-${index}`}
          style={{ color: 'var(--mantine-color-yellow-8)', fontSize: 12, margin: '4px 0' }}
        >
          ⚠ {warning.message}
        </p>
      ))}
    </div>
  );
}
