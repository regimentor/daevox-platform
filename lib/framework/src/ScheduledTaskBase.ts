import type { AppStateInstance } from './Application.ts';
import type { HttpControllerOptions } from './HttpControllerBase.ts';

/** Dependencies of a scheduled task. / Зависимости запланированной задачи. @public */
export type ScheduledTaskOptions = HttpControllerOptions;
/** Cooperative execution context. / Контекст кооперативного выполнения. @public */
export interface ScheduledTaskContext {
  /** Cancellation at application close. / Отмена при закрытии приложения. @public */
  readonly signal: AbortSignal;
}
/** Registered task constructor. / Конструктор регистрируемой задачи. @public */
export type ScheduledTaskClass<TAppState extends object = AppStateInstance> = {
  new (options: ScheduledTaskOptions): ScheduledTaskBase & {
    run: (appState: TAppState, context: ScheduledTaskContext) => Promise<void>;
  };
  readonly cron: string;
};
/** Fresh instance for each scheduled execution. / Новый экземпляр для каждого запуска. @public */
export class ScheduledTaskBase {
  /** Worker execution capability. / Возможность выполнения в Worker. @public */
  declare readonly jobRunner: ScheduledTaskOptions['jobRunner'];
  /** Addressed event delivery. / Адресная доставка событий. @public */
  declare readonly events: ScheduledTaskOptions['events'];
  /** WebSocket delivery capability. / Возможность доставки WebSocket. @public */
  declare readonly websocket: ScheduledTaskOptions['websocket'];
  /** Initialize dependencies. / Инициализирует зависимости. @public */
  constructor(options: ScheduledTaskOptions) {
    if (new.target === ScheduledTaskBase)
      throw new TypeError('ScheduledTaskBase cannot be instantiated directly');
    if (
      options === null ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Reflect.ownKeys(options).length !== 3 ||
      !['jobRunner', 'events', 'websocket'].every((key) => Object.hasOwn(options, key))
    ) {
      throw new TypeError(
        'ScheduledTask dependencies must contain jobRunner, events and websocket',
      );
    }
    for (const key of ['jobRunner', 'events', 'websocket'] as const) {
      Object.defineProperty(this, key, { value: options[key], enumerable: true });
    }
  }
}

/** Execution failure identity. / Идентификация ошибки выполнения. @public */
export interface ScheduledTaskErrorContext {
  /** Registered constructor. / Зарегистрированный конструктор. @public */
  readonly taskClass: ScheduledTaskClass<any>;
  /** Diagnostic class name. / Диагностическое имя класса. @public */
  readonly taskName: string;
  /** Failure stage. / Этап ошибки. @public */
  readonly phase: 'constructor' | 'run' | 'shutdown';
}
/** Schedule lifecycle configuration. / Конфигурация жизненного цикла расписаний. @public */
export interface ScheduledTasksOptions {
  /** Shared grace period in milliseconds (default 30000). / Общий grace-период в миллисекундах (по умолчанию 30000). @public */
  shutdownTimeout?: number;
  /** Failure observer. / Наблюдатель ошибок. @public */
  onError?: (error: unknown, context: ScheduledTaskErrorContext) => unknown;
}

/** Scheduled execution exceeded its shutdown grace period. / Выполнение превысило grace-период завершения. @public */
export class ScheduledTaskShutdownTimeoutError extends Error {}
