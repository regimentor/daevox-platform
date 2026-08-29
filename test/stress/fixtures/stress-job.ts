import { threadId } from 'node:worker_threads';

import { Job } from '../../../lib/framework/Job.ts';

const sleeper = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export default class StressJob extends Job {
  static metaUrl = import.meta.url;

  run({ durationMs, gate, label, order, submittedAtNs }: any) {
    const startedAtNs = process.hrtime.bigint();
    if (gate) {
      const view = new Int32Array(gate);
      Atomics.add(view, 1, 1);
      Atomics.notify(view, 1);
      while (Atomics.load(view, 0) === 0) Atomics.wait(view, 0, 0, 100);
    } else if (durationMs > 0) {
      Atomics.wait(sleeper, 0, 0, durationMs);
    }
    const finishedAtNs = process.hrtime.bigint();
    return {
      executionMs: Number(finishedAtNs - startedAtNs) / 1_000_000,
      label,
      order: order ? Atomics.add(new Int32Array(order), 0, 1) : undefined,
      queueWaitMs: Number(startedAtNs - submittedAtNs) / 1_000_000,
      threadId,
    };
  }
}
