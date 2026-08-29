import { EventSender } from './EventSender.ts';
import type { ApplicationEventAddress } from './EventSender.ts';
import type { EventListenerDependencies } from './EventListenerBase.ts';
import type {
  EventListenerRegistry,
  NormalizedEventDeclaration,
  NormalizedEventListener,
} from './EventListenerRegistry.ts';
import {
  EventDroppedError,
  EventHandlerTimeoutError,
  EventQueueFullError,
  EventSenderClosedError,
  InvalidEventPushError,
} from './errors.ts';

/** Normalized dispatcher configuration. / Нормализованная конфигурация диспетчера. @private */
interface EventDispatcherOptions {
  queueSize: number;
  handlerTimeout: number;
  shutdownTimeout: number;
  onError?: (error: unknown, address: ApplicationEventAddress) => unknown | Promise<unknown>;
}

/** Accepted event waiting for dispatch. / Принятое событие, ожидающее обработки. @private */
interface PendingEvent {
  address: Readonly<ApplicationEventAddress>;
  data: unknown;
  event: NormalizedEventDeclaration;
}

/** Event currently handled by a listener. / Событие, обрабатываемое слушателем. @private */
interface ActiveEvent extends PendingEvent {
  abortController: AbortController;
  timer: NodeJS.Timeout | undefined;
}

/** Per-listener FIFO mailbox. / FIFO mailbox отдельного слушателя. @private */
interface EventMailbox {
  metadata: NormalizedEventListener;
  listener: Record<string, (...args: any[]) => unknown>;
  pending: PendingEvent[];
  active: ActiveEvent | undefined;
  scheduled: boolean;
}

/**
 * Owns listener instances and their independent FIFO mailboxes.
 * Владеет экземплярами слушателей и их независимыми FIFO mailbox.
 * @private
 */
export class EventDispatcher {
  /**
   * Listener declarations. / Декларации слушателей.
   * @private
   */
  #registry: EventListenerRegistry;
  /**
   * Runtime options. / Параметры runtime.
   * @private
   */
  #options: EventDispatcherOptions;
  /**
   * Runtime mailboxes. / Mailbox времени выполнения.
   * @private
   */
  #mailboxes = new Map<string, EventMailbox>();
  /**
   * Whether new pushes are rejected. / Отклоняются ли новые отправки.
   * @private
   */
  #sealed = false;
  /**
   * Whether forced shutdown cut handlers off. / Выполнено ли forced shutdown.
   * @private
   */
  #forced = false;
  /**
   * Idle waiters. / Ожидающие опустошения.
   * @private
   */
  #idleWaiters = new Set<() => void>();
  /**
   * Controller-facing sender. / Sender для контроллеров.
   * @private
   */
  sender: EventSender;

  /**
   * Creates an event dispatcher.
   * Создаёт dispatcher внутренних событий.
   * @param registry Listener registry. / Каталог слушателей.
   * @param options Event options. / Параметры событий.
   * @private
   */
  constructor(registry: EventListenerRegistry, options: EventDispatcherOptions) {
    this.#registry = registry;
    this.#options = options;
    this.sender = new EventSender((address, data) => this.#push(address, data));
  }

  /**
   * Constructs all registered listeners and creates their mailboxes.
   * Создаёт все зарегистрированные слушатели и их mailbox.
   * @param dependencies Listener dependencies. / Зависимости слушателей.
   * @private
   */
  start(dependencies: EventListenerDependencies): void {
    const created = new Map<string, EventMailbox>();
    for (const metadata of this.#registry.values()) {
      created.set(metadata.name, {
        metadata,
        listener: new metadata.EventListener(dependencies),
        pending: [],
        active: undefined,
        scheduled: false,
      });
    }
    this.#mailboxes = created;
  }

  /**
   * Stops accepting new events.
   * Прекращает принимать новые события.
   * @private
   */
  seal(): void {
    this.#sealed = true;
  }

  /**
   * Waits for normal drain or forces cutoff after the configured timeout.
   * Ждёт штатного опустошения или выполняет cutoff после настроенного тайм-аута.
   * @returns Drain completion. / Завершение опустошения.
   * @private
   */
  async close(): Promise<void> {
    this.seal();
    if (this.#isIdle()) return;
    let timer: NodeJS.Timeout | undefined;
    const drained = new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(resolve, this.#options.shutdownTimeout, 'timeout');
    });
    const result = await Promise.race([drained, timedOut]);
    if (timer) clearTimeout(timer);
    if (result !== 'timeout') return;
    this.#forced = true;
    this.#idleWaiters.clear();
    for (const mailbox of this.#mailboxes.values()) {
      if (mailbox.active) {
        clearTimeout(mailbox.active.timer);
        mailbox.active.abortController.abort();
      }
      for (const item of mailbox.pending.splice(0)) {
        this.#report(
          new EventDroppedError('Application event was dropped during shutdown'),
          item.address,
        );
      }
    }
  }

