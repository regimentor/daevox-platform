export const base = '/trancription-api';
export class VoiceoverError extends Error {
  constructor(
    message: string,
    public code: string,
    public status?: number,
  ) {
    super(message);
  }
}
export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(base + path, options);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new VoiceoverError('Нет связи с сервисом перевода', 'network_error');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const detail = body?.detail;
    const code = detail?.code ?? (detail?.active ? 'busy' : `http_${response.status}`);
    const message =
      typeof detail === 'string'
        ? detail
        : (detail?.message ??
          (Array.isArray(detail)
            ? 'Проверьте источник: требуется видеофайл или ссылка на отдельную запись YouTube.'
            : `Сервис отклонил запрос (HTTP ${response.status})`));
    throw new VoiceoverError(message, code, response.status);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
export const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
