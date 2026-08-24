import { InvalidWebSocketControllerError } from './errors.js';

// oxlint-disable-next-line typescript/no-extraneous-class
export class WebSocketControllerBase {
  constructor(options) {
    if (new.target === WebSocketControllerBase) {
      throw new InvalidWebSocketControllerError(
        'WebSocketControllerBase cannot be instantiated directly',
      );
    }
    if (
      options === null ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Reflect.ownKeys(options).length !== 1 ||
      Reflect.ownKeys(options)[0] !== 'jobRunner'
    ) {
      throw new InvalidWebSocketControllerError(
        'WebSocket controller options must contain exactly jobRunner',
      );
    }
    Object.defineProperties(this, {
      jobRunner: { value: options.jobRunner, enumerable: true },
    });
  }
}