  /**
   * Synchronously validates and queues one event.
   * Синхронно проверяет и ставит в очередь одно событие.
   * @param address Candidate address. / Проверяемый адрес.
   * @param data Candidate DTO. / Проверяемый DTO.
   * @private
   */
  #push(address: ApplicationEventAddress, data: unknown): void {
    if (this.#sealed) throw new EventSenderClosedError('Event sender is closed');
    if (
      address === null ||
      typeof address !== 'object' ||
      Array.isArray(address) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(address)) ||
      Reflect.ownKeys(address).length !== 2
    ) {
      throw new InvalidEventPushError('Event address must contain exactly listener and event');
    }
    for (const key of ['listener', 'event']) {
      const descriptor = Object.getOwnPropertyDescriptor(address, key);
      if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string') {
        throw new InvalidEventPushError('Event address fields must be own string data properties');
      }
    }
    const normalizedAddress = Object.freeze({ listener: address.listener, event: address.event });
    const resolved = this.#registry.resolve(normalizedAddress.listener, normalizedAddress.event);
    if (!resolved) throw new InvalidEventPushError('Application event address is unknown');
    if (!(data instanceof resolved.event.data)) {
      throw new InvalidEventPushError('Application event data has an invalid DTO type');
    }
    const mailbox = this.#mailboxes.get(normalizedAddress.listener);
    if (!mailbox) throw new InvalidEventPushError('Event listener is not running');
    if (mailbox.pending.length >= this.#options.queueSize) {
      throw new EventQueueFullError('Event listener mailbox is full');
    }
    mailbox.pending.push({ address: normalizedAddress, data, event: resolved.event });
    this.#schedule(mailbox);
  }

  /**
   * Schedules at most one mailbox item for a future event-loop turn.
   * Планирует не более одного элемента mailbox на будущий оборот event loop.
   * @param mailbox Listener mailbox. / Mailbox слушателя.
   * @private
   */
  #schedule(mailbox: EventMailbox): void {
    if (mailbox.active || mailbox.scheduled || mailbox.pending.length === 0 || this.#forced) return;
    mailbox.scheduled = true;
    setImmediate(() => {
      mailbox.scheduled = false;
      if (this.#forced || mailbox.active || mailbox.pending.length === 0) {
        this.#notifyIdle();
        return;
      }
      this.#runOne(mailbox);
    });
  }

  /**
   * Runs one accepted event and schedules its successor after settlement.
   * Выполняет одно принятое событие и планирует следующее после settlement.
   * @param mailbox Listener mailbox. / Mailbox слушателя.
   * @private
   */
  #runOne(mailbox: EventMailbox): void {
    const item = mailbox.pending.shift()!;
    const abortController = new AbortController();
    const active: ActiveEvent = { ...item, abortController, timer: undefined };
    mailbox.active = active;
    let timedOut = false;
    const timeoutError = new EventHandlerTimeoutError('Application event handler timed out');
    const timer = setTimeout(() => {
      timedOut = true;
      abortController.abort(timeoutError);
      this.#report(timeoutError, item.address);
    }, this.#options.handlerTimeout);
    active.timer = timer;
    let result: unknown;
    try {
      result = mailbox.listener[item.event.handler](
        item.data,
        Object.freeze({ signal: abortController.signal }),
      );
    } catch (error) {
      result = Promise.reject(error);
    }
    Promise.resolve(result)
      .catch((error: any) => {
        if (!timedOut && !this.#forced) this.#report(error, item.address);
      })
      .finally(() => {
        clearTimeout(timer);
        mailbox.active = undefined;
        this.#schedule(mailbox);
        this.#notifyIdle();
      });
  }

  /**
   * Reports a handler or dropped-event error without awaiting the observer.
   * Сообщает об ошибке handler или отброшенного события без ожидания observer.
   * @param error Reported error. / Ошибка.
   * @param address Frozen address. / Замороженный адрес.
   * @private
   */
  #report(error: unknown, address: ApplicationEventAddress): void {
    const context = Object.freeze({ listener: address.listener, event: address.event });
    if (!this.#options.onError) {
      console.error(error);
      return;
    }
    try {
      Promise.resolve(this.#options.onError(error, context)).catch(console.error);
    } catch (observerError) {
      console.error(observerError);
    }
  }

  /**
   * Returns whether every mailbox has settled and emptied.
   * Возвращает, завершены и опустошены ли все mailbox.
   * @returns Idle state. / Состояние простоя.
   * @private
   */
  #isIdle(): boolean {
    for (const mailbox of this.#mailboxes.values()) {
      if (mailbox.active || mailbox.pending.length > 0 || mailbox.scheduled) return false;
    }
    return true;
  }

  /**
   * Resolves drain waiters when all mailboxes become idle.
   * Разрешает ожидания drain, когда все mailbox простаивают.
   * @private
   */
  #notifyIdle(): void {
    if (!this.#isIdle()) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }
}
