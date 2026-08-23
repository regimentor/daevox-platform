import { InvalidJobError } from './errors.js';

// oxlint-disable-next-line typescript/no-extraneous-class -- subclasses use this nominal runtime boundary
export class Job {
  constructor() {
    if (new.target === Job) {
      throw new InvalidJobError('Job cannot be instantiated directly');
    }
  }
}
