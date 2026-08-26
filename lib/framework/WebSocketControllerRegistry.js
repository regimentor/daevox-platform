import { InvalidWebSocketControllerError, WebSocketControllerConflictError } from './errors.js';
import { WebSocketControllerBase } from './WebSocketControllerBase.js';
import { snapshotDeclaredMiddleware } from './middleware.js';

/**

 * Valid controller and event wire-name syntax. / Допустимый синтаксис сетевых имён контроллеров и событий.

 *

 * @type {RegExp}

 * @private

 */
const WIRE_NAME = /^[A-Za-z0-9_-]+$/;

/**

 * Throws a normalized WebSocket-controller error. / Выбрасывает нормализованную ошибку WebSocket-контроллера.

 *

 * @param {string} message Error text. / Текст ошибки.

 * @throws {InvalidWebSocketControllerError} Always. / Всегда.

 * @private

 */
function invalid(message) {
  throw new InvalidWebSocketControllerError(message);
}

/**

 * Internal catalog of WebSocket controllers and their protocol events. / Внутренний каталог WebSocket-контроллеров и их событий протокола.

 *

 * @private

 */
export class WebSocketControllerRegistry {
  /**
   * @type {Map<string, WebSocketControllerEntry>} Controllers by wire name. / Контроллеры по сетевому имени.
   * @private
   */
  #controllers = new Map();

  /**

   * Validates and registers one WebSocket-controller class. / Проверяет и регистрирует один класс WebSocket-контроллера.

   *

   * @param {Function} WebSocketController Direct controller subclass. / Прямой подкласс контроллера.

   * @returns {void}

   * @private

   */
  register(WebSocketController) {
    if (
      typeof WebSocketController !== 'function' ||
      !WebSocketController.prototype ||
      Object.getPrototypeOf(WebSocketController.prototype) !== WebSocketControllerBase.prototype
    ) {
      invalid('WebSocket controller must directly extend WebSocketControllerBase');
    }
    const nameDescriptor = Object.getOwnPropertyDescriptor(WebSocketController, 'name');
    const eventsDescriptor = Object.getOwnPropertyDescriptor(WebSocketController, 'events');
    const name =
      nameDescriptor &&
      'value' in nameDescriptor &&
      nameDescriptor.writable &&
      nameDescriptor.enumerable
        ? nameDescriptor.value
        : undefined;
    const events =
      eventsDescriptor && 'value' in eventsDescriptor ? eventsDescriptor.value : undefined;
    const middleware = snapshotDeclaredMiddleware(
      WebSocketController,
      (message) => new InvalidWebSocketControllerError(message),
    );
    if (typeof name !== 'string' || !WIRE_NAME.test(name)) {
      invalid('WebSocket controller must have its own valid name');
    }
    if (!Array.isArray(events) || events.length === 0) {
      invalid('WebSocket controller must have its own non-empty events array');
    }
    const normalizedEvents = new Map();
    for (const event of events) {
      const keys =
        event !== null && typeof event === 'object' && !Array.isArray(event)
          ? Reflect.ownKeys(event)
          : [];
      if (
        event === null ||
        typeof event !== 'object' ||
        Array.isArray(event) ||
        !(
          (keys.length === 2 && keys.every((key) => ['handler', 'name'].includes(key))) ||
          (keys.length === 3 &&
            keys.every((key) => ['handler', 'middleware', 'name'].includes(key)))
        ) ||
        typeof event.name !== 'string' ||
        !WIRE_NAME.test(event.name) ||
        typeof event.handler !== 'string' ||
        event.handler === ''
      ) {
        invalid('WebSocket event must have exactly valid name and handler fields');
      }
      const handler = Object.getOwnPropertyDescriptor(WebSocketController.prototype, event.handler);
      if (event.handler === 'constructor' || !handler || typeof handler.value !== 'function') {
        invalid('WebSocket event handler must be an own instance method');
      }
      if (normalizedEvents.has(event.name)) {
        invalid('WebSocket event names must be unique within a controller');
      }
      normalizedEvents.set(
        event.name,
        Object.freeze({
          handler: event.handler,
          middleware: snapshotDeclaredMiddleware(
            event,
            (message) => new InvalidWebSocketControllerError(message),
          ),
        }),
      );
    }
    if (this.#controllers.has(name)) {
      throw new WebSocketControllerConflictError(`WebSocket controller conflicts with ${name}`);
    }
    this.#controllers.set(name, {
      controller: WebSocketController,
      middleware,
      events: normalizedEvents,
    });
  }

  /**

   * Resolves a protocol address to a controller and optional handler. / Разрешает адрес протокола в контроллер и необязательный обработчик.

   *

   * @param {string} controllerName Controller wire name. / Сетевое имя контроллера.

   * @param {string} eventName Event wire name. / Сетевое имя события.

   * @returns {WebSocketControllerResolution|null} Resolution or `null`. / Результат или `null`.

   * @private

   */
  resolve(controllerName, eventName) {
    const entry = this.#controllers.get(controllerName);
    if (!entry) return null;
    const event = entry.events.get(eventName);
    if (!event) return { controller: entry.controller };
    return {
      controller: entry.controller,
      controllerMiddleware: entry.middleware,
      eventMiddleware: event.middleware,
      handler: event.handler,
    };
  }
}

/**
 * Declarative WebSocket event metadata.
 * Декларативные метаданные WebSocket-события.
 *
 * @typedef {Object} WebSocketEventDeclaration
 * @property {string} name Event wire name. / Сетевое имя события.
 * @property {string} handler Own controller method name. / Имя собственного метода контроллера.
 * @property {WebSocketMessageMiddleware[]} [middleware] Event-level middleware. / Middleware уровня
 * WebSocket-события.
 * @public
 */

/**
 * Registered WebSocket-controller metadata.
 * Метаданные зарегистрированного WebSocket-контроллера.
 *
 * @typedef {Object} WebSocketControllerEntry
 * @property {Function} controller Controller class. / Класс контроллера.
 * @property {WebSocketMessageMiddleware[]} middleware Controller-level middleware. / Middleware
 * уровня WebSocket-контроллера.
 * @property {Map<string, WebSocketEventEntry>} events Events by name. / WebSocket-события по имени.
 * @private
 */

/**
 * Registered WebSocket-event metadata.
 * Метаданные зарегистрированного WebSocket-события.
 *
 * @typedef {Object} WebSocketEventEntry
 * @property {string} handler Handler method name. / Имя метода обработчика.
 * @property {WebSocketMessageMiddleware[]} middleware Event-level middleware. / Middleware уровня
 * WebSocket-события.
 * @private
 */

/**
 * WebSocket-controller lookup result.
 * Результат поиска WebSocket-контроллера.
 *
 * @typedef {Object} WebSocketControllerResolution
 * @property {Function} controller Controller class. / Класс контроллера.
 * @property {WebSocketMessageMiddleware[]} [controllerMiddleware] Controller middleware. /
 * Middleware WebSocket-контроллера.
 * @property {WebSocketMessageMiddleware[]} [eventMiddleware] Event middleware. / Middleware
 * WebSocket-события.
 * @property {string} [handler] Handler method name when the event exists. / Имя метода события.
 * @private
 */
