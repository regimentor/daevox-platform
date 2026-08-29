import { EventSender } from './EventSender.js';
import {
  EventDroppedError,
  EventHandlerTimeoutError,
  EventQueueFullError,
  EventSenderClosedError,
  InvalidEventPushError,
} from './errors.js';

/**
 * Owns listener instances and their independent FIFO mailboxes.
 * Владеет экземплярами слушателей и их независимыми FIFO mailbox.
 *
 * @private
 */
export class EventDispatcher {
  /**
   * @type {EventListenerRegistry} Listener declarations. / Декларации слушателей.
   * @private
   */
  #registry;
  /**
   * @type {NormalizedEventOptions} Runtime options. / Параметры runtime.
   * @private
   */
  #options;
  /**
   * @type {Map<string, EventMailbox>} Runtime mailboxes. / Mailbox времени выполнения.
   * @private
   */
  #mailboxes = new Map();
  /**
   * @type {boolean} Whether new pushes are rejected. / Отклоняются ли новые отправки.
   * @private
   */
  #sealed = false;
  /**
   * @type {boolean} Whether forced shutdown cut handlers off. / Выполнено ли forced shutdown.
   * @private
   */
  #forced = false;
  /**
   * @type {Set<Function>} Idle waiters. / Ожидающие опустошения.
   * @private
   */
  #idleWaiters = new Set();
  /**
   * @type {EventSender} Controller-facing sender. / Sender для контроллеров.
   * @private
   */
  sender;

  /**
   * Creates an event dispatcher.
   * Создаёт dispatcher внутренних событий.
   *
   * @param {EventListenerRegistry} registry Listener registry. / Каталог слушателей.
   * @param {NormalizedEventOptions} options Event options. / Параметры событий.
   * @private
   */
  constructor(registry, options) {
    this.#registry = registry;
    this.#options = options;
    this.sender = new EventSender((address, data) => this.#push(address, data));
  }

  /**
   * Constructs all registered listeners and creates their mailboxes.
   * Создаёт все зарегистрированные слушатели и их mailbox.
   *
   * @param {Object} dependencies Listener dependencies. / Зависимости слушателей.
   * @returns {void}
   * @private
   */
  start(dependencies) {
    const created = new Map();
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
   *
   * @returns {void}
   * @private
   */
  seal() {
    this.#sealed = true;
  }

  /**
   * Waits for normal drain or forces cutoff after the configured timeout.
   * Ждёт штатного опустошения или выполняет cutoff после настроенного тайм-аута.
   *
   * @returns {Promise<void>} Drain completion. / Завершение опустошения.
   * @private
   */
  async close() {
    this.seal();
    if (this.#isIdle()) return;
    let timer;
    const drained = new Promise((resolve) => this.#idleWaiters.add(resolve));
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(resolve, this.#options.shutdownTimeout, 'timeout');
    });
    const result = await Promise.race([drained, timedOut]);
    clearTimeout(timer);
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
   *
   * @param {*} address Candidate address. / Проверяемый адрес.
   * @param {*} data Candidate DTO. / Проверяемый DTO.
   * @returns {void}
   * @private
   */
  #push(address, data) {
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
   *
   * @param {EventMailbox} mailbox Listener mailbox. / Mailbox слушателя.
   * @returns {void}
   * @private
   */
  #schedule(mailbox) {
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
   *
   * @param {EventMailbox} mailbox Listener mailbox. / Mailbox слушателя.
   * @returns {void}
   * @private
   */
  #runOne(mailbox) {
    const item = mailbox.pending.shift();
    const abortController = new AbortController();
    const active = { ...item, abortController, timer: undefined };
    mailbox.active = active;
    let timedOut = false;
    const timeoutError = new EventHandlerTimeoutError('Application event handler timed out');
    const timer = setTimeout(() => {
      timedOut = true;
      abortController.abort(timeoutError);
      this.#report(timeoutError, item.address);
    }, this.#options.handlerTimeout);
    active.timer = timer;
    let result;
    try {
      result = mailbox.listener[item.event.handler](
        item.data,
        Object.freeze({ signal: abortController.signal }),
      );
    } catch (error) {
      result = Promise.reject(error);
    }
    Promise.resolve(result)
      .catch((error) => {
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
   *
   * @param {*} error Reported error. / Ошибка.
   * @param {ApplicationEventAddress} address Frozen address. / Замороженный адрес.
   * @returns {void}
   * @private
   */
  #report(error, address) {
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
   *
   * @returns {boolean} Idle state. / Состояние простоя.
   * @private
   */
  #isIdle() {
    for (const mailbox of this.#mailboxes.values()) {
      if (mailbox.active || mailbox.pending.length > 0 || mailbox.scheduled) return false;
    }
    return true;
  }

  /**
   * Resolves drain waiters when all mailboxes become idle.
   * Разрешает ожидания drain, когда все mailbox простаивают.
   *
   * @returns {void}
   * @private
   */
  #notifyIdle() {
    if (!this.#isIdle()) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }
}

/**
 * Runtime state for one listener mailbox.
 * Состояние mailbox одного слушателя во время выполнения.
 *
 * @typedef {Object} EventMailbox
 * @property {NormalizedEventListener} metadata Listener metadata. / Метаданные слушателя.
 * @property {EventListenerBase} listener Long-lived listener. / Долгоживущий слушатель.
 * @property {Object[]} pending Waiting events. / Ожидающие события.
 * @property {Object} [active] Active event. / Активное событие.
 * @property {boolean} scheduled Whether a turn is scheduled. / Запланирован ли оборот.
 * @private
 */
