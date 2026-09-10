import { setTimeout } from 'node:timers/promises';

export function isSqliteBusy(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error);
    if (
      'errcode' in error &&
      typeof error.errcode === 'number' &&
      [5, 6].includes(error.errcode & 255)
    )
      return true;
    error = 'cause' in error ? error.cause : null;
  }
  return false;
}

export async function retryBusy(action: () => void | Promise<void>, active = () => true) {
  for (let attempt = 0; active(); attempt++) {
    try {
      await action();
      return;
    } catch (error) {
      if (!isSqliteBusy(error) || attempt === 3) throw error;
      await setTimeout(100 * 3 ** attempt);
    }
  }
}
