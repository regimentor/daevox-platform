/* oxlint-disable unicorn/require-post-message-target-origin -- Worker.postMessage has no targetOrigin */
import { Worker } from 'node:worker_threads';
import {
  JobAbortedError,
  JobDataCloneError,
  JobExecutionError,
  JobQueueFullError,
  JobTimedOutError,
  WorkerTerminatedError,
} from './errors.js';

/**

 * Restores a serialized worker error and its cause chain. / Восстанавливает сериализованную ошибку Worker и цепочку причин.

 *

 * @param {SerializedWorkerError} data Serialized error. / Сериализованная ошибка.

 * @returns {Error} Restored error. / Восстановленная ошибка.

 * @private

 */
function restoreError(data) {
  const error = new Error(
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
   * @type {boolean} Whether shutdown has started. / Началось ли закрытие.
   * @private
   */
  #closed = false;
  /**
   * @type {NormalizedJobRunnerConfig} Pool configuration. / Конфигурация пула.
   * @private
   */
  #config;
  /**
   * @type {number} Last allocated task identifier. / Последний идентификатор задачи.
   * @private
   */
  #nextId = 0;
  /**
   * @type {WorkerTask[]} FIFO task queue. / FIFO-очередь задач.
   * @private
   */
  #queue = [];
  /**
   * @type {Set<WorkerEntry>} Owned worker entries. / Записи принадлежащих работников.
   * @private
   */
  #workers = new Set();

  /**

   * Creates a worker pool. / Создаёт пул работников.

   *

   * @param {NormalizedJobRunnerConfig} config Pool limits and timeouts. / Ограничения и тайм-ауты.

   * @private

   */
  constructor(config) {
    this.#config = config;
  }

  /**

   * Schedules one structured-clone-compatible job. / Планирует одну задачу с данными для structured clone.

   *

   * @param {string} metaUrl Job module URL. / URL модуля задачи.

   * @param {*} payload Job input. / Входные данные.

   * @param {NormalizedJobRunOptions} options Cancellation and timeout. / Отмена и тайм-аут.

   * @returns {Promise<*>} Job result. / Результат задачи.

   * @private

   */
  run(metaUrl, payload, { signal, timeout }) {
    return new Promise((resolve, reject) => {
      let clonedPayload;
      try {
        clonedPayload = structuredClone(payload);
      } catch (cause) {
        reject(new JobDataCloneError('Job payload cannot be cloned', { cause }));
        return;
      }
      const task = {
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

   * @returns {Promise<void>} Shutdown completion. / Завершение закрытия.

   * @private

   */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const task of this.#queue.splice(0))
      this.#settle(task, new JobAbortedError('Job was aborted by shutdown'));
    const active = [...this.#workers].filter((entry) => entry.task);
    if (active.length) {
      let shutdownTimer;
      await Promise.race([
        Promise.all(active.map((entry) => entry.finished)),
        new Promise((resolve) => {
          shutdownTimer = setTimeout(resolve, this.#config.shutdownTimeout);
        }),
      ]);
      clearTimeout(shutdownTimer);
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

   * @returns {WorkerEntry} Worker entry. / Запись работника.

   * @private

   */
  #createWorker() {
    const entry = {
      worker: new Worker(new URL('./job-worker.js', import.meta.url)),
      task: undefined,
      terminating: false,
      finished: Promise.resolve(),
      finish: undefined,
    };
    this.#workers.add(entry);
    entry.worker.on('message', (message) => this.#onMessage(entry, message));
    entry.worker.on('error', () => {});
    entry.worker.on('exit', (code) => this.#onExit(entry, code));
    return entry;
  }

  /**

   * Assigns a task to an idle worker. / Назначает задачу свободному работнику.

   *

   * @param {WorkerEntry} entry Worker entry. / Запись работника.

   * @param {WorkerTask} task Task to start. / Запускаемая задача.

   * @private

   */
  #start(entry, task) {
    task.state = 'running';
    task.entry = entry;
    entry.task = task;
    entry.finished = new Promise((resolve) => {
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

   * @param {WorkerEntry} entry Worker entry. / Запись работника.

   * @param {WorkerResponseMessage} message Worker message. / Сообщение работника.

   * @private

   */
  #onMessage(entry, message) {
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
          cause: restoreError(message.error),
        }),
      );
    else if (message.status === 'error')
      this.#settle(
        task,
        new JobExecutionError('Job execution failed', { cause: restoreError(message.error) }),
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

   * @param {WorkerTask} task Task to cancel. / Отменяемая задача.

   * @param {Error} error Rejection error. / Ошибка отклонения.

   * @private

   */
  #cancel(task, error) {
    if (task.settled) return;
    if (task.state === 'queued') {
      const index = this.#queue.indexOf(task);
      if (index !== -1) this.#queue.splice(index, 1);
      this.#settle(task, error);
      return;
    }
    if (task.state === 'running') {
      this.#settle(task, error);
      task.entry.worker.postMessage({ type: 'cancel', id: task.id });
      task.graceHandle = setTimeout(() => {
        if (task.entry?.task === task) this.#terminateEntry(task.entry);
      }, this.#config.terminationGracePeriod);
    }
  }

  /**

   * Settles a task once and removes cancellation resources. / Однократно завершает задачу и очищает ресурсы отмены.

   *

   * @param {WorkerTask} task Task. / Задача.

   * @param {Error} [error] Rejection error. / Ошибка отклонения.

   * @param {*} [value] Resolution value. / Значение результата.

   * @private

   */
  #settle(task, error, value) {
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

   * @param {WorkerEntry} entry Worker entry. / Запись работника.

   * @private

   */
  #release(entry) {
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

   * @param {WorkerEntry} entry Worker entry. / Запись работника.

   * @param {number} code Exit code. / Код завершения.

   * @private

   */
  #onExit(entry, code) {
    this.#workers.delete(entry);
    if (entry.task) {
      this.#settle(entry.task, new WorkerTerminatedError(`Worker exited with code ${code}`));
      entry.task = undefined;
      entry.finish?.();
    }
    if (!this.#closed && this.#queue.length) this.#start(this.#createWorker(), this.#queue.shift());
  }

  /**

   * Rejects active work and terminates a protocol-violating worker. / Отклоняет активную работу и останавливает нарушившего протокол работника.

   *

   * @param {WorkerEntry} entry Worker entry. / Запись работника.

   * @param {string} message Failure description. / Описание сбоя.

   * @private

   */
  #terminateBrokenWorker(entry, message) {
    if (entry.task) this.#settle(entry.task, new WorkerTerminatedError(message));
    this.#terminateEntry(entry);
  }
  /**
   * Starts terminating one worker at most once. / Однократно начинает остановку работника.
   *
   * @param {WorkerEntry} entry Worker entry. / Запись работника.
   * @private
   */
  #terminateEntry(entry) {
    if (!entry.terminating) {
      entry.terminating = true;
      entry.worker.terminate();
    }
  }
}

/**
 * Serialized error transferred from a worker.
 * Сериализованная ошибка, передаваемая из Worker.
 *
 * @typedef {Object} SerializedWorkerError
 * @property {string} [name] Error name. / Имя ошибки.
 * @property {string} message Error message. / Сообщение ошибки.
 * @property {string} [stack] Error stack. / Стек ошибки.
 * @property {SerializedWorkerError} [cause] Serialized cause. / Сериализованная причина.
 * @private
 */

/**
 * Internal state of one scheduled job.
 * Внутреннее состояние одной запланированной задачи.
 *
 * @typedef {Object} WorkerTask
 * @property {number} id Task identifier. / Идентификатор задачи.
 * @property {string} metaUrl Job module URL. / URL модуля задачи.
 * @property {*} payload Cloned job input. / Клонированные входные данные.
 * @property {AbortSignal} [signal] Cancellation signal. / Сигнал отмены.
 * @property {Function} resolve Promise resolver. / Функция разрешения Promise.
 * @property {Function} reject Promise rejecter. / Функция отклонения Promise.
 * @property {boolean} settled Whether the promise settled. / Завершён ли Promise.
 * @property {'new'|'queued'|'running'} state Scheduling state. / Состояние планирования.
 * @property {WorkerEntry} [entry] Assigned worker. / Назначенный работник.
 * @property {Function} [abortListener] Abort listener. / Обработчик отмены.
 * @property {Timeout} [timeoutHandle] Timeout timer. / Таймер тайм-аута.
 * @property {Timeout} [graceHandle] Cancellation grace timer. / Таймер льготного периода.
 * @private
 */

/**
 * Internal state of one reusable worker.
 * Внутреннее состояние одного переиспользуемого работника.
 *
 * @typedef {Object} WorkerEntry
 * @property {Worker} worker Worker thread. / Поток Worker.
 * @property {WorkerTask} [task] Assigned task. / Назначенная задача.
 * @property {boolean} terminating Whether termination started. / Началась ли остановка.
 * @property {Promise<void>} finished Active-task completion. / Завершение активной задачи.
 * @property {Function} [finish] Completion resolver. / Функция завершения.
 * @private
 */

/**
 * Parent-to-worker run message.
 * Сообщение запуска от родителя к Worker.
 *
 * @typedef {Object} WorkerRunMessage
 * @property {'run'} type Message type. / Тип сообщения.
 * @property {number} id Task identifier. / Идентификатор задачи.
 * @property {string} metaUrl Job module URL. / URL модуля задачи.
 * @property {*} payload Job input. / Входные данные.
 * @private
 */

/**
 * Parent-to-worker cancellation message.
 * Сообщение отмены от родителя к Worker.
 *
 * @typedef {Object} WorkerCancelMessage
 * @property {'cancel'} type Message type. / Тип сообщения.
 * @property {number} id Task identifier. / Идентификатор задачи.
 * @private
 */

/**
 * Worker-to-parent completion message.
 * Сообщение завершения от Worker к родителю.
 *
 * @typedef {Object} WorkerResponseMessage
 * @property {number} id Task identifier. / Идентификатор задачи.
 * @property {'success'|'clone-error'|'error'} status Completion status. / Статус завершения.
 * @property {*} [result] Successful result. / Успешный результат.
 * @property {SerializedWorkerError} [error] Serialized failure. / Сериализованная ошибка.
 * @private
 */
