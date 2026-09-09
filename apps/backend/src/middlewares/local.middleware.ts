import type { HttpMiddleware } from '@daevox/framework';
import type { AppState } from '../app-state.ts';
import { safeError } from '../telegram/connection.ts';

function localOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === value &&
      url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
export const localMiddleware: HttpMiddleware<AppState> = async (state, ctx, next) => {
  const headers = new Headers({ 'Cache-Control': 'no-store', Vary: 'Origin' });
  const host = ctx.headers.get('host') ?? '';
  const origin = ctx.headers.get('origin');
  if (
    !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/.test(host) ||
    (origin !== null && (!localOrigin(origin) || origin !== state.webClientOrigin))
  )
    return { status: 403, headers, body: { error: safeError('invalid_request') } };
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (ctx.method === 'OPTIONS') {
    const method = ctx.headers.get('access-control-request-method');
    const requested = ctx.headers.get('access-control-request-headers');
    if (
      (method && !['GET', 'POST'].includes(method)) ||
      (requested &&
        requested.split(',').some((header) => header.trim().toLowerCase() !== 'content-type'))
    )
      return { status: 403, headers };
    return { status: 204, headers };
  }
  const response = await next();
  const combined = new Headers(response.headers instanceof Headers ? response.headers : undefined);
  for (const [key, value] of headers) combined.set(key, value);
  return { ...response, headers: combined };
};
