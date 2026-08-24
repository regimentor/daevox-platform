import { Job } from '../../../lib/framework/Job.js';

export default class CpuBenchmarkJob extends Job {
  static metaUrl = import.meta.url;

  run({ delayMs, iterations, submittedAtNs }) {
    const startedAtNs = process.hrtime.bigint();
    let checksum = 0;
    for (let index = 0; index < iterations; index += 1) {
      checksum = Math.imul(checksum ^ index, 2_654_435_761) >>> 0;
    }
    if (delayMs > 0) {
      const delayNs = BigInt(Math.floor(delayMs * 1_000_000));
      while (process.hrtime.bigint() - startedAtNs < delayNs) checksum ^= 1;
    }
    const finishedAtNs = process.hrtime.bigint();
    return { checksum, finishedAtNs, startedAtNs, submittedAtNs };
  }
}
