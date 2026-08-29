/* oxlint-disable unicorn/require-post-message-target-origin -- MessagePort.postMessage has no targetOrigin */
import { parentPort } from 'node:worker_threads';

import { Job } from '../../../src/Job.ts';

export default class ProtocolJob extends Job {
  static metaUrl = import.meta.url;

  async run(payload: any) {
    parentPort!.postMessage({ id: payload.id, status: payload.status });
    await new Promise<any>(() => {});
  }
}
