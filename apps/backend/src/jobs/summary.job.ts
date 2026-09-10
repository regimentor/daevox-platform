import { Job, type JobContext } from '@daevox/framework';
import { processSummaryQueue } from '../domain/secretary/summary-queue.ts';

export default class SummaryJob extends Job {
  static metaUrl = import.meta.url;

  async run(
    { url, limit }: { url: string; limit?: number },
    { signal }: JobContext,
  ): Promise<void> {
    await processSummaryQueue(url, signal, limit);
  }
}
