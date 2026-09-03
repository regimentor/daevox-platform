/**
 * Invalid HTTP-controller declaration. / Некорректное объявление HTTP-контроллера.
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
 * Invalid declaration or schema of an HTTP-route JSON body contract.
 * Некорректное объявление или schema контракта JSON-тела HTTP-маршрута.
 * @public
 */
export class InvalidHttpRouteJsonBodyContractError extends InvalidHttpRouteError {}

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

/** Machine-readable HTTP request-body failure. / Машиночитаемый отказ тела HTTP-запроса. @public */
export type HttpRequestBodyErrorCode =
  | 'MALFORMED_BODY'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'INVALID_JSON_BODY';

/** Framework-owned JSON body violation codes. / Принадлежащие framework коды нарушений JSON-тела. @public */
export type HttpRouteJsonBodyFrameworkViolationCode =
  | 'INVALID_TYPE'
  | 'NULL_NOT_ALLOWED'
  | 'UNKNOWN_FIELD'
  | 'MAX_DEPTH'
  | 'MAX_VALUES'
  | 'TOO_MANY_VIOLATIONS'
  | 'REQUIRED'
  | 'MIN_LENGTH'
  | 'MAX_LENGTH'
  | 'MIN'
  | 'MAX'
  | 'INTEGER';

/**
 * Expected failure while selecting or parsing an HTTP request-body representation.
 * Ожидаемый отказ при выборе или разборе представления тела HTTP-запроса.
 * @public
 */
export class HttpRequestBodyError extends Error {
  /** Machine-readable failure code. / Машиночитаемый код отказа. @public */
  declare readonly code: HttpRequestBodyErrorCode;

  /** Client-visible HTTP status. / Видимый клиенту HTTP-статус. @public */
  declare readonly status: 400 | 415;

  /**
   * Creates an expected request-body failure.
   * Создаёт ожидаемый отказ тела запроса.
   * @param code Machine-readable failure code. / Машиночитаемый код отказа.
   * @param [options] Standard error options. / Стандартные параметры ошибки.
   * @public
   */
  constructor(code: HttpRequestBodyErrorCode, options?: ErrorOptions) {
    if (
      code !== 'MALFORMED_BODY' &&
      code !== 'UNSUPPORTED_MEDIA_TYPE' &&
      code !== 'INVALID_JSON_BODY'
    ) {
      throw new TypeError('HttpRequestBodyError code is invalid');
    }
    super(code, options);
    this.code = code;
    this.status = code === 'UNSUPPORTED_MEDIA_TYPE' ? 415 : 400;
  }
}

/** One stable client-visible JSON body violation. / Одно стабильное видимое клиенту нарушение JSON-тела. @public */
export interface HttpRouteJsonBodyViolation {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

/**
 * Expected failure of an HTTP-route JSON body contract.
 * Ожидаемый отказ контракта JSON-тела HTTP-маршрута.
 * @public
 */
export class HttpRouteJsonBodyValidationError extends HttpRequestBodyError {
  /** Stable machine-readable code. / Стабильный машиночитаемый код. @public */
  declare readonly code: 'INVALID_JSON_BODY';

  /** Stable HTTP status. / Стабильный HTTP-статус. @public */
  declare readonly status: 400;

  /** Ordered immutable violations. / Упорядоченные неизменяемые нарушения. @public */
  declare readonly violations: readonly HttpRouteJsonBodyViolation[];

