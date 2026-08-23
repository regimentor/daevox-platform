/* oxlint-disable unicorn/require-post-message-target-origin -- MessagePort.postMessage has no targetOrigin */
import { parentPort } from 'node:worker_threads';

import { Job } from '../../../lib/framework/Job.js';

export default class ProtocolJob extends Job {
  static metaUrl = import.meta.url;

  async run(payload) {
    parentPort.postMessage({ id: payload.id, status: payload.status });
    await new Promise(() => {});
  }
}
