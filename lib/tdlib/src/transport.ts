/* oxlint-disable unicorn/require-post-message-target-origin -- Worker.postMessage has no targetOrigin. */
import { Worker } from 'node:worker_threads';

export interface TransportMessage {
  readonly kind: 'response' | 'update';
  readonly clientId: string;
  readonly requestId?: string;
  readonly payload: unknown;
}

export interface TransportClientHandlers {
  readonly onMessage: (message: TransportMessage) => void;
  readonly onFatal: (error: Error) => void;
}

export interface TdlibTransport {
  start(
    clientId: string,
    libraryPath: string,
    receiveTimeoutMs: number,
    handlers: TransportClientHandlers,
  ): Promise<void>;
  send(clientId: string, requestId: string, request: object): void;
  destroy(clientId: string): Promise<void>;
}

interface ClientRecord {
  handlers: TransportClientHandlers;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
  destroyWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }>;
}

/** Shared native transport backed by one worker for the whole process. / Один worker-backed transport для всего процесса. @private */
class WorkerTransport implements TdlibTransport {
  private worker: Worker | undefined;
  private readonly clients = new Map<string, ClientRecord>();

  async start(
    clientId: string,
    libraryPath: string,
    receiveTimeoutMs: number,
    handlers: TransportClientHandlers,
  ): Promise<void> {
    if (this.clients.has(clientId))
      throw new Error(`TDLib client ${clientId} is already registered`);
    const record = {} as ClientRecord;
    record.handlers = handlers;
    record.destroyWaiters = [];
    record.ready = new Promise<void>((resolve, reject) => {
      record.resolveReady = resolve;
      record.rejectReady = reject;
    });
    this.clients.set(clientId, record);
    this.ensureWorker();
    this.worker!.postMessage({ kind: 'init', clientId, libraryPath, receiveTimeoutMs });
    try {
      await record.ready;
    } catch (error) {
      this.clients.delete(clientId);
      throw error;
    }
  }

  send(clientId: string, requestId: string, request: object): void {
    if (!this.worker || !this.clients.has(clientId)) throw new Error('TDLib worker is not running');
    this.worker.postMessage({ kind: 'send', clientId, requestId, request });
  }

  destroy(clientId: string): Promise<void> {
    const record = this.clients.get(clientId);
    if (!record || !this.worker) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      record.destroyWaiters.push({ resolve, reject });
      this.worker!.postMessage({ kind: 'destroy', clientId });
    });
  }

  private ensureWorker(): void {
    if (this.worker) return;
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      execArgv: process.execArgv,
    });
    this.worker = worker;
    worker.on(
      'message',
      (message: {
        kind: string;
        clientId?: string;
        error?: { message: string };
        payload?: unknown;
        requestId?: string;
      }) => {
        if (!message.clientId) return;
        const record = this.clients.get(message.clientId);
        if (!record) return;
        if (message.kind === 'ready') record.resolveReady();
        else if (message.kind === 'destroyed') {
          this.clients.delete(message.clientId);
          for (const waiter of record.destroyWaiters.splice(0)) waiter.resolve();
          if (!this.clients.size && this.worker) {
            const currentWorker = this.worker;
            this.worker = undefined;
            void currentWorker.terminate();
          }
        } else if (message.kind === 'response' || message.kind === 'update') {
          record.handlers.onMessage(message as TransportMessage);
        } else if (message.kind === 'fatal') {
          const error = new Error(message.error?.message ?? 'TDLib worker failed');
          record.rejectReady(error);
          record.handlers.onFatal(error);
        }
      },
    );
    worker.on('error', (error) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.worker = undefined;
      for (const [clientId, record] of this.clients) {
        record.rejectReady(failure);
        record.handlers.onFatal(failure);
        for (const waiter of record.destroyWaiters.splice(0)) waiter.reject(failure);
        this.clients.delete(clientId);
      }
    });
    worker.on('exit', (code) => {
      if (code !== 0 && this.worker === worker) {
        const error = new Error(`TDLib worker exited with code ${code}`);
        this.worker = undefined;
        for (const [clientId, record] of this.clients) {
          record.rejectReady(error);
          record.handlers.onFatal(error);
          for (const waiter of record.destroyWaiters.splice(0)) waiter.reject(error);
          this.clients.delete(clientId);
        }
      }
    });
  }
}

/** The process-wide TDLib transport used by native clients. / Процессный transport для native-клиентов TDLib. @private */
export const sharedTdlibTransport: TdlibTransport = new WorkerTransport();
