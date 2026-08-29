import { availableParallelism } from 'node:os';
import { Job } from './Job.ts';
import type { JobClass } from './Job.ts';
import { InvalidJobError, InvalidJobOptionsError, JobRunnerClosedError } from './errors.ts';
import { WorkerPool } from './WorkerPool.ts';

/**

 * Supported per-run option keys. / Поддерживаемые ключи запуска задачи.

 *
 * @private

 */
const OPTION_KEYS = new Set(['signal', 'timeout']);
/**
 * Supported job-runner configuration keys. / Поддерживаемые ключи конфигурации исполнителя задач.
 * @private
 */
const CONFIG_KEYS = new Set([
  'poolSize',
  'queueSize',
  'defaultTimeout',
  'terminationGracePeriod',
  'shutdownTimeout',
]);

/** Background-job execution configuration. / Конфигурация выполнения фоновых задач. @public */
export interface JobRunnerConfig {
  poolSize?: number;
  queueSize?: number;
  defaultTimeout?: number;
  terminationGracePeriod?: number;
  shutdownTimeout?: number;
}

/** Options for one background-job run. / Параметры запуска фоновой задачи. @public */
export interface JobRunOptions {
  signal?: AbortSignal;
  timeout?: number;
}

/** Validated job-runner configuration. / Проверенная конфигурация исполнителя задач. @private */
export interface NormalizedJobRunnerConfig {
  poolSize: number;
  queueSize: number;
  defaultTimeout: number | undefined;
  terminationGracePeriod: number;
  shutdownTimeout: number;
}

/** Validated options for one job run. / Проверенные параметры одного запуска задачи. @private */
export interface NormalizedJobRunOptions {
  signal: AbortSignal | undefined;
  timeout: number | undefined;
}
/**
 * Reads an own data-property without invoking accessors. / Читает собственное data-свойство без вызова аксессоров.
 * @param object Owner. / Владелец.
 * @param property Property key. / Ключ свойства.
 * @returns Stored value or `undefined`. / Значение или `undefined`.
 * @private
 */
function ownDataValue(object: object, property: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, property);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
/**
 * Throws an invalid-job-options error. / Выбрасывает ошибку параметров задачи.
 * @param message Error text. / Текст ошибки.
 * @throws {InvalidJobOptionsError} Always. / Всегда.
 * @private
 */
function invalid(message: string): never {
  throw new InvalidJobOptionsError(message);
}
/**
 * Checks a non-negative finite millisecond timeout. / Проверяет неотрицательный конечный тайм-аут в миллисекундах.
 * @param value Candidate. / Проверяемое значение.
 * @returns Validation result. / Результат проверки.
 * @private
 */
