import { availableParallelism } from 'node:os';
import { Job } from './Job.js';
import { InvalidJobError, InvalidJobOptionsError, JobRunnerClosedError } from './errors.js';
import { WorkerPool } from './WorkerPool.js';

/**

 * Supported per-run option keys. / Поддерживаемые ключи запуска задачи.

 *

 * @type {Set<string>}

 * @private

 */
const OPTION_KEYS = new Set(['signal', 'timeout']);
/**
 * Supported job-runner configuration keys. / Поддерживаемые ключи конфигурации исполнителя задач.
 *
 * @type {Set<string>}
 * @private
 */
const CONFIG_KEYS = new Set([
  'poolSize',
  'queueSize',
  'defaultTimeout',
  'terminationGracePeriod',
  'shutdownTimeout',
]);
/**
 * Reads an own data-property without invoking accessors. / Читает собственное data-свойство без вызова аксессоров.
 *
 * @param {Object} object Owner. / Владелец.
 * @param {PropertyKey} property Property key. / Ключ свойства.
 * @returns {*} Stored value or `undefined`. / Значение или `undefined`.
 * @private
 */
function ownDataValue(object, property) {
  const descriptor = Object.getOwnPropertyDescriptor(object, property);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
/**
 * Throws an invalid-job-options error. / Выбрасывает ошибку параметров задачи.
 *
 * @param {string} message Error text. / Текст ошибки.
 * @throws {InvalidJobOptionsError} Always. / Всегда.
 * @private
 */
function invalid(message) {
  throw new InvalidJobOptionsError(message);
}
/**
 * Checks a non-negative finite millisecond timeout. / Проверяет неотрицательный конечный тайм-аут в миллисекундах.
 *
 * @param {*} value Candidate. / Проверяемое значение.
 * @returns {boolean} Validation result. / Результат проверки.
 * @private
 */
function isTimeout(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**

 * Validates and fills job-runner defaults. / Проверяет конфигурацию исполнителя задач и заполняет значения по умолчанию.

 *

 * @param {JobRunnerConfig} [config] User configuration. / Пользовательская конфигурация.

 * @returns {NormalizedJobRunnerConfig} Normalized configuration. / Нормализованная конфигурация.

 * @private

 */
function normalizeConfig(config = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config))
    invalid('jobs configuration must be an object');
  if (Reflect.ownKeys(config).some((key) => typeof key !== 'string' || !CONFIG_KEYS.has(key)))
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

 * @param {Function} JobClass Candidate class. / Проверяемый класс.

 * @returns {string} Absolute `file:` URL. / Абсолютный URL `file:`.

 * @private

 */
function validateJobClass(JobClass) {
  if (
    typeof JobClass !== 'function' ||
    !JobClass.prototype ||
    Object.getPrototypeOf(JobClass.prototype) !== Job.prototype
  )
    throw new InvalidJobError('Job class must directly extend Job');
  const metaUrl = ownDataValue(JobClass, 'metaUrl');
  let parsed;
  try {
    parsed = new URL(metaUrl);
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

 * @param {JobRunOptions} [options] Run options. / Параметры запуска.

 * @param {number} [defaultTimeout] Configured default timeout. / Тайм-аут по умолчанию.

 * @returns {NormalizedJobRunOptions} Normalized options. / Нормализованные параметры.

 * @private

 */
function validateOptions(options, defaultTimeout) {
  if (options === undefined) return { signal: undefined, timeout: defaultTimeout };
  if (options === null || typeof options !== 'object' || Array.isArray(options))
    invalid('Job options must be an object');
  if (Reflect.ownKeys(options).some((key) => typeof key !== 'string' || !OPTION_KEYS.has(key)))
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
 *
 * Controllers receive this component as `jobRunner`; applications do not construct it directly.
 * Контроллеры получают компонент как `jobRunner`; приложения не создают его напрямую.
 *
 * @private
 */
export class JobRunner {
  /**
   * @type {boolean} Whether new runs are rejected. / Отклоняются ли новые запуски.
   * @private
   */
  #closed = false;
  /**
   * @type {Promise<void>} Idempotent close operation. / Идемпотентное закрытие.
   * @private
   */
  #closePromise;
  /**
   * @type {NormalizedJobRunnerConfig} Normalized configuration. / Нормализованная конфигурация.
   * @private
   */
  #config;
  /**
   * @type {WorkerPool} Owned worker pool. / Принадлежащий пул работников.
   * @private
   */
  #workerPool;
  /**
   * Creates an application-owned job runner. / Создаёт принадлежащий приложению исполнитель задач.
   *
   * @param {JobRunnerConfig} [config] Job configuration. / Конфигурация задач.
   * @private
   */
  constructor(config) {
    this.#config = normalizeConfig(config);
    this.#workerPool = new WorkerPool(this.#config);
  }
  /**
   * Runs a validated job in the worker pool. / Выполняет проверенную задачу в пуле работников.
   *
   * @param {Function} JobClass Direct {@link Job} subclass. / Прямой подкласс {@link Job}.
   * @param {*} payload Structured-clone-compatible input. / Входные данные для structured clone.
   * @param {JobRunOptions} [options] Cancellation and timeout. / Отмена и тайм-аут.
   * @returns {Promise<*>} Job result. / Результат задачи.
   * @private
   */
  run(JobClass, payload, options) {
    const metaUrl = validateJobClass(JobClass);
    const normalized = validateOptions(options, this.#config.defaultTimeout);
    if (this.#closed) throw new JobRunnerClosedError('JobRunner is closed');
    return this.#workerPool.run(metaUrl, payload, normalized);
  }
  /**
   * Stops accepting jobs and closes the pool. / Прекращает приём задач и закрывает пул.
   *
   * @returns {Promise<void>} Shutdown completion. / Завершение закрытия.
   * @private
   */
  close() {
    if (!this.#closePromise) {
      this.#closed = true;
      this.#closePromise = this.#workerPool.close();
    }
    return this.#closePromise;
  }
}

/**
 * Background-job execution configuration.
 * Конфигурация выполнения фоновых задач.
 *
 * @typedef {Object} JobRunnerConfig
 * @property {number} [poolSize] Number of worker threads. / Количество потоков Worker.
 * @property {number} [queueSize=1000] Maximum queued jobs. / Максимум задач в очереди.
 * @property {number} [defaultTimeout] Default per-job timeout in milliseconds. / Тайм-аут задачи
 * по умолчанию.
 * @property {number} [terminationGracePeriod=1000] Cancellation grace period in milliseconds. /
 * Льготный период отмены.
 * @property {number} [shutdownTimeout=30000] Pool shutdown timeout in milliseconds. / Тайм-аут
 * закрытия пула.
 * @public
 */

/**
 * Normalized background-job configuration.
 * Нормализованная конфигурация фоновых задач.
 *
 * @typedef {Object} NormalizedJobRunnerConfig
 * @property {number} poolSize Number of worker threads. / Количество потоков Worker.
 * @property {number} queueSize Maximum queued jobs. / Максимум задач в очереди.
 * @property {number} [defaultTimeout] Default timeout. / Тайм-аут по умолчанию.
 * @property {number} terminationGracePeriod Cancellation grace period. / Льготный период отмены.
 * @property {number} shutdownTimeout Pool shutdown timeout. / Тайм-аут закрытия пула.
 * @private
 */

/**
 * Options for one background-job run.
 * Параметры одного запуска фоновой задачи.
 *
 * @typedef {Object} JobRunOptions
 * @property {AbortSignal} [signal] Caller cancellation signal. / Сигнал отмены вызывающей стороны.
 * @property {number} [timeout] Timeout in milliseconds. / Тайм-аут в миллисекундах.
 * @public
 */

/**
 * Normalized options for one background-job run.
 * Нормализованные параметры запуска фоновой задачи.
 *
 * @typedef {Object} NormalizedJobRunOptions
 * @property {AbortSignal} [signal] Cancellation signal. / Сигнал отмены.
 * @property {number} [timeout] Timeout in milliseconds. / Тайм-аут в миллисекундах.
 * @private
 */
