import { types } from 'node:util';
import type {
  ScheduledTaskClass,
  ScheduledTaskOptions,
  ScheduledTasksOptions,
  ScheduledTaskErrorContext,
} from './ScheduledTaskBase.ts';
import { ScheduledTaskBase, ScheduledTaskShutdownTimeoutError } from './ScheduledTaskBase.ts';
import { nextScheduledTime, parseScheduledCron } from './scheduledCron.ts';
import type { ScheduledCron } from './scheduledCron.ts';

/** One registered schedule. / Одно зарегистрированное расписание. @private */
interface Registration<T extends object> {
  /** Task constructor. / Конструктор задачи. @private */
  taskClass: ScheduledTaskClass<T>;
  /** Metadata snapshot. / Снимок метаданных. @private */
  cron: ScheduledCron;
  /** Next absolute firing. / Следующее абсолютное срабатывание. @private */
  next: number;
  /** Unsettled execution. / Незавершённое выполнение. @private */
  active?: Promise<void>;
  /** Run cancellation source. / Источник отмены запуска. @private */
  abort?: AbortController;
  /** Already observed shutdown timeout. / Уже сообщённый тайм-аут завершения. @private */
  timedOut?: boolean;
}

/** Application-owned schedule lifecycle. / Жизненный цикл расписаний приложения. @private */
export class ScheduledTaskRuntime<T extends object> {
  /** Irreversible stop flag. / Необратимый флаг остановки. @private */
  #stopped = false;
  /** Registered classes. / Зарегистрированные классы. @private */
  #tasks = new Map<ScheduledTaskClass<T>, Registration<T>>();
  /** Pending wakeup. / Ожидаемое пробуждение. @private */
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** Runtime dependencies. / Зависимости выполнения. @private */
  #dependencies: ScheduledTaskOptions;
  /** Shared application state. / Общее состояние приложения. @private */
  #state: T;
  /** Shared shutdown budget. / Общий бюджет завершения. @private */
  #shutdownTimeout: number;
  /** Error observer. / Наблюдатель ошибок. @private */
  #onError: ScheduledTasksOptions['onError'];
  /** Captured process timezone. / Зафиксированный часовой пояс процесса. @private */
  #zone: Intl.DateTimeFormat | undefined;
  /** Initialize execution environment. / Инициализирует окружение выполнения. @private */
  constructor(state: T, dependencies: ScheduledTaskOptions, options: ScheduledTasksOptions = {}) {
    if (
      options === null ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Reflect.ownKeys(options).some((key) => key !== 'shutdownTimeout' && key !== 'onError')
    ) {
      throw new TypeError('Invalid scheduledTasks options');
    }
    const timeout = options.shutdownTimeout === undefined ? 30000 : options.shutdownTimeout;
    if (!Number.isSafeInteger(timeout) || timeout <= 0)
      throw new TypeError('Invalid scheduledTasks.shutdownTimeout');
    if (options.onError !== undefined && typeof options.onError !== 'function')
      throw new TypeError('Invalid scheduledTasks.onError');
    this.#state = state;
    this.#onError = options.onError;
    this.#shutdownTimeout = timeout;
    this.#dependencies = dependencies;
  }
  /** Validate and publish a declaration. / Проверяет и публикует объявление. @private */
  register(taskClass: ScheduledTaskClass<T>): void {
    if (
      typeof taskClass !== 'function' ||
      Object.getPrototypeOf(taskClass) !== ScheduledTaskBase ||
      typeof Object.getOwnPropertyDescriptor(taskClass.prototype, 'run')?.value !== 'function'
    ) {
      throw new TypeError('ScheduledTask requires direct inheritance, own cron and prototype run');
    }
    if (this.#tasks.has(taskClass)) throw new TypeError('ScheduledTask is already registered');
    const cron = parseScheduledCron(Object.getOwnPropertyDescriptor(taskClass, 'cron')?.value);
    const next = this.#zone ? nextScheduledTime(cron, Date.now(), this.#zone) : 0;
    this.#tasks.set(taskClass, { taskClass, cron, next });
    if (this.#zone) {
      clearTimeout(this.#timer);
      this.#arm();
    }
  }
  /** Activate future executions. / Активирует будущие запуски. @private */
  start(): void {
    this.#zone = new Intl.DateTimeFormat('en-GB', {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    for (const entry of this.#tasks.values())
      entry.next = nextScheduledTime(entry.cron, Date.now(), this.#zone);
    this.#arm();
  }
  /** Schedule the next wakeup. / Планирует следующее пробуждение. @private */
  #arm(): void {
    clearTimeout(this.#timer);
    if (this.#stopped || this.#tasks.size === 0) return;
    const next = Math.min(...[...this.#tasks.values()].map((entry) => entry.next));
    this.#timer = setTimeout(
      () => {
        const now = Date.now();
        for (const entry of this.#tasks.values()) {
          if (this.#stopped) break;
          if (entry.next > now) continue;
          entry.next = nextScheduledTime(entry.cron, now, this.#zone!);
          if (entry.active) continue;
          let phase: ScheduledTaskErrorContext['phase'] = 'constructor';
          try {
            entry.abort = new AbortController();
            const task = new entry.taskClass(this.#dependencies);
            phase = 'run';
            const operation = task.run(this.#state, { signal: entry.abort.signal });
            if (!types.isPromise(operation))
              throw new TypeError('ScheduledTask.run must return a Promise');
            entry.active = operation;
            operation.then(
              () => {
                entry.active = undefined;
                entry.abort = undefined;
              },
              (error) => {
                entry.abort = undefined;
                entry.active = undefined;
                if (!entry.timedOut) this.#report(error, entry, 'run');
              },
            );
          } catch (error) {
            entry.abort = undefined;
            this.#report(error, entry, phase);
          }
        }
        this.#arm();
      },
      Math.min(1000, Math.max(1, next - Date.now())),
    );
  }
  /** Report an execution failure. / Сообщает об ошибке выполнения. @private */
  #report(error: unknown, entry: Registration<T>, phase: ScheduledTaskErrorContext['phase']): void {
    const context = { taskClass: entry.taskClass, taskName: entry.taskClass.name, phase };
    try {
      if (this.#onError) Promise.resolve(this.#onError(error, context)).catch(console.error);
      else console.error(error, context);
    } catch (observerError) {
      console.error(observerError);
    }
  }
  /** Stop future executions. / Останавливает будущие запуски. @private */
  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
    for (const entry of this.#tasks.values()) entry.abort?.abort();
  }
  /** Wait for all active executions. / Ожидает все активные выполнения. @private */
  async close(): Promise<void> {
    const active = [...this.#tasks.values()].filter((entry) => entry.active);
    if (active.length === 0) return;
    let timer: ReturnType<typeof setTimeout>;
    await Promise.race([
      Promise.allSettled(active.map((entry) => entry.active)),
      new Promise<void>((resolve) => {
        let remaining = this.#shutdownTimeout;
        const arm = () => {
          const delay = Math.min(remaining, 2147483647);
          timer = setTimeout(() => {
            remaining -= delay;
            if (remaining > 0) arm();
            else resolve();
          }, delay);
        };
        arm();
      }),
    ]);
    clearTimeout(timer!);
    for (const entry of active) {
      if (!entry.active) continue;
      entry.timedOut = true;
      this.#report(
        new ScheduledTaskShutdownTimeoutError('ScheduledTask exceeded shutdownTimeout'),
        entry,
        'shutdown',
      );
    }
  }
}