function isTimeout(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**

 * Validates and fills job-runner defaults. / Проверяет конфигурацию исполнителя задач и заполняет значения по умолчанию.

 *
 * @param [config] User configuration. / Пользовательская конфигурация.

 * @returns Normalized configuration. / Нормализованная конфигурация.

 * @private

 */
function normalizeConfig(config: JobRunnerConfig = {}): NormalizedJobRunnerConfig {
  if (config === null || typeof config !== 'object' || Array.isArray(config))
    invalid('jobs configuration must be an object');
  if (Reflect.ownKeys(config).some((key: any) => typeof key !== 'string' || !CONFIG_KEYS.has(key)))
    invalid('jobs configuration contains an unknown field');
  const result = {
    poolSize: config.poolSize ?? availableParallelism(),
    queueSize: config.queueSize ?? 1000,
    defaultTimeout: config.defaultTimeout,
    terminationGracePeriod: config.terminationGracePeriod ?? 1000,
    shutdownTimeout: config.shutdownTimeout ?? 30000,
  };
  if (!Number.isInteger(result.poolSize) || result.poolSize <= 0) invalid('poolSize is invalid');
  if (!Number.isInteger(result.queueSize) || result.queueSize < 0) invalid('queueSize is invalid');
  if (result.defaultTimeout !== undefined && !isTimeout(result.defaultTimeout))
    invalid('defaultTimeout is invalid');
  if (!isTimeout(result.terminationGracePeriod)) invalid('terminationGracePeriod is invalid');
  if (!isTimeout(result.shutdownTimeout)) invalid('shutdownTimeout is invalid');
  return result;
}

/**

 * Validates a user job class and returns its module URL. / Проверяет пользовательский класс задачи и возвращает URL его модуля.

 *
 * @param JobClass Candidate class. / Проверяемый класс.

 * @returns Absolute `file:` URL. / Абсолютный URL `file:`.

 * @private

 */
function validateJobClass(JobClass: JobClass<any, any>): string {
  if (
    typeof JobClass !== 'function' ||
    !JobClass.prototype ||
    Object.getPrototypeOf(JobClass.prototype) !== Job.prototype
  )
    throw new InvalidJobError('Job class must directly extend Job');
  const metaUrl = ownDataValue(JobClass, 'metaUrl');
  let parsed: any;
  try {
    parsed = new URL(metaUrl as string);
  } catch {
    throw new InvalidJobError('Job class must have its own absolute file metaUrl');
  }
  if (parsed.protocol !== 'file:')
    throw new InvalidJobError('Job class must have its own absolute file metaUrl');
  if (typeof ownDataValue(JobClass.prototype, 'run') !== 'function')
    throw new InvalidJobError('Job class must have its own instance run method');
  return parsed.href;
}

/**

 * Validates options for one job run. / Проверяет параметры одного запуска задачи.

 *
 * @param [options] Run options. / Параметры запуска.

 * @param [defaultTimeout] Configured default timeout. / Тайм-аут по умолчанию.

 * @returns Normalized options. / Нормализованные параметры.

 * @private

 */
function validateOptions(
  options?: JobRunOptions,
  defaultTimeout?: number,
): NormalizedJobRunOptions {
  if (options === undefined) return { signal: undefined, timeout: defaultTimeout };
  if (options === null || typeof options !== 'object' || Array.isArray(options))
    invalid('Job options must be an object');
  if (Reflect.ownKeys(options).some((key: any) => typeof key !== 'string' || !OPTION_KEYS.has(key)))
    invalid('Job options contain an unknown field');
  const { signal, timeout = defaultTimeout } = options;
  if (signal !== undefined && !(signal instanceof AbortSignal))
    invalid('signal must be an AbortSignal');
  if (timeout !== undefined && !isTimeout(timeout)) invalid('timeout is invalid');
  return { signal, timeout };
}

/**
 * Application-owned gateway for executing user jobs in the internal worker pool.
 * Принадлежащий приложению шлюз выполнения пользовательских задач во внутреннем пуле работников.
 * Controllers receive this component as `jobRunner`; applications do not construct it directly.
 * Контроллеры получают компонент как `jobRunner`; приложения не создают его напрямую.
 * @private
 */
export class JobRunner {
  /**
   * Whether new runs are rejected. / Отклоняются ли новые запуски.
   * @private
   */
  #closed = false;
  /**
   * Idempotent close operation. / Идемпотентное закрытие.
   * @private
   */
  #closePromise: Promise<void> | undefined;
  /**
   * Normalized configuration. / Нормализованная конфигурация.
   * @private
   */
  #config: NormalizedJobRunnerConfig;
  /**
   * Owned worker pool. / Принадлежащий пул работников.
   * @private
   */
  #workerPool: WorkerPool;
  /**
   * Creates an application-owned job runner. / Создаёт принадлежащий приложению исполнитель задач.
   * @param [config] Job configuration. / Конфигурация задач.
   * @private
   */
  constructor(config?: JobRunnerConfig) {
    this.#config = normalizeConfig(config);
    this.#workerPool = new WorkerPool(this.#config);
  }
  /**
   * Runs a validated job in the worker pool. / Выполняет проверенную задачу в пуле работников.
   * @param JobClass Direct {@link Job} subclass. / Прямой подкласс {@link Job}.
   * @param payload Structured-clone-compatible input. / Входные данные для structured clone.
   * @param [options] Cancellation and timeout. / Отмена и тайм-аут.
   * @returns Job result. / Результат задачи.
   * @private
   */
  run<Payload = undefined, Result = unknown>(
    JobClass: JobClass<Payload, Result>,
    payload: Payload = undefined as Payload,
    options?: JobRunOptions,
  ): Promise<Result> {
    const metaUrl = validateJobClass(JobClass);
    const normalized = validateOptions(options, this.#config.defaultTimeout);
    if (this.#closed) throw new JobRunnerClosedError('JobRunner is closed');
    return this.#workerPool.run(metaUrl, payload, normalized);
  }
  /**
   * Stops accepting jobs and closes the pool. / Прекращает приём задач и закрывает пул.
   * @returns Shutdown completion. / Завершение закрытия.
   * @private
   */
  close(): Promise<void> {
    if (!this.#closePromise) {
      this.#closed = true;
      this.#closePromise = this.#workerPool.close();
    }
    return this.#closePromise;
  }
}
