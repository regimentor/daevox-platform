/* oxlint-disable unicorn/require-post-message-target-origin -- Worker.postMessage has no targetOrigin */
import { Worker } from 'node:worker_threads';
import {
  JobAbortedError,
  JobDataCloneError,
  JobExecutionError,
  JobQueueFullError,
  JobTimedOutError,
  WorkerTerminatedError,
} from './errors.ts';
import type { NormalizedJobRunOptions, NormalizedJobRunnerConfig } from './JobRunner.ts';

/** Error representation received from a worker. / Представление ошибки, полученное от worker. @private */
interface SerializedWorkerError {
  name?: string;
  message: string;
  stack?: string;
  cause?: SerializedWorkerError;
}

/** One queued or active worker task. / Одна ожидающая или выполняемая задача worker. @private */
interface WorkerTask<Result = unknown> {
  id: number;
  metaUrl: string;
  payload: unknown;
  signal?: AbortSignal;
  resolve: (value: Result | PromiseLike<Result>) => void;
  reject: (reason?: unknown) => void;
  settled: boolean;
  state: 'new' | 'queued' | 'running';
  entry?: WorkerEntry;
  abortListener?: () => void;
  timeoutHandle?: NodeJS.Timeout;
  graceHandle?: NodeJS.Timeout;
}

/** Managed worker and its active task. / Управляемый worker и его активная задача. @private */
interface WorkerEntry {
  worker: Worker;
  task: WorkerTask<any> | undefined;
  terminating: boolean;
  finished: Promise<void>;
  finish: (() => void) | undefined;
}

/** Worker protocol response. / Ответ протокола worker. @private */
interface WorkerResponseMessage {
  id: number;
  status: 'success' | 'clone-error' | 'error';
  result?: unknown;
  error?: SerializedWorkerError;
}

/**

 * Restores a serialized worker error and its cause chain. / Восстанавливает сериализованную ошибку Worker и цепочку причин.

 *
 * @param data Serialized error. / Сериализованная ошибка.

 * @returns Restored error. / Восстановленная ошибка.

 * @private

 */
function restoreError(data: SerializedWorkerError): Error {
  const error: Error = new Error(
    data.message,
    data.cause ? { cause: restoreError(data.cause) } : undefined,
  );
  error.name = data.name ?? 'Error';
  if (data.stack) error.stack = data.stack;
  return error;
}

/**

 * Internal pool that schedules jobs across reusable worker threads. / Внутренний пул, распределяющий задачи между переиспользуемыми потоками Worker.

 *
 * @private

 */
export class WorkerPool {
  /**
   * Whether shutdown has started. / Началось ли закрытие.
   * @private
   */
  #closed = false;
  /**
   * Pool configuration. / Конфигурация пула.
   * @private
   */
  #config: NormalizedJobRunnerConfig;
  /**
   * Last allocated task identifier. / Последний идентификатор задачи.
   * @private
   */
  #nextId = 0;
  /**
   * FIFO task queue. / FIFO-очередь задач.
   * @private
   */
  #queue: WorkerTask<any>[] = [];
  /**
   * Owned worker entries. / Записи принадлежащих работников.
   * @private
   */
  #workers = new Set<WorkerEntry>();

  /**

   * Creates a worker pool. / Создаёт пул работников.

   *
   * @param config Pool limits and timeouts. / Ограничения и тайм-ауты.

   * @private

   */
  constructor(config: NormalizedJobRunnerConfig) {
    this.#config = config;
  }

