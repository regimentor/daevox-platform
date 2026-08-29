/**
 * Invalid HTTP-controller declaration. / Некорректное объявление HTTP-контроллера.
 *
 * @public
 */
export class InvalidHttpControllerError extends TypeError {}

/**

 * Invalid HTTP-route declaration or definition. / Некорректное объявление или определение HTTP-маршрута.

 *

 * @public

 */
export class InvalidHttpRouteError extends TypeError {}

/**

 * Repeated registration of the same HTTP-controller class. / Повторная регистрация одного класса HTTP-контроллера.

 *

 * @public

 */
export class DuplicateHttpControllerError extends Error {}

/**

 * Conflict between structurally identical HTTP routes. / Конфликт структурно одинаковых HTTP-маршрутов.

 *

 * @public

 */
export class HttpRouteConflictError extends Error {}

/**

 * Invalid percent-encoding in a requested HTTP path. / Некорректное percent-кодирование запрошенного HTTP-пути.

 *

 * @public

 */
export class InvalidHttpPathEncodingError extends URIError {}

/**

 * Invalid HTTP configuration. / Некорректная конфигурация HTTP.

 *

 * @public

 */
export class InvalidHttpOptionsError extends TypeError {}

/**

 * Invalid WebSocket-controller declaration. / Некорректное объявление WebSocket-контроллера.

 *

 * @public

 */
export class InvalidWebSocketControllerError extends TypeError {}

/**

 * Invalid WebSocket configuration. / Некорректная конфигурация WebSocket.

 *

 * @public

 */
export class InvalidWebSocketOptionsError extends TypeError {}

/**
 * Indicates an invalid event-listener class or declaration.
 * Указывает на некорректный класс или декларацию слушателя событий.
 *
 * @public
 */
export class InvalidEventListenerError extends TypeError {}

/**
 * Indicates a duplicate event-listener class, name, or address.
 * Указывает на повтор класса, имени или адреса слушателя событий.
 *
 * @public
 */
export class EventListenerConflictError extends Error {}

/**
 * Indicates invalid application-event configuration.
 * Указывает на некорректную конфигурацию внутренних событий.
 *
 * @public
 */
export class InvalidEventOptionsError extends TypeError {}

/**
 * Indicates an invalid event address, DTO, or push call.
 * Указывает на некорректный адрес, DTO или вызов отправки события.
 *
 * @public
 */
export class InvalidEventPushError extends TypeError {}

/**
 * Indicates that a listener mailbox has reached its capacity.
 * Указывает, что mailbox слушателя достиг своей ёмкости.
 *
 * @public
 */
export class EventQueueFullError extends Error {}

/**
 * Indicates a push attempted after the event sender was sealed.
 * Указывает на отправку после запечатывания event sender.
 *
 * @public
 */
export class EventSenderClosedError extends Error {}

/**
 * Indicates that an event handler exceeded its configured timeout.
 * Указывает, что обработчик события превысил настроенный тайм-аут.
 *
 * @public
 */
export class EventHandlerTimeoutError extends Error {}

/**
 * Indicates that an accepted event was dropped during forced shutdown.
 * Указывает, что принятое событие отброшено при принудительном завершении.
 *
 * @public
 */
export class EventDroppedError extends Error {}

/**
 * Invalid server-push target or message. / Некорректная цель или сообщение server push.
 *
 * @public
 */
export class InvalidWebSocketSendError extends TypeError {}

/**
 * No active WebSocket session belongs to a client identifier. / Нет активной WebSocket-сессии,
 * принадлежащей идентификатору клиента.
 *
 * @public
 */
export class WebSocketClientNotFoundError extends Error {}

/**

 * Repeated registration of the same WebSocket-controller class. / Повторная регистрация одного класса WebSocket-контроллера.

 *

 * @public

 */
export class DuplicateWebSocketControllerError extends Error {}

/**

 * Conflict between WebSocket-controller wire names. / Конфликт сетевых имён WebSocket-контроллеров.

 *

 * @public

 */
export class WebSocketControllerConflictError extends Error {}

/**
 * Invalid runtime use of a middleware chain.
 * Некорректное использование цепочки middleware во время выполнения.
 *
 * @public
 */
export class MiddlewareExecutionError extends Error {}

/**
 * Framework-owned `daevox.v1` error codes unavailable to applications.
 * Принадлежащие фреймворку коды ошибок `daevox.v1`, недоступные приложениям.
 *
 * @type {Set<string>}
 * @private
 */
const RESERVED_WEBSOCKET_ERROR_CODES = new Set([
  'INVALID_MESSAGE',
  'UNKNOWN_CONTROLLER',
  'UNKNOWN_EVENT',
  'HANDLER_ERROR',
  'INVALID_RESPONSE',
]);

/**
 * Expected application failure of a WebSocket event.
 * Ожидаемый прикладной отказ WebSocket-события.
 *
 * @public
 */
export class WebSocketEventError extends Error {
  /**
   * Creates an expected application failure with a validated protocol code.
   * Создаёт ожидаемый прикладной отказ с проверенным кодом протокола.
   *
   * @param {string} code Application-defined machine-readable code. / Заданный приложением
   * машиночитаемый код.
   * @throws {TypeError} When the code is invalid or reserved. / Если код некорректен или
   * зарезервирован.
   * @public
   */
  constructor(code) {
    if (
      typeof code !== 'string' ||
      !/^[A-Z][A-Z0-9_]*$/.test(code) ||
      RESERVED_WEBSOCKET_ERROR_CODES.has(code)
    ) {
      throw new TypeError('WebSocketEventError code is invalid or reserved');
    }
    super(code);
    /**
     * Application-defined machine-readable error code.
     * Заданный приложением машиночитаемый код ошибки.
     *
     * @type {string}
     * @public
     */
    this.code = code;
  }
}

