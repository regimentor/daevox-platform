import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TdlibArtifactError,
  TdlibError,
  TdlibLifecycleError,
  TdlibUpdateQueueFullError,
  type TdlibSubscriptionError,
} from './errors.ts';
import { sharedTdlibTransport, type TdlibTransport, type TransportMessage } from './transport.ts';
import type {
  TdAuthorizationState,
  TdClose,
  TdOk,
  TdRequest,
  TdResultFor,
  TdUpdate,
} from './generated/td-api.ts';

export interface InvokeOptions {
  readonly signal?: AbortSignal;
  readonly timeout?: number;
}

export interface WaitUntilReadyOptions {
  readonly signal?: AbortSignal;
  readonly timeout?: number;
}

export interface CloseOptions {
  readonly signal?: AbortSignal;
  readonly timeout?: number;
}

export interface UpdateSubscriptionOptions {
  readonly maxQueueSize?: number;
}

export interface TdlibClientOptions {
  readonly libraryPath?: string;
  readonly metadataPath?: string;
  readonly receiveTimeoutMs?: number;
  readonly maxUpdateQueueSize?: number;
  readonly transport?: TdlibTransport;
}

export type TdlibUpdateHandler = (update: TdUpdate) => void | Promise<void>;
export type TdlibErrorHandler = (error: TdlibSubscriptionError | Error) => void | Promise<void>;

type ClientState = 'created' | 'started' | 'closing' | 'closed' | 'failed';
interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  readonly signal?: AbortSignal;
  readonly abort: () => void;
}
interface Subscription {
  readonly id: number;
  readonly handler: TdlibUpdateHandler;
  readonly maxQueueSize: number;
  readonly queue: TdUpdate[];
  active: boolean;
  processing: boolean;
}
interface ReadyWaiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly timer?: ReturnType<typeof setTimeout>;
  readonly signal?: AbortSignal;
  readonly abort: () => void;
}

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultLibraryPath = join(packageDirectory, 'build', 'native', 'libtdjson.so');
const defaultMetadataPath = join(packageDirectory, 'build', 'tdlib-artifact.json');
const closeRequest: TdClose = { '@type': 'close' };

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  return new DOMException('The operation was aborted', 'AbortError');
}

function validateTimeout(timeout: number | undefined): void {
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0))
    throw new RangeError('TDLib timeout must be a non-negative finite number');
}

async function verifyArtifact(libraryPath: string, metadataPath: string): Promise<void> {
  try {
    const [metadataText, binary, schema, generated, gitFile] = await Promise.all([
      readFile(metadataPath, 'utf8'),
      readFile(libraryPath),
      readFile(join(packageDirectory, 'vendor', 'td', 'td', 'generate', 'scheme', 'td_api.tl')),
      readFile(join(packageDirectory, 'src', 'generated', 'td-api.ts'), 'utf8'),
      readFile(join(packageDirectory, 'vendor', 'td', '.git'), 'utf8'),
    ]);
    const metadata = JSON.parse(metadataText) as {
      binarySha256?: string;
      schemaSha256?: string;
      tdlibCommit?: string;
    };
    const binarySha256 = createHash('sha256').update(binary).digest('hex');
    const schemaSha256 = createHash('sha256').update(schema).digest('hex');
    const generatedSha256 = /^\/\/ TDLib schema sha256: (\w+)$/m.exec(generated)?.[1];
    const generatedCommit = /^\/\/ TDLib commit: (\w+)$/m.exec(generated)?.[1];
    const gitDirectory = resolve(
      join(packageDirectory, 'vendor', 'td'),
      gitFile.replace(/^gitdir:\s*/, '').trim(),
    );
    const head = (await readFile(join(gitDirectory, 'HEAD'), 'utf8')).trim();
    const currentCommit = head.startsWith('ref: ')
      ? (await readFile(join(gitDirectory, head.slice(5)), 'utf8')).trim()
      : head;
    if (
      metadata.binarySha256 !== binarySha256 ||
      metadata.schemaSha256 !== schemaSha256 ||
      generatedSha256 !== schemaSha256 ||
      metadata.tdlibCommit !== generatedCommit ||
      metadata.tdlibCommit !== currentCommit
    )
      throw new Error('the binary, schema, generated types, and pinned TDLib commit do not match');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TdlibArtifactError(
      `TDLib artifact is missing or incompatible (${detail}). Run npm run build -w @daevox/tdlib.`,
    );
  }
}