  /**

   * Schedules one structured-clone-compatible job. / Планирует одну задачу с данными для structured clone.

   *
   * @param metaUrl Job module URL. / URL модуля задачи.

   * @param payload Job input. / Входные данные.

   * @param options Cancellation and timeout. / Отмена и тайм-аут.

   * @returns Job result. / Результат задачи.

   * @private

   */
  run<Result>(
    metaUrl: string,
    payload: unknown,
    { signal, timeout }: NormalizedJobRunOptions,
  ): Promise<Result> {
    return new Promise<Result>((resolve, reject) => {
      let clonedPayload: unknown;
      try {
        clonedPayload = structuredClone(payload);
      } catch (cause) {
        reject(new JobDataCloneError('Job payload cannot be cloned', { cause }));
        return;
      }
      const task: WorkerTask<Result> = {
        id: ++this.#nextId,
        metaUrl,
        payload: clonedPayload,
        signal,
        resolve,
        reject,
        settled: false,
        state: 'new',
      };
      if (signal?.aborted) {
        this.#settle(task, new JobAbortedError('Job was aborted'));
        return;
      }
      if (timeout === 0) {
        this.#settle(task, new JobTimedOutError('Job timed out'));
        return;
      }
      if (signal) {
        task.abortListener = () => this.#cancel(task, new JobAbortedError('Job was aborted'));
        signal.addEventListener('abort', task.abortListener, { once: true });
      }
      if (timeout !== undefined)
        task.timeoutHandle = setTimeout(
          () => this.#cancel(task, new JobTimedOutError('Job timed out')),
          timeout,
        );
      const idle = [...this.#workers].find((entry) => !entry.task && !entry.terminating);
      if (idle) this.#start(idle, task);
      else if (this.#workers.size < this.#config.poolSize) this.#start(this.#createWorker(), task);
      else if (this.#queue.length >= this.#config.queueSize)
        this.#settle(task, new JobQueueFullError('Job queue is full'));
      else {
        task.state = 'queued';
        this.#queue.push(task);
      }
    });
  }

  /**

   * Drains or aborts work within the shutdown timeout, then terminates workers. / Завершает или отменяет работу в пределах тайм-аута, затем останавливает работников.

   *
   * @returns Shutdown completion. / Завершение закрытия.

   * @private

   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const task of this.#queue.splice(0))
      this.#settle(task, new JobAbortedError('Job was aborted by shutdown'));
    const active = [...this.#workers].filter((entry) => entry.task);
    if (active.length) {
      let shutdownTimer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all(active.map((entry) => entry.finished)),
        new Promise<void>((resolve) => {
          shutdownTimer = setTimeout(resolve, this.#config.shutdownTimeout);
        }),
      ]);
      if (shutdownTimer) clearTimeout(shutdownTimer);
    }
    await Promise.all(
      [...this.#workers].map(async (entry) => {
        if (entry.task)
          this.#settle(
            entry.task,
            new WorkerTerminatedError('Worker was terminated during shutdown'),
          );
        entry.terminating = true;
        await entry.worker.terminate();
      }),
    );
    this.#workers.clear();
  }

  /**

   * Creates and wires one reusable worker. / Создаёт и подключает одного переиспользуемого работника.

   *
   * @returns Worker entry. / Запись работника.

   * @private

   */
  #createWorker(): WorkerEntry {
    const entry: WorkerEntry = {
      worker: new Worker(new URL('./job-worker.ts', import.meta.url)),
      task: undefined,
      terminating: false,
      finished: Promise.resolve(),
      finish: undefined,
    };
    this.#workers.add(entry);
    entry.worker.on('message', (message: WorkerResponseMessage) => this.#onMessage(entry, message));
    entry.worker.on('error', () => {});
    entry.worker.on('exit', (code) => this.#onExit(entry, code));
    return entry;
  }

  /**

   * Assigns a task to an idle worker. / Назначает задачу свободному работнику.

   *
   * @param entry Worker entry. / Запись работника.

   * @param task Task to start. / Запускаемая задача.

   * @private

   */
  #start(entry: WorkerEntry, task: WorkerTask<any>): void {
    task.state = 'running';
    task.entry = entry;
    entry.task = task;
    entry.finished = new Promise<void>((resolve) => {
      entry.finish = resolve;
    });
    entry.worker.postMessage({
      type: 'run',
      id: task.id,
      metaUrl: task.metaUrl,
      payload: task.payload,
    });
  }

  /**

   * Handles one job protocol response from a worker. / Обрабатывает один ответ протокола задач от работника.

   *
   * @param entry Worker entry. / Запись работника.

   * @param message Worker message. / Сообщение работника.

   * @private

   */
  #onMessage(entry: WorkerEntry, message: WorkerResponseMessage): void {
    const task = entry.task;
    if (!task || message.id !== task.id) {
      this.#terminateBrokenWorker(entry, 'Worker violated the job protocol');
      return;
    }
    if (message.status === 'success') this.#settle(task, undefined, message.result);
    else if (message.status === 'clone-error')
      this.#settle(
        task,
        new JobDataCloneError('Job result cannot be cloned', {
          cause: restoreError(message.error!),
        }),
      );
    else if (message.status === 'error')
      this.#settle(
        task,
        new JobExecutionError('Job execution failed', { cause: restoreError(message.error!) }),
      );
    else {
      this.#terminateBrokenWorker(entry, 'Worker returned an unknown job status');
      return;
    }
    this.#release(entry);
  }

