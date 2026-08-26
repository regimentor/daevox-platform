import { InvalidHttpControllerError } from './errors.js';

/**
 * Base class for HTTP controllers registered with an {@link Application}.
 * Базовый класс HTTP-контроллеров, регистрируемых в {@link Application}.
 *
 * Subclasses must declare their own static `prefix` and `routes` fields, may declare static
 * `middleware`, and must be registered through {@link Application#registerHttpController}. A fresh
 * instance is created only when the middleware chain reaches the handler.
 * Подклассы должны объявить собственные статические поля `prefix` и `routes`, могут объявить
 * статическое поле `middleware` и регистрируются через {@link Application#registerHttpController}.
 * Новый экземпляр создаётся, только когда цепочка middleware достигает обработчика.
 *
 * @public
 * @abstract
 */
// oxlint-disable-next-line typescript/no-extraneous-class
export class HttpControllerBase {
  /**
   * Initializes the framework-owned dependencies exposed to an HTTP controller.
   * Инициализирует принадлежащие фреймворку зависимости HTTP-контроллера.
   *
   * @param {ControllerOptions} options Controller dependencies. / Зависимости HTTP-контроллера.
   * @throws {InvalidHttpControllerError} When the base class is instantiated directly or the
   * options are invalid. / Если базовый класс создан напрямую или параметры некорректны.
   * @protected
   */
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

/**
 * Dependencies supplied to a transport controller instance.
 * Зависимости, передаваемые экземпляру транспортного контроллера.
 *
 * @typedef {Object} ControllerOptions
 * @property {JobRunner} jobRunner Application-owned job runner. / Принадлежащий приложению
 * исполнитель задач.
 * @private
 */
