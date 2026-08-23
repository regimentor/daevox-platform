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

function restoreError(data) {
  const error = new Error(
    data.message,
    data.cause ? { cause: restoreError(data.cause) } : undefined,
  );
  error.name = data.name ?? 'Error';
  if (data.stack) error.stack = data.stack;
  return error;
}

export class WorkerPool {
  #closed = false;
  #config;
  #nextId = 0;
  #queue = [];
  #workers = new Set();

  constructor(config) {
    this.#config = config;
  }

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

  #settle(task, error, value) {
    if (task.settled) return;
    task.settled = true;
    clearTimeout(task.timeoutHandle);
    if (task.signal && task.abortListener)
      task.signal.removeEventListener('abort', task.abortListener);
    if (error) task.reject(error);
    else task.resolve(value);
  }

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

  #onExit(entry, code) {
    this.#workers.delete(entry);
    if (entry.task) {
      this.#settle(entry.task, new WorkerTerminatedError(`Worker exited with code ${code}`));
      entry.task = undefined;
      entry.finish?.();
    }
    if (!this.#closed && this.#queue.length) this.#start(this.#createWorker(), this.#queue.shift());
  }

  #terminateBrokenWorker(entry, message) {
    if (entry.task) this.#settle(entry.task, new WorkerTerminatedError(message));
    this.#terminateEntry(entry);
  }
  #terminateEntry(entry) {
    if (!entry.terminating) {
      entry.terminating = true;
      entry.worker.terminate();
    }
  }
}