/** A typed, lifecycle-aware TDLib JSON client. / Типизированный JSON-клиент TDLib с управлением жизненным циклом. @public */
export class TdlibClient {
  private readonly clientId = `tdlib-${process.pid}-${Math.random().toString(36).slice(2)}`;
  private readonly options: TdlibClientOptions;
  private readonly transport: TdlibTransport;
  private readonly pending = new Map<string, PendingCall>();
  private readonly subscriptions = new Map<number, Subscription>();
  private readonly errorHandlers = new Set<TdlibErrorHandler>();
  private readonly readyWaiters = new Set<ReadyWaiter>();
  private sequence = 0;
  private subscriptionSequence = 0;
  private state: ClientState = 'created';
  private startPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private latestAuthorizationState: TdAuthorizationState | undefined;

  /** Creates a client. / Создаёт клиент. @public */
  constructor(options: TdlibClientOptions = {}) {
    this.options = options;
    this.transport = options.transport ?? sharedTdlibTransport;
    if (
      options.maxUpdateQueueSize !== undefined &&
      (!Number.isInteger(options.maxUpdateQueueSize) || options.maxUpdateQueueSize < 1)
    )
      throw new RangeError('maxUpdateQueueSize must be a positive integer');
  }

  /** Starts the native transport; this does not wait for Telegram authorization. / Запускает native transport, не ожидая авторизации Telegram. @public */
  start(): Promise<void> {
    if (this.state === 'started') return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    if (this.state !== 'created')
      return Promise.reject(
        new TdlibLifecycleError(`Cannot start a client in state ${this.state}`),
      );
    this.startPromise = (async () => {
      if (this.transport === sharedTdlibTransport)
        await verifyArtifact(
          this.options.libraryPath ?? defaultLibraryPath,
          this.options.metadataPath ?? defaultMetadataPath,
        );
      await this.transport.start(
        this.clientId,
        this.options.libraryPath ?? defaultLibraryPath,
        this.options.receiveTimeoutMs ?? 25,
        {
          onMessage: (message) => this.handleMessage(message),
          onFatal: (error) => this.fail(error),
        },
      );
      if (this.state !== 'created') {
        await this.transport.destroy(this.clientId);
        throw new TdlibLifecycleError(
          `Client start completed after it entered state ${this.state}`,
        );
      }
      this.state = 'started';
    })().catch((error) => {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    });
    return this.startPromise;
  }

  /** Sends a complete typed TDLib request. / Отправляет типизированный запрос полного API TDLib. @public */
  invoke<T extends TdRequest>(request: T, options: InvokeOptions = {}): Promise<TdResultFor<T>> {
    if (!request || typeof request !== 'object' || typeof request['@type'] !== 'string')
      return Promise.reject(new TypeError('TDLib request must contain a string @type'));
    if (this.state !== 'started')
      return Promise.reject(new TdlibLifecycleError(`Cannot invoke TDLib in state ${this.state}`));
    validateTimeout(options.timeout);
    const requestId = `${this.clientId}:${++this.sequence}`;
    return new Promise<TdResultFor<T>>((fulfill, reject) => {
      const settleAbort = () => {
        if (!this.pending.delete(requestId)) return;
        if (pending.timer) clearTimeout(pending.timer);
        options.signal?.removeEventListener('abort', settleAbort);
        reject(abortError(options.signal?.reason));
      };
      const pending: PendingCall = {
        resolve: fulfill as (value: unknown) => void,
        reject,
        signal: options.signal,
        abort: settleAbort,
      };
      this.pending.set(requestId, pending);
      if (options.signal?.aborted) return settleAbort();
      options.signal?.addEventListener('abort', settleAbort, { once: true });
      if (options.timeout !== undefined) {
        pending.timer = setTimeout(() => {
          if (!this.pending.delete(requestId)) return;
          options.signal?.removeEventListener('abort', settleAbort);
          reject(new DOMException('The operation timed out', 'TimeoutError'));
        }, options.timeout);
      }
      try {
        this.transport.send(this.clientId, requestId, request);
      } catch (error) {
        if (this.pending.delete(requestId)) {
          if (pending.timer) clearTimeout(pending.timer);
          options.signal?.removeEventListener('abort', settleAbort);
          reject(error);
        }
      }
    });
  }