  /**

   * Cancels a queued or running task. / Отменяет задачу в очереди или на выполнении.

   *
   * @param task Task to cancel. / Отменяемая задача.

   * @param error Rejection error. / Ошибка отклонения.

   * @private

   */
  #cancel(task: WorkerTask<any>, error: Error): void {
    if (task.settled) return;
    if (task.state === 'queued') {
      const index = this.#queue.indexOf(task);
      if (index !== -1) this.#queue.splice(index, 1);
      this.#settle(task, error);
      return;
    }
    if (task.state === 'running') {
      const entry = task.entry!;
      this.#settle(task, error);
      entry.worker.postMessage({ type: 'cancel', id: task.id });
      task.graceHandle = setTimeout(() => {
        if (entry.task === task) this.#terminateEntry(entry);
      }, this.#config.terminationGracePeriod);
    }
  }

  /**

   * Settles a task once and removes cancellation resources. / Однократно завершает задачу и очищает ресурсы отмены.

   *
   * @param task Task. / Задача.

   * @param [error] Rejection error. / Ошибка отклонения.

   * @param [value] Resolution value. / Значение результата.

   * @private

   */
  #settle(task: WorkerTask<any>, error?: Error, value?: unknown): void {
    if (task.settled) return;
    task.settled = true;
    clearTimeout(task.timeoutHandle);
    if (task.signal && task.abortListener)
      task.signal.removeEventListener('abort', task.abortListener);
    if (error) task.reject(error);
    else task.resolve(value);
  }

  /**

   * Releases a worker and starts the next queued task. / Освобождает работника и запускает следующую задачу из очереди.

   *
   * @param entry Worker entry. / Запись работника.

   * @private

   */
  #release(entry: WorkerEntry): void {
    const task = entry.task;
    if (task) {
      clearTimeout(task.graceHandle);
      task.entry = undefined;
    }
    entry.task = undefined;
    entry.finish?.();
    entry.finish = undefined;
    if (this.#closed) return;
    const next = this.#queue.shift();
    if (next) this.#start(entry, next);
  }

  /**

   * Handles worker termination and preserves queue progress. / Обрабатывает завершение работника и продолжает очередь.

   *
   * @param entry Worker entry. / Запись работника.

   * @param code Exit code. / Код завершения.

   * @private

   */
  #onExit(entry: WorkerEntry, code: number): void {
    this.#workers.delete(entry);
    if (entry.task) {
      this.#settle(entry.task, new WorkerTerminatedError(`Worker exited with code ${code}`));
      entry.task = undefined;
      entry.finish?.();
    }
    if (!this.#closed && this.#queue.length)
      this.#start(this.#createWorker(), this.#queue.shift()!);
  }

  /**

   * Rejects active work and terminates a protocol-violating worker. / Отклоняет активную работу и останавливает нарушившего протокол работника.

   *
   * @param entry Worker entry. / Запись работника.

   * @param message Failure description. / Описание сбоя.

   * @private

   */
  #terminateBrokenWorker(entry: WorkerEntry, message: string): void {
    if (entry.task) this.#settle(entry.task, new WorkerTerminatedError(message));
    this.#terminateEntry(entry);
  }
  /**
   * Starts terminating one worker at most once. / Однократно начинает остановку работника.
   * @param entry Worker entry. / Запись работника.
   * @private
   */
  #terminateEntry(entry: WorkerEntry): void {
    if (!entry.terminating) {
      entry.terminating = true;
      entry.worker.terminate();
    }
  }
}
