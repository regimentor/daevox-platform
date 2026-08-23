import { InvalidHttpControllerError } from './errors.js';

// oxlint-disable-next-line typescript/no-extraneous-class
export class HttpControllerBase {
  constructor(options) {
    if (new.target === HttpControllerBase) {
      throw new InvalidHttpControllerError('HttpControllerBase cannot be instantiated directly');
    }
    if (
      options === null ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Reflect.ownKeys(options).length !== 1 ||
      Reflect.ownKeys(options)[0] !== 'jobRunner'
    ) {
      throw new InvalidHttpControllerError(
        'HTTP controller options must contain exactly jobRunner',
      );
    }
    Object.defineProperty(this, 'jobRunner', {
      value: options.jobRunner,
      enumerable: true,
    });
  }
}
