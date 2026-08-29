import { InvalidWebSocketControllerError, WebSocketControllerConflictError } from './errors.ts';
import { WebSocketControllerBase } from './WebSocketControllerBase.ts';
import { snapshotDeclaredMiddleware } from './middleware.ts';
import type { WebSocketMessageMiddleware } from './Application.ts';
import type { WebSocketControllerOptions } from './WebSocketControllerBase.ts';

/** Declarative WebSocket event metadata. / Метаданные WebSocket-события. @public */
export interface WebSocketEventDeclaration {
  name: string;
  handler: string;
  middleware?: WebSocketMessageMiddleware[];
}

/** Constructable WebSocket controller. / Создаваемый WebSocket-контроллер. @private */
export type WebSocketControllerClass = {
  new (options: WebSocketControllerOptions): WebSocketControllerBase;
  readonly name: string;
  readonly events: readonly WebSocketEventDeclaration[];
  readonly middleware?: readonly WebSocketMessageMiddleware[];
};

/** Validated WebSocket-event entry. / Проверенная запись WebSocket-события. @private */
interface WebSocketEventEntry {
  handler: string;
  middleware: readonly WebSocketMessageMiddleware[];
}

/** Validated WebSocket-controller entry. / Проверенная запись WebSocket-контроллера. @private */
interface WebSocketControllerEntry {
  controller: WebSocketControllerClass;
  middleware: readonly WebSocketMessageMiddleware[];
  events: Map<string, WebSocketEventEntry>;
}

/** Result of controller-event resolution. / Результат поиска контроллера и события. @private */
export interface WebSocketControllerResolution {
  controller: WebSocketControllerClass;
  controllerMiddleware?: readonly WebSocketMessageMiddleware[];
  eventMiddleware?: readonly WebSocketMessageMiddleware[];
  handler?: string;
}

/**

 * Valid controller and event wire-name syntax. / Допустимый синтаксис сетевых имён контроллеров и событий.

 *
 * @private

 */
const WIRE_NAME = /^[A-Za-z0-9_-]+$/;

/**

 * Throws a normalized WebSocket-controller error. / Выбрасывает нормализованную ошибку WebSocket-контроллера.

 *
 * @param message Error text. / Текст ошибки.

 * @throws {InvalidWebSocketControllerError} Always. / Всегда.

 * @private

 */
function invalid(message: string): never {
  throw new InvalidWebSocketControllerError(message);
}

/**

 * Internal catalog of WebSocket controllers and their protocol events. / Внутренний каталог WebSocket-контроллеров и их событий протокола.

 *
 * @private

 */
export class WebSocketControllerRegistry {
  /**
   * Controllers by wire name. / Контроллеры по сетевому имени.
   * @private
   */
  #controllers = new Map<string, WebSocketControllerEntry>();

  /**

   * Validates and registers one WebSocket-controller class. / Проверяет и регистрирует один класс WebSocket-контроллера.

   *
   * @param WebSocketController Direct controller subclass. / Прямой подкласс контроллера.

   * @private

   */
  register(WebSocketController: WebSocketControllerClass): void {
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
      (message: any) => new InvalidWebSocketControllerError(message),
    );
    if (typeof name !== 'string' || !WIRE_NAME.test(name)) {
      invalid('WebSocket controller must have its own valid name');
    }
    if (!Array.isArray(events) || events.length === 0) {
      invalid('WebSocket controller must have its own non-empty events array');
    }
    const normalizedEvents = new Map<string, WebSocketEventEntry>();
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
          (keys.length === 2 && keys.every((key: any) => ['handler', 'name'].includes(key))) ||
          (keys.length === 3 &&
            keys.every((key: any) => ['handler', 'middleware', 'name'].includes(key)))
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
            (message: any) => new InvalidWebSocketControllerError(message),
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
   * @param controllerName Controller wire name. / Сетевое имя контроллера.

   * @param eventName Event wire name. / Сетевое имя события.

   * @returns Resolution or `null`. / Результат или `null`.

   * @private

   */
  resolve(controllerName: string, eventName: string): WebSocketControllerResolution | null {
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
