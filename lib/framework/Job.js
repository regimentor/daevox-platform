import { InvalidJobError } from './errors.js';

/**
 * Base class for user-defined background jobs executed in a worker thread.
 * Базовый класс пользовательских фоновых задач, выполняемых в потоке Worker.
 *
 * A direct subclass must be the default export of its ESM module, declare its own
 * `static metaUrl = import.meta.url`, and implement an own `run(payload, context)` method.
 * Прямой подкласс должен экспортироваться из ESM-модуля по умолчанию, объявлять собственное
 * `static metaUrl = import.meta.url` и реализовывать собственный метод `run(payload, context)`.
 *
 * @public
 * @abstract
 */
// oxlint-disable-next-line typescript/no-extraneous-class -- subclasses use this nominal runtime boundary
export class Job {
  /**
   * Enforces use through a concrete job subclass.
   * Запрещает создание экземпляра без конкретного подкласса задачи.
   *
   * @throws {InvalidJobError} When `Job` is instantiated directly. / При прямом создании `Job`.
   * @protected
   */
  constructor() {
    if (new.target === Job) {
      throw new InvalidJobError('Job cannot be instantiated directly');
    }
  }
}

/**
 * Context passed to a job's `run` method as its second argument.
 * Контекст, передаваемый вторым аргументом в метод `run` задачи.
 *
 * @typedef {Object} JobContext
 * @property {AbortSignal} signal Signal aborted when execution is cancelled. / Сигнал,
 * отменяемый при прекращении выполнения.
 * @public
 */

/**
 * Executes a user-defined background job.
 * Выполняет пользовательскую фоновую задачу.
 *
 * @callback JobRun
 * @param {*} payload Structured-clone-compatible input. / Входные данные, совместимые со
 * structured clone.
 * @param {JobContext} context Execution context. / Контекст выполнения.
 * @returns {*|Promise<*>} Structured-clone-compatible result. / Результат, совместимый со
 * structured clone.
 * @public
 */
