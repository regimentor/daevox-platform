import { InvalidHttpControllerError } from './errors.js';

// oxlint-disable-next-line typescript/no-extraneous-class
export class HttpControllerBase {
  constructor() {
    if (new.target === HttpControllerBase) {
      throw new InvalidHttpControllerError('HttpControllerBase cannot be instantiated directly');
    }
  }
}
