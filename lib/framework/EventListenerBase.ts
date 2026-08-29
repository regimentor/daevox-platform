import { InvalidEventListenerError } from './errors.ts';
import type { JobRunner } from './JobRunner.ts';
import type { WebSocketSender } from './WebSocketSender.ts';

/** Dependencies supplied to an event listener. / Зависимости слушателя событий. @public */
export interface EventListenerDependencies {
  jobRunner: Pick<JobRunner, 'run' | 'close'>;
  websocket: Pick<WebSocketSender, 'send'>;
}

/** Context of one accepted application event. / Контекст принятого события. @public */
export interface ApplicationEventContext {
  signal: AbortSignal;
}

/** Handler of one accepted application event. / Обработчик принятого события. @public */
export type ApplicationEventHandler<Data = unknown> = (
  data: Data,
  context: ApplicationEventContext,
) => unknown | Promise<unknown>;

/**
 * Base class for long-lived addressed application-event listeners.
 * Базовый класс долгоживущих слушателей адресуемых внутренних событий приложения.
 * Direct subclasses declare their own static `name` and non-empty `events` array and are
 * registered through {@link Application#registerEventListener}.
 * Прямые подклассы объявляют собственные статические `name` и непустой массив `events` и
 * регистрируются через {@link Application#registerEventListener}.
 * @public
 * @abstract
 */
// oxlint-disable-next-line typescript/no-extraneous-class
export class EventListenerBase {
  /** Application-owned job runner. / Принадлежащий приложению исполнитель задач. @public */
  declare jobRunner: Pick<JobRunner, 'run' | 'close'>;

  /** Application-wide WebSocket sender. / Общий sender WebSocket-приложения. @public */
  declare websocket: Pick<WebSocketSender, 'send'>;

  /**
   * Prevents direct construction of the abstract base.
   * Запрещает прямое создание абстрактного базового класса.
   * @param options Framework-owned dependencies. / Принадлежащие
   * фреймворку зависимости.
   * @throws {InvalidEventListenerError} When instantiated directly or options are invalid. / При
   * прямом создании или некорректных options.
   * @protected
   */
  constructor(options: EventListenerDependencies | undefined = undefined) {
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
