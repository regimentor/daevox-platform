import type { Translation } from './types';

export function TranslationText({ value }: { value?: Translation }) {
  return (
    <div>
      <strong>
        {value?.text || (value?.status === 'failed' ? 'Перевод отсутствует' : 'Перевод готовится…')}
      </strong>
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
