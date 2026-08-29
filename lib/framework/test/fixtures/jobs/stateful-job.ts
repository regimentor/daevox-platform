import { Job } from '../../../src/Job.ts';

let instanceCount = 0;

export default class StatefulJob extends Job {
  static metaUrl = import.meta.url;

  #instanceNumber = ++instanceCount;

  run() {
    return this.#instanceNumber;
  }
}
