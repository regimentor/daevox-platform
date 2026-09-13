import OpenAI from 'openai';
import { ArchiveDatabase } from '@daevox/db';
import { runDailySummary } from './daily-summary.ts';
import { retryBusy } from './retry-busy.ts';

export async function processSummaryQueue(
  url: string,
  signal: AbortSignal,
  limit = Infinity,
): Promise<void> {
  signal.throwIfAborted();
  const db = new ArchiveDatabase(url);
  try {
    await retryBusy(
      () => db.recoverDailySummaries(),
      () => !signal.aborted,
    );
    const client = new OpenAI({
      baseURL: process.env.LLAMA_BASE_URL ?? 'http://127.0.0.1:3188/v1',
      apiKey: process.env.LLAMA_API_KEY ?? 'local-llama',
      timeout: 180000,
      maxRetries: 0,
    });
    while (!signal.aborted && limit-- > 0) {
      const job = db.nextDailySummary();
      if (!job) break;
      await retryBusy(
        () => runDailySummary(db, job, client, signal),
        () => !signal.aborted,
      );
    }
  } finally {
    db.close();
  }
}
