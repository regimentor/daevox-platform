import { InvalidHttpControllerError } from './errors.ts';
import type { EventSender } from './EventSender.ts';
import type { JobRunner } from './JobRunner.ts';
import type { WebSocketSender } from './WebSocketSender.ts';

/** Dependencies supplied to an HTTP controller. / Зависимости HTTP-контроллера. @public */
export interface HttpControllerOptions {
  jobRunner: Pick<JobRunner, 'run' | 'close'>;
  websocket: Pick<WebSocketSender, 'send'>;
  events: Pick<EventSender, 'push'>;
}

/**
 * Base class for HTTP controllers registered with an {@link Application}.
 * Базовый класс HTTP-контроллеров, регистрируемых в {@link Application}.
 * Subclasses must declare their own static `prefix` and `routes` fields, may declare static
 * `middleware`, and must be registered through {@link Application#registerHttpController}. A fresh
 * instance is created only when the middleware chain reaches the handler.
 * Подклассы должны объявить собственные статические поля `prefix` и `routes`, могут объявить
 * статическое поле `middleware` и регистрируются через {@link Application#registerHttpController}.
 * Новый экземпляр создаётся, только когда цепочка middleware достигает обработчика.
 * @public
 * @abstract
 */
// oxlint-disable-next-line typescript/no-extraneous-class
export class HttpControllerBase {
  /** Application-owned job runner. / Принадлежащий приложению исполнитель задач. @public */
  declare jobRunner: Pick<JobRunner, 'run' | 'close'>;

  /** Application-wide WebSocket sender. / Общий sender WebSocket-приложения. @public */
  declare websocket: Pick<WebSocketSender, 'send'>;

  /** Application-wide event sender. / Общий sender внутренних событий. @public */
  declare events: Pick<EventSender, 'push'>;

  /**
   * Initializes the framework-owned dependencies exposed to an HTTP controller.
   * Инициализирует принадлежащие фреймворку зависимости HTTP-контроллера.
   * @param options Controller dependencies. / Зависимости HTTP-контроллера.
   * @throws {InvalidHttpControllerError} When the base class is instantiated directly or the
   * options are invalid. / Если базовый класс создан напрямую или параметры некорректны.
   * @protected
   */
  constructor(options: HttpControllerOptions | undefined = undefined) {
    if (new.target === HttpControllerBase) {
      throw new InvalidHttpControllerError('HttpControllerBase cannot be instantiated directly');
    }
    if (
      options === null ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Reflect.ownKeys(options).some(
        (key: any) => !['events', 'jobRunner', 'websocket'].includes(key),
      ) ||
      !Object.hasOwn(options, 'jobRunner') ||
      !Object.hasOwn(options, 'websocket') ||
      !Object.hasOwn(options, 'events') ||
      Reflect.ownKeys(options).length !== 3
    ) {
      throw new InvalidHttpControllerError(
        'HTTP controller options must contain exactly jobRunner, websocket, and events',
      );
    }
    Object.defineProperty(this, 'jobRunner', {
      value: options.jobRunner,
      enumerable: true,
    });
    Object.defineProperty(this, 'websocket', {
      value: options.websocket,
      enumerable: true,
    });
    Object.defineProperty(this, 'events', {
      value: options.events,
      enumerable: true,
    });
  }
}
