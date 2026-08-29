import { InvalidEventListenerError } from './errors.js';

/**
 * Base class for long-lived addressed application-event listeners.
 * Базовый класс долгоживущих слушателей адресуемых внутренних событий приложения.
 *
 * Direct subclasses declare their own static `name` and non-empty `events` array and are
 * registered through {@link Application#registerEventListener}.
 * Прямые подклассы объявляют собственные статические `name` и непустой массив `events` и
 * регистрируются через {@link Application#registerEventListener}.
 *
 * @public
 * @abstract
 */
// oxlint-disable-next-line typescript/no-extraneous-class
export class EventListenerBase {
  /**
   * Prevents direct construction of the abstract base.
   * Запрещает прямое создание абстрактного базового класса.
   *
   * @param {EventListenerDependencies} options Framework-owned dependencies. / Принадлежащие
   * фреймворку зависимости.
   * @throws {InvalidEventListenerError} When instantiated directly or options are invalid. / При
   * прямом создании или некорректных options.
   * @protected
   */
  constructor(options) {
    if (new.target === EventListenerBase) {
      throw new InvalidEventListenerError('EventListenerBase cannot be instantiated directly');
    }
    if (
      options === null ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Reflect.ownKeys(options).length !== 2 ||
      !Object.hasOwn(options, 'jobRunner') ||
      !Object.hasOwn(options, 'websocket')
    ) {
      throw new InvalidEventListenerError(
        'Event listener options must contain exactly jobRunner and websocket',
      );
    }
    Object.defineProperties(this, {
      jobRunner: { value: options.jobRunner, enumerable: true },
      websocket: { value: options.websocket, enumerable: true },
    });
  }
}

/**
 * Dependencies exposed to an event-listener instance.
 * Зависимости, доступные экземпляру слушателя событий.
 *
 * @typedef {Object} EventListenerDependencies
 * @property {JobRunner} jobRunner Application-owned job runner. / Принадлежащий приложению Job Runner.
 * @property {WebSocketSender} websocket Application-wide WebSocket sender. / Общий WebSocket sender.
 * @private
 */

/**
 * Handles one accepted application event.
 * Обрабатывает одно принятое внутреннее событие.
 *
 * @callback ApplicationEventHandler
 * @param {*} data Declared DTO instance passed by reference. / Экземпляр DTO, переданный по ссылке.
 * @param {Object} context Handler context. / Контекст handler.
 * @param {AbortSignal} context.signal Timeout and shutdown cancellation signal. / Сигнал отмены
 * timeout и shutdown.
 * @returns {*|Promise<*>} Ignored result; settlement preserves FIFO. / Игнорируемый результат;
 * settlement сохраняет FIFO.
 * @public
 */