  /**
   * Creates a validation failure from non-empty violations.
   * Создаёт validation failure из непустого списка нарушений.
   * @param violations Ordered violations. / Упорядоченные нарушения.
   * @public
   */
  constructor(violations: readonly HttpRouteJsonBodyViolation[]) {
    super('INVALID_JSON_BODY');
    if (
      !Array.isArray(violations) ||
      violations.length === 0 ||
      violations.some(
        (violation) =>
          violation === null ||
          typeof violation !== 'object' ||
          Reflect.ownKeys(violation).length !== 3 ||
          !Object.hasOwn(violation, 'path') ||
          !Object.hasOwn(violation, 'code') ||
          !Object.hasOwn(violation, 'message') ||
          typeof violation.path !== 'string' ||
          !/^(?:\/(?:[^~]|~[01])*)*$/.test(violation.path) ||
          typeof violation.code !== 'string' ||
          !/^[A-Z][A-Z0-9_]{0,63}$/.test(violation.code) ||
          typeof violation.message !== 'string' ||
          [...violation.message].length < 1 ||
          [...violation.message].length > 512,
      )
    ) {
      throw new TypeError('HttpRouteJsonBodyValidationError violations are invalid');
    }
    this.violations = Object.freeze(
      violations.map((violation) =>
        Object.freeze({
          path: violation.path,
          code: violation.code,
          message: violation.message,
        }),
      ),
    );
  }
}

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
 * @public
 */
export class InvalidEventListenerError extends TypeError {}

/**
 * Indicates a duplicate event-listener class, name, or address.
 * Указывает на повтор класса, имени или адреса слушателя событий.
 * @public
 */
export class EventListenerConflictError extends Error {}

/**
 * Indicates invalid application-event configuration.
 * Указывает на некорректную конфигурацию внутренних событий.
 * @public
 */
export class InvalidEventOptionsError extends TypeError {}

/**
 * Indicates an invalid event address, DTO, or push call.
 * Указывает на некорректный адрес, DTO или вызов отправки события.
 * @public
 */
export class InvalidEventPushError extends TypeError {}

/**
 * Indicates that a listener mailbox has reached its capacity.
 * Указывает, что mailbox слушателя достиг своей ёмкости.
 * @public
 */
export class EventQueueFullError extends Error {}

/**
 * Indicates a push attempted after the event sender was sealed.
 * Указывает на отправку после запечатывания event sender.
 * @public
 */
export class EventSenderClosedError extends Error {}

/**
 * Indicates that an event handler exceeded its configured timeout.
 * Указывает, что обработчик события превысил настроенный тайм-аут.
 * @public
 */
export class EventHandlerTimeoutError extends Error {}

/**
 * Indicates that an accepted event was dropped during forced shutdown.
 * Указывает, что принятое событие отброшено при принудительном завершении.
 * @public
 */
export class EventDroppedError extends Error {}

/**
 * Invalid server-push target or message. / Некорректная цель или сообщение server push.
 * @public
 */
export class InvalidWebSocketSendError extends TypeError {}

/**
 * No active WebSocket session belongs to a client identifier. / Нет активной WebSocket-сессии,
 * принадлежащей идентификатору клиента.
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
 * @public
 */
export class MiddlewareExecutionError extends Error {}

/**
 * Framework-owned `daevox.v1` error codes unavailable to applications.
 * Принадлежащие фреймворку коды ошибок `daevox.v1`, недоступные приложениям.
 * @private
 */
const RESERVED_WEBSOCKET_ERROR_CODES = new Set([
  'INVALID_MESSAGE',
  'UNKNOWN_CONTROLLER',
  'UNKNOWN_EVENT',
  'HANDLER_ERROR',
  'INVALID_RESPONSE',
]);

/** Framework WebSocket protocol error code. / Код ошибки WebSocket-протокола фреймворка. @public */
export type WebSocketProtocolErrorCode =
  | 'INVALID_MESSAGE'
  | 'UNKNOWN_CONTROLLER'
  | 'UNKNOWN_EVENT'
  | 'HANDLER_ERROR'
  | 'INVALID_RESPONSE';

/** WebSocket protocol error details. / Данные ошибки WebSocket-протокола. @public */
export interface WebSocketProtocolErrorOptions {
  fatal?: boolean;
  controller?: string;
  event?: string;
}

/**
 * Expected application failure of a WebSocket event.
 * Ожидаемый прикладной отказ WebSocket-события.
 * @public
 */
export class WebSocketEventError extends Error {
  /** Machine-readable application error code. / Машиночитаемый код прикладной ошибки. @public */
  declare readonly code: string;