  /** Subscribes to the ordered update stream and returns an idempotent unsubscribe function. / Подписывается на упорядоченный поток обновлений и возвращает идемпотентную отписку. @public */
  onUpdate(handler: TdlibUpdateHandler, options: UpdateSubscriptionOptions = {}): () => void {
    if (typeof handler !== 'function')
      throw new TypeError('TDLib update handler must be a function');
    const maxQueueSize = options.maxQueueSize ?? this.options.maxUpdateQueueSize ?? 1024;
    if (!Number.isInteger(maxQueueSize) || maxQueueSize < 1)
      throw new RangeError('maxQueueSize must be a positive integer');
    const subscription: Subscription = {
      id: ++this.subscriptionSequence,
      handler,
      maxQueueSize,
      queue: [],
      active: true,
      processing: false,
    };
    this.subscriptions.set(subscription.id, subscription);
    return () => {
      if (!subscription.active) return;
      subscription.active = false;
      subscription.queue.length = 0;
      this.subscriptions.delete(subscription.id);
    };
  }

  /** Subscribes to client and subscription failures. / Подписывается на ошибки клиента и подписок. @public */
  onError(handler: TdlibErrorHandler): () => void {
    if (typeof handler !== 'function')
      throw new TypeError('TDLib error handler must be a function');
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  /** Waits for authorizationStateReady without coupling authorization to start(). / Ожидает authorizationStateReady отдельно от start(). @public */
  waitUntilReady(options: WaitUntilReadyOptions = {}): Promise<void> {
    validateTimeout(options.timeout);
    if (this.latestAuthorizationState?.['@type'] === 'authorizationStateReady')
      return Promise.resolve();
    if (this.state === 'closed' || this.state === 'failed')
      return Promise.reject(
        new TdlibLifecycleError(`Cannot wait for readiness in state ${this.state}`),
      );
    return this.waitForReady(options);
  }

  /** Initiates graceful TDLib shutdown; cancelling this call only cancels its wait. / Инициирует штатное завершение TDLib; отмена вызова отменяет только его ожидание. @public */
  close(options: CloseOptions = {}): Promise<void> {
    validateTimeout(options.timeout);
    if (!this.closePromise) this.closePromise = this.performClose();
    return this.withWait(this.closePromise, options);
  }

  private async performClose(): Promise<void> {
    if (this.state === 'closed') return;
    if (this.state === 'created') {
      this.state = 'closed';
      this.rejectWaiters(new TdlibLifecycleError('TDLib client was closed'));
      return;
    }
    if (this.state === 'failed') return;
    this.state = 'closing';
    try {
      await this.invokeInternal(closeRequest);
    } catch (error) {
      this.emitError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      try {
        await this.transport.destroy(this.clientId);
      } catch (error) {
        this.emitError(error instanceof Error ? error : new Error(String(error)));
      }
      this.state = 'closed';
      const error = new TdlibLifecycleError('TDLib client was closed');
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.rejectWaiters(error);
      for (const subscription of this.subscriptions.values()) {
        subscription.active = false;
        subscription.queue.length = 0;
      }
      this.subscriptions.clear();
    }
  }

  private invokeInternal(request: TdClose): Promise<TdOk> {
    const state = this.state;
    this.state = 'started';
    const result = this.invoke<TdClose>(request);
    this.state = state;
    return result;
  }

  private withWait(operation: Promise<void>, options: CloseOptions): Promise<void> {
    if (options.signal?.aborted) return Promise.reject(abortError(options.signal.reason));
    if (options.timeout === undefined && !options.signal) return operation;
    return new Promise<void>((fulfill, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        cleanup();
        reject(abortError(options.signal?.reason));
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.timeout !== undefined)
        timer = setTimeout(() => {
          cleanup();
          reject(new DOMException('The operation timed out', 'TimeoutError'));
        }, options.timeout);
      operation.then(
        (value) => {
          cleanup();
          fulfill(value);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  private waitForReady(options: WaitUntilReadyOptions): Promise<void> {
    return new Promise<void>((fulfill, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        this.readyWaiters.delete(waiter);
        if (timer) clearTimeout(timer);
        reject(abortError(options.signal?.reason));
      };
      const waiter: ReadyWaiter = {
        resolve: fulfill,
        reject,
        timer,
        signal: options.signal,
        abort,
      };
      this.readyWaiters.add(waiter);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.timeout !== undefined)
        timer = setTimeout(() => {
          this.readyWaiters.delete(waiter);
          options.signal?.removeEventListener('abort', abort);
          reject(new DOMException('The operation timed out', 'TimeoutError'));
        }, options.timeout);
    });
  }

  private handleMessage(message: TransportMessage): void {
    if (message.kind === 'response') {
      const pending = this.pending.get(message.requestId!);
      if (!pending) return;
      this.pending.delete(message.requestId!);
      if (pending.timer) clearTimeout(pending.timer);
      pending.signal?.removeEventListener('abort', pending.abort);
      const payload = message.payload as { '@type'?: string; code?: number; message?: string };
      if (payload['@type'] === 'error')
        pending.reject(new TdlibError(payload.code ?? 0, payload.message ?? 'TDLib error'));
      else pending.resolve(message.payload);
      return;
    }
    const update = message.payload as TdUpdate;
    if (update['@type'] === 'updateAuthorizationState') {
      this.latestAuthorizationState = update.authorization_state ?? undefined;
      if (this.latestAuthorizationState?.['@type'] === 'authorizationStateReady')
        for (const waiter of this.readyWaiters) {
          waiter.resolve();
          this.readyWaiters.delete(waiter);
        }
    }
    for (const subscription of this.subscriptions.values()) {
      if (!subscription.active) continue;
      if (subscription.queue.length >= subscription.maxQueueSize) {
        subscription.active = false;
        this.subscriptions.delete(subscription.id);
        subscription.queue.length = 0;
        this.emitError({
          subscriptionId: subscription.id,
          error: new TdlibUpdateQueueFullError(subscription.id, subscription.maxQueueSize),
        });
        continue;
      }
      subscription.queue.push(update);
      void this.drain(subscription);
    }
  }

  private async drain(subscription: Subscription): Promise<void> {
    if (subscription.processing) return;
    subscription.processing = true;
    try {
      while (subscription.active && subscription.queue.length)
        await subscription.handler(subscription.queue.shift()!);
    } catch (error) {
      subscription.active = false;
      subscription.queue.length = 0;
      this.subscriptions.delete(subscription.id);
      this.emitError({ subscriptionId: subscription.id, error });
    } finally {
      subscription.processing = false;
    }
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of this.readyWaiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.signal?.removeEventListener('abort', waiter.abort);
      waiter.reject(error);
    }
    this.readyWaiters.clear();
  }

  private fail(error: Error): void {
    if (this.state === 'closed' || this.state === 'failed') return;
    this.state = 'failed';
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.rejectWaiters(error);
    this.emitError(error);
    void this.transport.destroy(this.clientId).catch(() => undefined);
  }

  private emitError(error: TdlibSubscriptionError | Error): void {
    for (const handler of this.errorHandlers) {
      try {
        Promise.resolve(handler(error)).catch(() => undefined);
      } catch {
        /* Error observers are isolated from the client. */
      }
    }
  }
}
