import { threadId } from 'node:worker_threads';

import { Job } from '../../../lib/framework/Job.ts';

export default class SoakJob extends Job {
  static metaUrl = import.meta.url;

  async run({ delayMs, sequence }: any, { signal }: any) {
    await new Promise<any>((resolve: any) => {
      const timer = setTimeout(resolve, delayMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    return { aborted: signal.aborted, sequence, threadId };
  }
}
