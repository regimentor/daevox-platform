import { threadId } from 'node:worker_threads';

import { Job } from '../../../lib/framework/Job.js';

export default class SoakJob extends Job {
  static metaUrl = import.meta.url;

  async run({ delayMs, sequence }, { signal }) {
    await new Promise((resolve) => {
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