  /**
   * Creates an expected application failure with a validated protocol code.
   * Создаёт ожидаемый прикладной отказ с проверенным кодом протокола.
   * @param code Application-defined machine-readable code. / Заданный приложением
   * машиночитаемый код.
   * @throws {TypeError} When the code is invalid or reserved. / Если код некорректен или
   * зарезервирован.
   * @public
   */
  constructor(code: any) {
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
     * @public
     */
    this.code = code;
  }
}

/**
 * Stable error reported for a `daevox.v1` protocol violation.
 * Стабильная ошибка нарушения протокола `daevox.v1`.
 * @public
 */
export class WebSocketProtocolError extends Error {
  /** Machine-readable protocol code. / Машиночитаемый код протокола. @public */
  declare readonly code: WebSocketProtocolErrorCode;

  /** Whether the connection must close. / Требуется ли закрыть соединение. @public */
  declare readonly fatal: boolean;

  /** Optional controller address. / Необязательный адрес контроллера. @public */
  declare readonly controller: string | undefined;

  /** Optional event address. / Необязательный адрес события. @public */
  declare readonly event: string | undefined;

  /**
   * @param code Machine-readable protocol code. / Машиночитаемый код.
   * @param [options] Error address and severity. / Адрес и
   * критичность ошибки.
   */
  constructor(
    code: WebSocketProtocolErrorCode,
    { fatal = false, controller, event }: WebSocketProtocolErrorOptions = {},
  ) {
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

/** HTTP error response details. / Данные ответа HTTP-ошибки. @public */
export interface HttpErrorResponse {
  headers?: Headers;
  body?: unknown;
}

/**
 * Expected HTTP failure returned by an HTTP handler.
 * Ожидаемая HTTP-ошибка, возвращаемая HTTP-обработчиком.
 * @public
 */
export class HttpError extends Error {
  /** HTTP response status. / Статус HTTP-ответа. @public */
  declare readonly status: number;

  /** Optional response headers. / Необязательные заголовки ответа. @public */
  declare readonly headers: Headers | undefined;

  /** Optional response body. / Необязательное тело ответа. @public */
  declare readonly body: unknown;

  /**
   * @param status HTTP status from 400 through 599. / HTTP-статус от 400 до 599.
   * @param [response] Client response details. / Данные ответа клиенту.
   * @param [options] Standard error options. / Стандартные параметры ошибки.
   */
  constructor(status: number, response?: HttpErrorResponse, options?: ErrorOptions);
  constructor(status: unknown, response: unknown = {}, options: ErrorOptions = {}) {
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 599) {
      throw new TypeError('HttpError status must be an integer from 400 to 599');
    }
    if (response === null || typeof response !== 'object' || Array.isArray(response)) {
      throw new TypeError('HttpError response must be an object');
    }
    const keys = Reflect.ownKeys(response);
    if (keys.some((key) => typeof key !== 'string' || !['headers', 'body'].includes(key))) {
      throw new TypeError('HttpError response contains an unknown field');
    }
    const normalizedResponse = response as HttpErrorResponse;
    if (
      normalizedResponse.headers !== undefined &&
      !(normalizedResponse.headers instanceof Headers)
    ) {
      throw new TypeError('HttpError headers must be Headers');
    }
    for (const name of ['content-length', 'transfer-encoding', 'connection']) {
      if (normalizedResponse.headers?.has(name))
        throw new TypeError(`HttpError cannot set ${name}`);
    }
    if (
      normalizedResponse.body !== undefined &&
      typeof normalizedResponse.body !== 'string' &&
      !Buffer.isBuffer(normalizedResponse.body) &&
      !(normalizedResponse.body instanceof Uint8Array)
    ) {
      let json: string | undefined;
      try {
        json = JSON.stringify(normalizedResponse.body);
      } catch (cause) {
        throw new TypeError('HttpError body is not JSON-compatible', { cause });
      }
      if (json === undefined) throw new TypeError('HttpError body has no JSON representation');
    }
    super(`HTTP ${status}`, options);
    this.status = status;
    this.headers = normalizedResponse.headers;
    this.body = normalizedResponse.body;
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