/**
 * Stable error reported for a `daevox.v1` protocol violation.
 * Стабильная ошибка нарушения протокола `daevox.v1`.
 *
 * @public
 */
export class WebSocketProtocolError extends Error {
  /**
   * @param {WebSocketErrorCode} code Machine-readable protocol code. / Машиночитаемый код.
   * @param {WebSocketProtocolErrorOptions} [options] Error address and severity. / Адрес и
   * критичность ошибки.
   */
  constructor(code, { fatal = false, controller, event } = {}) {
    super(code);
    this.code = code;
    this.fatal = fatal;
    this.controller = controller;
    this.event = event;
  }
}

/**

 * Invalid operation for the current application lifecycle state. / Операция недопустима в текущем состоянии жизненного цикла приложения.

 *

 * @public

 */
export class ApplicationStateError extends Error {}

/**
 * Expected HTTP failure returned by an HTTP handler.
 * Ожидаемая HTTP-ошибка, возвращаемая HTTP-обработчиком.
 *
 * @public
 */
export class HttpError extends Error {
  /**
   * @param {number} status HTTP status from 400 through 599. / HTTP-статус от 400 до 599.
   * @param {HttpErrorResponse} [response] Client response details. / Данные ответа клиенту.
   * @param {ErrorOptions} [options] Standard error options. / Стандартные параметры ошибки.
   */
  constructor(status, response = {}, options) {
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new TypeError('HttpError status must be an integer from 400 to 599');
    }
    if (response === null || typeof response !== 'object' || Array.isArray(response)) {
      throw new TypeError('HttpError response must be an object');
    }
    const keys = Reflect.ownKeys(response);
    if (keys.some((key) => typeof key !== 'string' || !['headers', 'body'].includes(key))) {
      throw new TypeError('HttpError response contains an unknown field');
    }
    if (response.headers !== undefined && !(response.headers instanceof Headers)) {
      throw new TypeError('HttpError headers must be Headers');
    }
    for (const name of ['content-length', 'transfer-encoding', 'connection']) {
      if (response.headers?.has(name)) throw new TypeError(`HttpError cannot set ${name}`);
    }
    if (
      response.body !== undefined &&
      typeof response.body !== 'string' &&
      !Buffer.isBuffer(response.body) &&
      !(response.body instanceof Uint8Array)
    ) {
      let json;
      try {
        json = JSON.stringify(response.body);
      } catch (cause) {
        throw new TypeError('HttpError body is not JSON-compatible', { cause });
      }
      if (json === undefined) throw new TypeError('HttpError body has no JSON representation');
    }
    super(`HTTP ${status}`, options);
    this.status = status;
    this.headers = response.headers;
    this.body = response.body;
  }
}

/**

 * Invalid user job class. / Некорректный пользовательский класс задачи.

 *

 * @public

 */
export class InvalidJobError extends TypeError {}

/**

 * Invalid job runner configuration or run options. / Некорректная конфигурация исполнителя или параметры запуска задачи.

 *

 * @public

 */
export class InvalidJobOptionsError extends TypeError {}

/**

 * Job payload or result cannot be structured-cloned. / Payload или результат задачи нельзя клонировать через structured clone.

 *

 * @public

 */
export class JobDataCloneError extends Error {}

/**

 * Worker queue has reached its configured limit. / Очередь работников достигла заданного предела.

 *

 * @public

 */
export class JobQueueFullError extends Error {}

/**

 * Job execution was cancelled. / Выполнение задачи отменено.

 *

 * @public

 */
export class JobAbortedError extends Error {}

/**

 * Job execution exceeded its timeout. / Выполнение задачи превысило тайм-аут.

 *

 * @public

 */
export class JobTimedOutError extends Error {}

/**

 * User job threw or rejected in a worker. / Пользовательская задача выбросила ошибку или отклонила Promise в Worker.

 *

 * @public

 */
export class JobExecutionError extends Error {}

/**

 * Worker terminated before completing its task. / Worker завершился до окончания задачи.

 *

 * @public

 */
export class WorkerTerminatedError extends Error {}

/**

 * Application-owned job runner is closed. / Принадлежащий приложению исполнитель задач закрыт.

 *

 * @public

 */
export class JobRunnerClosedError extends Error {}

/**
 * HTTP response details carried by {@link HttpError}.
 * Данные HTTP-ответа, переносимые {@link HttpError}.
 *
 * @typedef {Object} HttpErrorResponse
 * @property {Headers} [headers] WHATWG response headers. / WHATWG-заголовки ответа.
 * @property {*} [body] JSON-compatible, text, or binary body. / JSON-совместимое, текстовое или
 * бинарное тело.
 * @public
 */

/**
 * WebSocket protocol error constructor options.
 * Параметры создания ошибки WebSocket-протокола.
 *
 * @typedef {Object} WebSocketProtocolErrorOptions
 * @property {boolean} [fatal=false] Whether the session must close. / Нужно ли закрыть сессию.
 * @property {string} [controller] Addressed controller name. / Имя адресованного контроллера.
 * @property {string} [event] Addressed event name. / Имя адресованного события.
 * @public
 */

/**
 * Stable `daevox.v1` protocol error code.
 * Стабильный код ошибки протокола `daevox.v1`.
 *
 * @typedef {'INVALID_MESSAGE'|'UNKNOWN_CONTROLLER'|'UNKNOWN_EVENT'|'HANDLER_ERROR'|'INVALID_RESPONSE'} WebSocketErrorCode
 * @public
 */
