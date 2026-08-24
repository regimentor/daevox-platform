import { InvalidWebSocketControllerError } from './errors.js';

/**
 * Base class for named WebSocket protocol controllers.
 * Базовый класс именованных контроллеров WebSocket-протокола.
 *
 * Subclasses declare their own static `name` and `events` fields. A fresh instance is created for
 * every resolved protocol message.
 * Подклассы объявляют собственные статические поля `name` и `events`. Для каждого найденного
 * сообщения протокола создаётся новый экземпляр.
 *
 * @public
 * @abstract
 */
// oxlint-disable-next-line typescript/no-extraneous-class
export class WebSocketControllerBase {
  /**
   * Initializes the framework-owned dependencies exposed to a WebSocket controller.
   * Инициализирует принадлежащие фреймворку зависимости WebSocket-контроллера.
   *
   * @param {ControllerOptions} options Controller dependencies. / Зависимости контроллера.
   * @throws {InvalidWebSocketControllerError} When the base class is instantiated directly or the
   * options are invalid. / Если базовый класс создан напрямую или параметры некорректны.
   * @protected
   */
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
