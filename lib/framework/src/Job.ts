import { InvalidJobError } from './errors.ts';

/** Context passed to a background job. / Контекст фоновой задачи. @public */
export interface JobContext {
  signal: AbortSignal;
}

/** Executable background-job method. / Исполняемый метод фоновой задачи. @public */
export type JobRun<Payload = unknown, Result = unknown> = (
  payload: Payload,
  context: JobContext,
) => Result | Promise<Result>;

/** Runtime-valid background-job class. / Валидный runtime-класс фоновой задачи. @public */
export type JobClass<Payload = unknown, Result = unknown> = {
  new (): Job;
  readonly metaUrl: string;
  readonly prototype: Job & { run: JobRun<Payload, Result> };
};

/**
 * Base class for user-defined background jobs executed in a worker thread.
 * Базовый класс пользовательских фоновых задач, выполняемых в потоке Worker.
 * A direct subclass must be the default export of its ESM module, declare its own
 * `static metaUrl = import.meta.url`, and implement an own `run(payload, context)` method.
 * Прямой подкласс должен экспортироваться из ESM-модуля по умолчанию, объявлять собственное
 * `static metaUrl = import.meta.url` и реализовывать собственный метод `run(payload, context)`.
 * @public
 * @abstract
 */
// oxlint-disable-next-line typescript/no-extraneous-class -- subclasses use this nominal runtime boundary
export class Job {
  /**
   * Enforces use through a concrete job subclass.
   * Запрещает создание экземпляра без конкретного подкласса задачи.
   * @throws {InvalidJobError} When `Job` is instantiated directly. / При прямом создании `Job`.
   * @protected
   */
  constructor() {
    if (new.target === Job) {
      throw new InvalidJobError('Job cannot be instantiated directly');
    }
  }
}
