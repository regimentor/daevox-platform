import { InvalidWebSocketControllerError } from './errors.ts';
import type { EventSender } from './EventSender.ts';
import type { JobRunner } from './JobRunner.ts';

/** Dependencies supplied to a WebSocket controller. / Зависимости WebSocket-контроллера. @public */
export interface WebSocketControllerOptions {
  jobRunner: Pick<JobRunner, 'run' | 'close'>;
  events: Pick<EventSender, 'push'>;
}

/**
 * Base class for named WebSocket protocol controllers.
 * Базовый класс именованных контроллеров WebSocket-протокола.
 * Subclasses declare their own static `name` and `events` fields and may declare static
 * `middleware`. A fresh instance is created when a resolved message middleware chain reaches the
 * handler.
 * Подклассы объявляют собственные статические поля `name` и `events` и могут объявить статическое
 * поле `middleware`. Новый экземпляр создаётся, когда цепочка middleware найденного сообщения
 * достигает обработчика.
 * @public
 * @abstract
 */
// oxlint-disable-next-line typescript/no-extraneous-class
export class WebSocketControllerBase {
  /** Application-owned job runner. / Принадлежащий приложению исполнитель задач. @public */
  declare jobRunner: Pick<JobRunner, 'run' | 'close'>;

  /** Application-wide event sender. / Общий sender внутренних событий. @public */
  declare events: Pick<EventSender, 'push'>;

  /**
   * Initializes the framework-owned dependencies exposed to a WebSocket controller.
   * Инициализирует принадлежащие фреймворку зависимости WebSocket-контроллера.
   * @param options Controller dependencies. / Зависимости контроллера.
   * @throws {InvalidWebSocketControllerError} When the base class is instantiated directly or the
   * options are invalid. / Если базовый класс создан напрямую или параметры некорректны.
   * @protected
   */
  constructor(options: WebSocketControllerOptions | undefined = undefined) {
    if (new.target === WebSocketControllerBase) {
      throw new InvalidWebSocketControllerError(
        'WebSocketControllerBase cannot be instantiated directly',
      );
    }
    if (
      options === null ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Reflect.ownKeys(options).length !== 2 ||
      !Object.hasOwn(options, 'jobRunner') ||
      !Object.hasOwn(options, 'events')
    ) {
      throw new InvalidWebSocketControllerError(
        'WebSocket controller options must contain exactly jobRunner and events',
      );
    }
    Object.defineProperties(this, {
      jobRunner: { value: options.jobRunner, enumerable: true },
      events: { value: options.events, enumerable: true },
    });
  }
}
