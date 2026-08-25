import nodeHttp from 'node:http';
import { hasAuthenticationScenario, isAuthentication } from './Authentication.js';
import { HttpControllerBase } from './HttpControllerBase.js';
import { HttpRouter } from './HttpRouter.js';
import { JobRunner } from './JobRunner.js';
import { WebSocketControllerRegistry } from './WebSocketControllerRegistry.js';
import { WebSocketSessionStore } from './WebSocketSessionStore.js';
import { WebSocketTransport } from './WebSocketTransport.js';
import {
  ApplicationStateError,
  DuplicateHttpControllerError,
  InvalidHttpControllerError,
  InvalidAuthenticationOptionsError,
  InvalidHttpOptionsError,
  InvalidHttpPathEncodingError,
  InvalidHttpRouteError,
  HttpError,
  DuplicateWebSocketControllerError,
  InvalidWebSocketOptionsError,
  AuthenticationAbortedError,
} from './errors.js';
import { decodePathSegments, hasExactlyOwnKeys, isHttpToken } from './httpRoute.js';

/**

 * Exact fields accepted in an HTTP-route declaration. / Точные поля объявления HTTP-маршрута.

 *

 * @type {string[]}

 * @private

 */
const DECLARATION_KEYS = ['authentication', 'handler', 'method', 'path'];

/**
 * Valid Authentication scenario-name syntax. / Допустимый синтаксис имени scenario Authentication.
 *
 * @type {RegExp}
 * @private
 */
const AUTHENTICATION_SCENARIO_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Exact top-level Application configuration keys. / Точные ключи конфигурации Application.
 *
 * @type {Set<string>}
 * @private
 */
const APPLICATION_OPTION_KEYS = new Set(['authentication', 'http', 'jobs', 'websocket']);
/**
 * Supported HTTP configuration keys. / Поддерживаемые ключи конфигурации HTTP.
 *
 * @type {Set<string>}
 * @private
 */
const HTTP_OPTION_KEYS = new Set(['bodyLimit', 'shutdownTimeout', 'onError']);
/**
 * Strict decoder for UTF-8 HTTP request bodies. / Строгий декодер UTF-8 для тел HTTP-запросов.
 *
 * @type {TextDecoder}
 * @private
 */
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
/**
 * Supported WebSocket configuration keys. / Поддерживаемые ключи конфигурации WebSocket.
 *
 * @type {Set<string>}
 * @private
 */
const WEBSOCKET_OPTION_KEYS = new Set([
  'allowedOrigins',
  'authentication',
  'maxPayload',
  'maxWriteQueueBytes',
  'onConnect',
  'onDisconnect',
  'onError',
  'path',
]);

/**
 * Internal HTTP failure with a client-visible status and message.
 * Внутренняя HTTP-ошибка со статусом и сообщением для клиента.
 *
 * @private
 */
class InfrastructureHttpError extends Error {
  /**
   * @param {number} status HTTP status. / HTTP-статус.
   * @param {string} message Client-visible message. / Сообщение для клиента.
   */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**

 * Throws a normalized HTTP-options error. / Выбрасывает нормализованную ошибку параметров HTTP.

 *

 * @param {string} message Error text. / Текст ошибки.

 * @throws {InvalidHttpOptionsError} Always. / Всегда.

 * @private

 */
function invalidHttpOptions(message) {
  throw new InvalidHttpOptionsError(message);
}

/**
 * Validates and fills HTTP configuration defaults.
 * Проверяет конфигурацию HTTP и заполняет значения по умолчанию.
 *
 * @param {HttpOptions} [options] HTTP configuration. / Конфигурация HTTP.
 * @returns {NormalizedHttpOptions} Normalized configuration. / Нормализованная конфигурация.
 * @private
 */
function normalizeHttpOptions(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    invalidHttpOptions('http configuration must be an object');
  }
  if (
    Reflect.ownKeys(options).some((key) => typeof key !== 'string' || !HTTP_OPTION_KEYS.has(key))
  ) {
    invalidHttpOptions('http configuration contains an unknown field');
  }
  const bodyLimit = options.bodyLimit ?? 1024 * 1024;
  const shutdownTimeout = options.shutdownTimeout ?? 30_000;
  const onError = options.onError;
  if (!Number.isInteger(bodyLimit) || bodyLimit < 0) invalidHttpOptions('bodyLimit is invalid');
  if (
    typeof shutdownTimeout !== 'number' ||
    !Number.isFinite(shutdownTimeout) ||
    shutdownTimeout < 0
  ) {
    invalidHttpOptions('shutdownTimeout is invalid');
  }
  if (onError !== undefined && typeof onError !== 'function')
    invalidHttpOptions('onError is invalid');
  return { bodyLimit, shutdownTimeout, onError };
}

/**
 * Validates and fills WebSocket configuration defaults.
 * Проверяет конфигурацию WebSocket и заполняет значения по умолчанию.
 *
 * @param {WebSocketOptions} [options] WebSocket configuration. / Конфигурация WebSocket.
 * @returns {NormalizedWebSocketOptions} Normalized configuration. / Нормализованная конфигурация.
 * @private
 */
function normalizeWebSocketOptions(options, authenticationModule) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new InvalidWebSocketOptionsError('websocket configuration must be an object');
  }
  const optionKeys = Reflect.ownKeys(options);
  if (
    optionKeys.some((key) => {
      if (typeof key !== 'string' || !WEBSOCKET_OPTION_KEYS.has(key)) return true;
      const descriptor = Object.getOwnPropertyDescriptor(options, key);
      return !descriptor || !('value' in descriptor) || descriptor.value === undefined;
    }) ||
    !optionKeys.includes('authentication')
  ) {
    throw new InvalidWebSocketOptionsError('websocket configuration contains an unknown field');
  }
  const authentication = ownDataValue(options, 'authentication');
  if (
    authentication !== false &&
    (typeof authentication !== 'string' || !AUTHENTICATION_SCENARIO_NAME.test(authentication))
  ) {
    throw new InvalidWebSocketOptionsError('authentication is invalid');
  }
  if (
    typeof authentication === 'string' &&
    (!authenticationModule || !hasAuthenticationScenario(authenticationModule, authentication))
  ) {
    throw new InvalidAuthenticationOptionsError('WebSocket authentication scenario does not exist');
  }
  const allowedOriginsValue = Object.hasOwn(options, 'allowedOrigins')
    ? ownDataValue(options, 'allowedOrigins')
    : [];
  if (
    !Array.isArray(allowedOriginsValue) ||
    Reflect.ownKeys(allowedOriginsValue).some((key) => {
      if (key === 'length') return false;
      if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key)) return true;
      const index = Number(key);
      const descriptor = Object.getOwnPropertyDescriptor(allowedOriginsValue, key);
      return (
        !Number.isSafeInteger(index) ||
        index >= allowedOriginsValue.length ||
        !descriptor ||
        !('value' in descriptor) ||
        descriptor.value === undefined
      );
    }) ||
    Object.keys(allowedOriginsValue).length !== allowedOriginsValue.length
  ) {
    throw new InvalidWebSocketOptionsError('allowedOrigins is invalid');
  }
  const allowedOrigins = [];
  const uniqueOrigins = new Set();
  for (let index = 0; index < allowedOriginsValue.length; index += 1) {
    const origin = ownDataValue(allowedOriginsValue, String(index));
    if (typeof origin !== 'string') {
      throw new InvalidWebSocketOptionsError('allowedOrigins contains an invalid origin');
    }
    let url;
    try {
      url = new URL(origin);
    } catch {
      throw new InvalidWebSocketOptionsError('allowedOrigins contains an invalid origin');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.origin !== origin ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      uniqueOrigins.has(origin)
    ) {
      throw new InvalidWebSocketOptionsError('allowedOrigins contains an invalid origin');
    }
    uniqueOrigins.add(origin);
    allowedOrigins.push(origin);
  }
  const maxPayload = ownDataValue(options, 'maxPayload') ?? 1024 * 1024;
  if (!Number.isSafeInteger(maxPayload) || maxPayload < 0) {
    throw new InvalidWebSocketOptionsError('maxPayload is invalid');
  }
  const maxWriteQueueBytes = Object.hasOwn(options, 'maxWriteQueueBytes')
    ? ownDataValue(options, 'maxWriteQueueBytes')
    : 2 * maxPayload;
  if (!Number.isSafeInteger(maxWriteQueueBytes) || maxWriteQueueBytes < 0) {
    throw new InvalidWebSocketOptionsError('maxWriteQueueBytes is invalid');
  }
  let path;
  try {
    if (
      Object.hasOwn(options, 'path') &&
      (typeof ownDataValue(options, 'path') !== 'string' ||
        !ownDataValue(options, 'path').startsWith('/'))
    ) {
      throw new TypeError();
    }
    path = composePath([], ownDataValue(options, 'path') ?? '/websocket');
  } catch {
    throw new InvalidWebSocketOptionsError('path is invalid');
  }
  for (const hook of ['onConnect', 'onDisconnect', 'onError']) {
    if (Object.hasOwn(options, hook) && typeof ownDataValue(options, hook) !== 'function') {
      throw new InvalidWebSocketOptionsError(`${hook} is invalid`);
    }
  }
  return Object.freeze({
    allowedOrigins: Object.freeze(allowedOrigins),
    authentication,
    maxPayload,
    maxWriteQueueBytes,
    path,
    onConnect: ownDataValue(options, 'onConnect'),
    onDisconnect: ownDataValue(options, 'onDisconnect'),
    onError: ownDataValue(options, 'onError'),
  });
}

/**

 * Creates an invalid-controller error with an optional cause. / Создаёт ошибку HTTP-контроллера с необязательной причиной.

 *

 * @param {string} message Error text. / Текст ошибки.

 * @param {Error} [cause] Original error. / Исходная ошибка.

 * @returns {InvalidHttpControllerError} Created error. / Созданная ошибка.

 * @private

 */
function controllerError(message, cause) {
  return new InvalidHttpControllerError(message, cause ? { cause } : undefined);
}

/**

 * Creates an invalid-route error with an optional cause. / Создаёт ошибку HTTP-маршрута с необязательной причиной.

 *

 * @param {string} message Error text. / Текст ошибки.

 * @param {Error} [cause] Original error. / Исходная ошибка.

 * @returns {InvalidHttpRouteError} Created error. / Созданная ошибка.

 * @private

 */
function routeError(message, cause) {
  return new InvalidHttpRouteError(message, cause ? { cause } : undefined);
}

/**

 * Decodes and validates path segments for a route declaration. / Декодирует и проверяет сегменты пути объявления HTTP-маршрута.

 *

 * @param {string} path Absolute path. / Абсолютный путь.

 * @returns {string[]} Decoded segments. / Декодированные сегменты.

 * @private

 */
function pathSegments(path) {
  try {
    return decodePathSegments(path);
  } catch (cause) {
    const message =
      cause instanceof URIError
        ? 'HTTP route path contains invalid percent-encoding'
        : 'HTTP route path contains a forbidden character or segment';
    throw routeError(message, cause);
  }
}

/**

 * Escapes a decoded segment for storage in a normalized path. / Экранирует декодированный сегмент для нормализованного пути.

 *

 * @param {string} segment Decoded segment. / Декодированный сегмент.

 * @returns {string} Serialized segment. / Сериализованный сегмент.

 * @private

 */
function serializeSegment(segment) {
  return segment.replaceAll('%', '%25').replaceAll('/', '%2F');
}

/**

 * Joins decoded prefix segments with a declared route path. / Объединяет сегменты префикса с объявленным путём HTTP-маршрута.

 *

 * @param {string[]} prefixSegments Prefix segments. / Сегменты префикса.

 * @param {string} path Declared path. / Объявленный путь.

 * @returns {string} Normalized absolute path. / Нормализованный абсолютный путь.

 * @private

 */
function composePath(prefixSegments, path) {
  const segments = [...prefixSegments, ...pathSegments(path)];
  return segments.length === 0 ? '/' : `/${segments.map(serializeSegment).join('/')}`;
}

/**

 * Reads an own data-property without invoking accessors. / Читает собственное data-свойство без вызова аксессоров.

 *

 * @param {Object} object Owner. / Владелец.

 * @param {PropertyKey} property Property key. / Ключ свойства.

 * @returns {*} Stored value or `undefined`. / Сохранённое значение или `undefined`.

 * @private

 */
function ownDataValue(object, property) {
  const descriptor = Object.getOwnPropertyDescriptor(object, property);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/**

 * Validates the nominal HTTP-controller contract. / Проверяет номинальный контракт HTTP-контроллера.

 *

 * @param {Function} HttpController Candidate class. / Проверяемый класс.

 * @returns {HttpControllerMetadata} Controller metadata. / Метаданные контроллера.

 * @private

 */
function validateControllerClass(HttpController) {
  if (
    typeof HttpController !== 'function' ||
    !HttpController.prototype ||
    Object.getPrototypeOf(HttpController.prototype) !== HttpControllerBase.prototype
  ) {
    throw controllerError('HTTP controller must directly extend HttpControllerBase');
  }

  const prefix = ownDataValue(HttpController, 'prefix');
  const routes = ownDataValue(HttpController, 'routes');
  if (typeof prefix !== 'string' || prefix === '') {
    throw controllerError('HTTP controller must have its own non-empty prefix');
  }
  if (!Array.isArray(routes) || routes.length === 0) {
    throw controllerError('HTTP controller must have its own non-empty routes array');
  }
  return { prefix, routes };
}

/**

 * Normalizes one controller route declaration. / Нормализует одно объявление HTTP-маршрута контроллера.

 *

 * @param {Function} HttpController Controller class. / Класс контроллера.

 * @param {string[]} prefixSegments Decoded prefix. / Декодированный префикс.

 * @param {HttpRouteDeclaration} declaration Route declaration. / Объявление HTTP-маршрута.

 * @param {Authentication} [authenticationModule] Application Authentication module. / Модуль
 * Authentication приложения.

 * @returns {NormalizedHttpRoute} Frozen normalized route. / Замороженный нормализованный HTTP-маршрут.

 * @private

 */
function normalizeRoute(HttpController, prefixSegments, declaration, authenticationModule) {
  if (
    declaration === null ||
    typeof declaration !== 'object' ||
    Array.isArray(declaration) ||
    !hasExactlyOwnKeys(declaration, DECLARATION_KEYS) ||
    DECLARATION_KEYS.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(declaration, key);
      return !descriptor || !('value' in descriptor);
    })
  ) {
    throw routeError(
      'HTTP route declaration must have exactly method, path, handler and authentication',
    );
  }

  const authentication = ownDataValue(declaration, 'authentication');
  const handler = ownDataValue(declaration, 'handler');
  const method = ownDataValue(declaration, 'method');
  const path = ownDataValue(declaration, 'path');
  if (
    !isHttpToken(method) ||
    typeof path !== 'string' ||
    path === '' ||
    typeof handler !== 'string' ||
    handler === '' ||
    (authentication !== false &&
      (typeof authentication !== 'string' || !AUTHENTICATION_SCENARIO_NAME.test(authentication)))
  ) {
    throw routeError('HTTP route declaration fields are invalid');
  }

  if (
    typeof authentication === 'string' &&
    (!authenticationModule || !hasAuthenticationScenario(authenticationModule, authentication))
  ) {
    throw new InvalidAuthenticationOptionsError(
      'HTTP route authentication scenario does not exist',
    );
  }

  const handlerDescriptor = Object.getOwnPropertyDescriptor(HttpController.prototype, handler);
  if (
    handler === 'constructor' ||
    !handlerDescriptor ||
    typeof handlerDescriptor.value !== 'function'
  ) {
    throw controllerError('HTTP handler must be an own instance method');
  }

  return Object.freeze({
    method: method.toUpperCase(),
    path: composePath(prefixSegments, path),
    handler,
    controller: HttpController,
    authentication,
  });
}

/**
 * Composes HTTP, WebSocket, and background-job capabilities and owns their lifecycle.
 * Компонует HTTP-, WebSocket-возможности и фоновые задачи и владеет их жизненным циклом.
 *
 * @public
 */
export class Application {
  /**
   * @type {HttpRouter} HTTP-route catalog. / Каталог HTTP-маршрутов.
   * @private
   */
  #httpRouter = new HttpRouter();
  /**
   * @type {Set<Function>} Registered HTTP-controller classes. / Классы зарегистрированных HTTP-контроллеров.
   * @private
   */
  #httpControllers = new Set();
  /**
   * @type {JobRunner} Application-owned job runner. / Принадлежащий приложению исполнитель задач.
   * @private
   */
  #jobRunner;
  /**
   * Application Authentication module. / Модуль Authentication приложения.
   *
   * @type {Authentication}
   * @private
   */
  #authentication;
  /**
   * @type {NormalizedHttpOptions} HTTP transport options. / Параметры HTTP-транспорта.
   * @private
   */
  #httpOptions;
  /**
   * @type {Server} Shared HTTP server. / Общий HTTP-сервер.
   * @private
   */
  #httpServer;
  /**
   * @type {Promise<void>} Idempotent close operation. / Идемпотентная операция закрытия.
   * @private
   */
  #closePromise;
  /**
   * @type {Promise<AddressInfo|string|null>} One-shot listen operation. / Однократная операция запуска.
   * @private
   */
  #listenPromise;
  /**
   * @type {'new'|'starting'|'running'|'failed'|'closing'|'closed'} Lifecycle state. / Состояние жизненного цикла.
   * @private
   */
  #state = 'new';
  /**
   * @type {Set<ActiveHttpRequest>} In-flight HTTP requests. / Активные HTTP-запросы.
   * @private
   */
  #activeRequests = new Set();
  /**
   * @type {Set<Function>} Resolvers waiting for HTTP requests. / Ожидающие HTTP-запросы функции завершения.
   * @private
   */
  #activeWaiters = new Set();
  /**
   * @type {WebSocketControllerRegistry} WebSocket-controller catalog. / Каталог WebSocket-контроллеров.
   * @private
   */
  #webSocketControllers = new WebSocketControllerRegistry();
  /**
   * @type {Set<Function>} Registered WebSocket-controller classes. / Классы зарегистрированных WebSocket-контроллеров.
   * @private
   */
  #webSocketControllerClasses = new Set();
  /**
   * @type {NormalizedWebSocketOptions} WebSocket transport options. / Параметры WebSocket-транспорта.
   * @private
   */
  #webSocketOptions;
  /**
   * @type {WebSocketSessionStore} Active WebSocket sessions. / Активные WebSocket-сессии.
   * @private
   */
  #webSocketSessions = new WebSocketSessionStore();
  /**
   * @type {WebSocketTransport} WebSocket transport. / WebSocket-транспорт.
   * @private
   */
  #webSocketTransport;

  /**
   * Creates an application and its owned job runner.
   * Создаёт приложение и принадлежащий ему исполнитель задач.
   *
   * @param {ApplicationOptions} options Application configuration. / Конфигурация приложения.
   * @throws {InvalidAuthenticationOptionsError|InvalidHttpOptionsError|InvalidWebSocketOptionsError|InvalidJobOptionsError}
   * When a configuration section is invalid. / Если раздел конфигурации некорректен.
   */
  constructor(options = {}) {
    if (
      options === null ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Reflect.ownKeys(options).some((key) => {
        if (typeof key !== 'string' || !APPLICATION_OPTION_KEYS.has(key)) return true;
        const descriptor = Object.getOwnPropertyDescriptor(options, key);
        return !descriptor || !('value' in descriptor) || descriptor.value === undefined;
      }) ||
      !Object.hasOwn(options, 'websocket')
    ) {
      throw new InvalidWebSocketOptionsError(
        'Application configuration must explicitly contain websocket',
      );
    }
    const jobs = ownDataValue(options, 'jobs');
    const http = ownDataValue(options, 'http');
    const websocket = ownDataValue(options, 'websocket');
    const authentication = ownDataValue(options, 'authentication');
    if (Object.hasOwn(options, 'authentication') && !isAuthentication(authentication)) {
      throw new InvalidAuthenticationOptionsError(
        'authentication must be created by createAuthentication',
      );
    }
    this.#authentication = authentication;
    this.#jobRunner = new JobRunner(jobs);
    this.#httpOptions = normalizeHttpOptions(http);
    this.#webSocketOptions = normalizeWebSocketOptions(websocket, authentication);
  }

  /**
   * Registers a named WebSocket-controller class before listening starts.
   * Регистрирует именованный класс WebSocket-контроллера до начала запуска.
   *
   * @param {Function} WebSocketController Direct subclass of {@link WebSocketControllerBase}. /
   * Прямой подкласс {@link WebSocketControllerBase}.
   * @returns {Application} This application. / Это приложение.
   */
  registerWebSocketController(WebSocketController) {
    if (this.#state !== 'new') {
      throw new ApplicationStateError('Application no longer accepts WebSocket controllers');
    }
    if (this.#webSocketControllerClasses.has(WebSocketController)) {
      throw new DuplicateWebSocketControllerError(
        'WebSocket controller has already been registered',
      );
    }
    this.#webSocketControllers.register(WebSocketController);
    this.#webSocketControllerClasses.add(WebSocketController);
    return this;
  }

  /**
   * Registers all declared HTTP routes of an HTTP-controller class.
   * Регистрирует все объявленные HTTP-маршруты класса HTTP-контроллера.
   *
   * @param {Function} HttpController Direct subclass of {@link HttpControllerBase}. / Прямой
   * подкласс {@link HttpControllerBase}.
   * @returns {Application} This application. / Это приложение.
   */
  registerHttpController(HttpController) {
    if (this.#state !== 'new') {
      throw new ApplicationStateError('Application no longer accepts HTTP controllers');
    }
    if (this.#httpControllers.has(HttpController)) {
      throw new DuplicateHttpControllerError('HTTP controller has already been registered');
    }

    const { prefix, routes } = validateControllerClass(HttpController);
    let prefixSegments;
    try {
      prefixSegments = pathSegments(prefix);
    } catch (error) {
      throw controllerError('HTTP controller prefix is invalid', error);
    }
    const normalizedRoutes = routes.map((declaration) =>
      normalizeRoute(HttpController, prefixSegments, declaration, this.#authentication),
    );

    this.#httpRouter.registerAll(normalizedRoutes);
    this.#httpControllers.add(HttpController);
    return this;
  }

  /**
   * Starts the shared HTTP/WebSocket transport exactly once.
   * Однократно запускает общий HTTP/WebSocket-транспорт.
   *
   * @param {ListenOptions} options Listen address. / Адрес прослушивания.
   * @returns {Promise<AddressInfo|string|null>} Bound address. / Фактический
   * адрес.
   * @throws {ApplicationStateError} When the application has already started or closed. / Если
   * приложение уже запускалось или закрыто.
   */
  async listen({ port, host = '127.0.0.1' }) {
    if (this.#state !== 'new') throw new ApplicationStateError('Application cannot listen');
    this.#state = 'starting';
    this.#listenPromise = new Promise((resolve, reject) => {
      const server = nodeHttp.createServer((request, response) => {
        this.#handleHttpRequest(request, response).catch((error) => {
          if (response.headersSent || response.destroyed) return;
          if (request.aborted || error.code === 'ECONNRESET') {
            response.destroy();
            return;
          }
          if (
            error instanceof InfrastructureHttpError ||
            error instanceof InvalidHttpPathEncodingError
          ) {
            const status = error instanceof InvalidHttpPathEncodingError ? 400 : error.status;
            const message =
              error instanceof InvalidHttpPathEncodingError ? 'Bad Request' : error.message;
            this.#writeJson(response, status, { error: message });
            return;
          }
          this.#reportUnexpected(error, undefined);
          this.#writeJson(response, 500, { error: 'Internal Server Error' });
        });
      });
      this.#httpServer = server;
      this.#webSocketTransport = new WebSocketTransport({
        authentication: this.#authentication,
        controllers: this.#webSocketControllers,
        jobRunner: this.#jobRunner,
        onError: this.#webSocketOptions.onError,
        options: this.#webSocketOptions,
        sessionStore: this.#webSocketSessions,
      });
      this.#webSocketTransport.attach(server);
      server.once('error', (error) => {
        this.#state = 'failed';
        reject(error);
      });
      server.listen({ port, host }, () => {
        this.#state = 'running';
        resolve(server.address());
      });
    });
    return this.#listenPromise;
  }

  /**

   * Handles one HTTP request through routing, normalization, and response writing. / Обрабатывает один HTTP-запрос через маршрутизацию, нормализацию и запись ответа.

   *

   * @param {IncomingMessage} request Incoming request. / Входящий запрос.

   * @param {ServerResponse} response Server response. / Ответ сервера.

   * @returns {Promise<void>} Completion. / Завершение обработки.

   * @private

   */
  async #handleHttpRequest(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const requestedMethod = request.method.toUpperCase();
    let match = this.#httpRouter.match(requestedMethod, url.pathname);
    if (!match && requestedMethod === 'HEAD') match = this.#httpRouter.match('GET', url.pathname);
    if (!match) {
      const explicitMethods = this.#httpRouter.methodsFor(url.pathname);
      if (explicitMethods.length > 0) {
        const methods = [...explicitMethods];
        const getIndex = methods.indexOf('GET');
        if (getIndex !== -1 && !methods.includes('HEAD')) methods.splice(getIndex + 1, 0, 'HEAD');
        if (!methods.includes('OPTIONS')) methods.push('OPTIONS');
        const allow = methods.join(', ');
        if (requestedMethod === 'OPTIONS') {
          response.writeHead(204, { allow });
          response.end();
          return;
        }
        this.#writeJson(response, 405, { error: 'Method Not Allowed' }, { allow });
        return;
      }
      this.#writeJson(response, 404, { error: 'Not Found' });
      return;
    }

    const abortController = new AbortController();
    const activeRequest = { abortController, response };
    this.#activeRequests.add(activeRequest);
    request.once('aborted', () => abortController.abort());
    response.once('close', () => {
      if (!response.writableFinished) abortController.abort();
      this.#activeRequests.delete(activeRequest);
      if (this.#activeRequests.size === 0) {
        for (const resolve of this.#activeWaiters) resolve();
        this.#activeWaiters.clear();
      }
    });

    let authSession;
    if (typeof match.route.authentication === 'string') {
      const scenario = match.route.authentication;
      try {
        const authenticationResult = await this.#authentication.authenticate(scenario, {
          transport: 'http',
          method: requestedMethod,
          path: url.pathname,
          headers: new Headers(request.headers),
          query: new URLSearchParams(url.searchParams),
          signal: abortController.signal,
        });
        if (authenticationResult.status === 'rejected') {
          this.#writeJson(
            response,
            401,
            { error: { code: authenticationResult.code } },
            authenticationResult.challenge
              ? { 'www-authenticate': authenticationResult.challenge }
              : undefined,
          );
          return;
        }
        if (authenticationResult.status === 'authenticated') {
          authSession = authenticationResult.session;
        }
      } catch (error) {
        if (error instanceof AuthenticationAbortedError) throw error;
        const authenticationContext = Object.freeze({
          phase: 'authentication',
          method: requestedMethod,
          path: url.pathname,
          scenario,
          signal: abortController.signal,
        });
        this.#reportUnexpected(error, authenticationContext);
        this.#writeJson(response, 500, {
          error: { code: 'INTERNAL_SERVER_ERROR' },
        });
        return;
      }
    }

    const chunks = [];
    let byteLength = 0;
    for await (const chunk of request) {
      byteLength += chunk.byteLength;
      if (byteLength <= this.#httpOptions.bodyLimit) chunks.push(chunk);
    }
    if (byteLength > this.#httpOptions.bodyLimit) {
      throw new InfrastructureHttpError(413, 'Payload Too Large');
    }
    const bytes = Buffer.concat(chunks);
    let body;
    if (bytes.byteLength > 0) {
      const mediaType = request.headers['content-type'];
      if (!this.#isJsonMediaType(mediaType)) {
        throw new InfrastructureHttpError(415, 'Unsupported Media Type');
      }
      try {
        body = JSON.parse(UTF8_DECODER.decode(bytes));
      } catch {
        throw new InfrastructureHttpError(400, 'Bad Request');
      }
    }
    const ctx = Object.freeze({
      method: request.method.toUpperCase(),
      path: url.pathname,
      params: match.params,
      query: new URLSearchParams(url.searchParams),
      headers: new Headers(request.headers),
      body,
      signal: abortController.signal,
      ...(authSession ? { authSession } : {}),
    });
    try {
      const controller = new match.route.controller({ jobRunner: this.#jobRunner });
      const result = await controller[match.route.handler](ctx);
      this.#writeHttpResult(response, requestedMethod, result);
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      if (error instanceof HttpError) {
        this.#writeHttpResult(response, requestedMethod, {
          status: error.status,
          headers: error.headers,
          body: error.body,
        });
        return;
      }
      this.#reportUnexpected(error, ctx);
      this.#writeJson(response, 500, { error: 'Internal Server Error' });
    }
  }

  /**

   * Validates, serializes, and writes an HTTP-handler result. / Проверяет, сериализует и записывает результат HTTP-обработчика.

   *

   * @param {ServerResponse} response Server response. / Ответ сервера.

   * @param {string} requestedMethod Requested method. / Запрошенный метод.

   * @param {HttpResponse} result Handler result. / Результат HTTP-обработчика.

   * @private

   */
  #writeHttpResult(response, requestedMethod, result) {
    if (
      result === null ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      Reflect.ownKeys(result).some(
        (key) => typeof key !== 'string' || !['status', 'headers', 'body'].includes(key),
      ) ||
      !Number.isInteger(result.status) ||
      result.status < 200 ||
      result.status > 599 ||
      (result.headers !== undefined && !(result.headers instanceof Headers))
    ) {
      throw new TypeError('HTTP handler returned an invalid HttpResponse');
    }
    const headers = Object.fromEntries(result.headers ?? []);
    for (const name of ['content-length', 'transfer-encoding', 'connection']) {
      if (name in headers) throw new TypeError(`HTTP handler cannot set ${name}`);
    }
    let serialized;
    if (result.body === undefined) serialized = undefined;
    else if (typeof result.body === 'string') {
      serialized = Buffer.from(result.body);
      headers['content-type'] ??= 'text/plain; charset=utf-8';
    } else if (Buffer.isBuffer(result.body) || result.body instanceof Uint8Array) {
      serialized = Buffer.from(result.body);
      headers['content-type'] ??= 'application/octet-stream';
    } else {
      const json = JSON.stringify(result.body);
      if (json === undefined) throw new TypeError('HTTP response body has no JSON representation');
      serialized = Buffer.from(json);
      headers['content-type'] ??= 'application/json; charset=utf-8';
    }
    if (serialized) headers['content-length'] = serialized.byteLength;
    response.writeHead(result.status, headers);
    const suppressBody =
      requestedMethod === 'HEAD' || result.status === 204 || result.status === 304;
    response.end(suppressBody ? undefined : serialized);
  }

  /**

   * Checks whether a Content-Type represents UTF-8 JSON. / Проверяет, является ли Content-Type JSON в UTF-8.

   *

   * @param {*} value Header value. / Значение заголовка.

   * @returns {boolean} Match result. / Результат проверки.

   * @private

   */
  #isJsonMediaType(value) {
    if (typeof value !== 'string') return false;
    const [type, ...parameters] = value.split(';').map((part) => part.trim().toLowerCase());
    if (type !== 'application/json' && !type.endsWith('+json')) return false;
    for (const parameter of parameters) {
      if (parameter.startsWith('charset=') && parameter.slice(8).replaceAll('"', '') !== 'utf-8') {
        return false;
      }
    }
    return true;
  }

  /**

   * Reports an unexpected HTTP error without affecting the response flow. / Сообщает о неожиданной HTTP-ошибке, не влияя на отправку ответа.

   *

   * @param {*} error Reported error. / Ошибка.

   * @param {HttpRequestContext} [ctx] Request context. / Контекст HTTP-запроса.

   * @private

   */
  #reportUnexpected(error, ctx) {
    if (!this.#httpOptions.onError) return;
    try {
      Promise.resolve(this.#httpOptions.onError(error, ctx)).catch(console.error);
    } catch (reportingError) {
      console.error(reportingError);
    }
  }

  /**

   * Waits until no HTTP requests remain active. / Ожидает завершения всех активных HTTP-запросов.

   *

   * @returns {Promise<void>} Completion. / Завершение ожидания.

   * @private

   */
  #waitForActiveRequests() {
    if (this.#activeRequests.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.#activeWaiters.add(resolve));
  }

  /**

   * Writes an infrastructure JSON response. / Записывает инфраструктурный JSON-ответ.

   *

   * @param {ServerResponse} response Server response. / Ответ сервера.

   * @param {number} status HTTP status. / HTTP-статус.

   * @param {*} value JSON value. / JSON-значение.

   * @param {Object<string, string|number>} [headers] Additional headers. / Дополнительные заголовки.

   * @private

   */
  #writeJson(response, status, value, headers = {}) {
    const body = Buffer.from(JSON.stringify(value));
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.byteLength,
      ...headers,
    });
    response.end(body);
  }

  /**
   * Irreversibly closes WebSocket sessions, HTTP activity, and the job runner.
   * Необратимо закрывает WebSocket-сессии, HTTP-активность и исполнитель задач.
   *
   * Repeated calls return the same operation.
   * Повторные вызовы возвращают ту же операцию.
   *
   * @returns {Promise<void>} Application shutdown. / Завершение приложения.
   * @public
   */
  close() {
    if (!this.#closePromise) {
      const stateAtClose = this.#state;
      this.#state = 'closing';
      this.#closePromise = (async () => {
        if (stateAtClose === 'starting') {
          try {
            await this.#listenPromise;
          } catch {}
        }
        if (this.#httpServer) {
          this.#webSocketSessions.closeAll();
          const serverClosing = new Promise((resolve, reject) => {
            this.#httpServer.close((error) => {
              if (error?.code === 'ERR_SERVER_NOT_RUNNING') resolve();
              else if (error) reject(error);
              else resolve();
            });
          });
          let shutdownTimer;
          await Promise.race([
            this.#waitForActiveRequests(),
            new Promise((resolve) => {
              shutdownTimer = setTimeout(resolve, this.#httpOptions.shutdownTimeout);
            }),
          ]);
          clearTimeout(shutdownTimer);
          if (this.#activeRequests.size > 0) {
            for (const activeRequest of this.#activeRequests) {
              activeRequest.abortController.abort();
              activeRequest.response.destroy();
            }
          }
          await serverClosing;
          await this.#webSocketTransport.waitForDisconnects();
        }
        await this.#jobRunner.close();
        this.#state = 'closed';
      })();
    }
    return this.#closePromise;
  }
}

/**
 * Application configuration sections.
 * Разделы конфигурации приложения.
 *
 * @typedef {Object} ApplicationOptions
 * @property {JobRunnerConfig} [jobs] Background-job configuration. / Конфигурация фоновых задач.
 * @property {Authentication} [authentication] Shared Authentication module. / Общий модуль
 * Authentication.
 * @property {HttpOptions} [http] HTTP configuration. / Конфигурация HTTP.
 * @property {WebSocketOptions} websocket WebSocket configuration. / Конфигурация WebSocket.
 * @public
 */

/**
 * HTTP transport configuration.
 * Конфигурация HTTP-транспорта.
 *
 * @typedef {Object} HttpOptions
 * @property {number} [bodyLimit=1048576] Maximum request body bytes. / Максимальный размер тела
 * запроса в байтах.
 * @property {number} [shutdownTimeout=30000] Graceful shutdown timeout in milliseconds. / Тайм-аут
 * корректного завершения в миллисекундах.
 * @property {HttpErrorHandler} [onError] Unexpected-error observer. / Наблюдатель неожиданных ошибок.
 * @public
 */

/**
 * Normalized HTTP configuration used internally.
 * Нормализованная конфигурация HTTP для внутреннего использования.
 *
 * @typedef {Object} NormalizedHttpOptions
 * @property {number} bodyLimit Maximum request body bytes. / Максимальный размер тела запроса.
 * @property {number} shutdownTimeout Shutdown timeout in milliseconds. / Тайм-аут завершения.
 * @property {HttpErrorHandler} [onError] Unexpected-error observer. / Наблюдатель ошибок.
 * @private
 */

/**
 * WebSocket transport and lifecycle configuration.
 * Конфигурация WebSocket-транспорта и жизненного цикла.
 *
 * @typedef {Object} WebSocketOptions
 * @property {false|string} authentication Authentication scenario or explicit opt-out. / Scenario
 * Authentication или явное отключение.
 * @property {string[]} [allowedOrigins=[]] Exact canonical browser origins. / Точные canonical
 * origins браузеров.
 * @property {string} [path='/websocket'] Shared protocol endpoint. / Общий endpoint протокола.
 * @property {number} [maxPayload=1048576] Maximum message bytes. / Максимальный размер сообщения.
 * @property {number} [maxWriteQueueBytes=2097152] Maximum pending framed bytes per connection. /
 * Максимальный размер ожидающих frames одного соединения в байтах.
 * @property {WebSocketConnectHandler} [onConnect] Pre-upgrade lifecycle hook. / Lifecycle-hook до
 * upgrade.
 * @property {WebSocketDisconnectHandler} [onDisconnect] Disconnect lifecycle hook. /
 * Lifecycle-hook отключения.
 * @property {WebSocketErrorHandler} [onError] Error observer. / Наблюдатель ошибок.
 * @public
 */

/**
 * Normalized WebSocket configuration used internally.
 * Нормализованная конфигурация WebSocket для внутреннего использования.
 *
 * @typedef {Object} NormalizedWebSocketOptions
 * @property {false|string} authentication Authentication scenario or explicit opt-out. / Scenario
 * Authentication или явное отключение.
 * @property {string[]} allowedOrigins Frozen exact Origin allowlist. / Замороженный точный
 * allowlist Origin.
 * @property {string} path Shared protocol endpoint. / Общий endpoint протокола.
 * @property {number} maxPayload Maximum message bytes. / Максимальный размер сообщения.
 * @property {number} maxWriteQueueBytes Maximum pending framed bytes per connection. /
 * Максимальный размер ожидающих frames одного соединения в байтах.
 * @property {WebSocketConnectHandler} [onConnect] Connect hook. / Hook подключения.
 * @property {WebSocketDisconnectHandler} [onDisconnect] Disconnect hook. / Hook отключения.
 * @property {WebSocketErrorHandler} [onError] Error observer. / Наблюдатель ошибок.
 * @private
 */

/**
 * Declarative HTTP-route metadata owned by an HTTP-controller class.
 * Декларативные метаданные HTTP-маршрута класса HTTP-контроллера.
 *
 * @typedef {Object} HttpRouteDeclaration
 * @property {string} method HTTP method token. / Токен HTTP-метода.
 * @property {string} path Path relative to the controller prefix. / Путь относительно префикса.
 * @property {string} handler Own controller method name. / Имя собственного метода контроллера.
 * @property {false|string} authentication Authentication scenario or explicit opt-out. / Scenario
 * Authentication или явное отключение.
 * @public
 */

/**
 * Validated HTTP-controller metadata.
 * Проверенные метаданные HTTP-контроллера.
 *
 * @typedef {Object} HttpControllerMetadata
 * @property {string} prefix Controller path prefix. / Префикс пути контроллера.
 * @property {HttpRouteDeclaration[]} routes Declared routes. / Объявленные HTTP-маршруты.
 * @private
 */

/**
 * Normalized HTTP route stored in the application catalog.
 * Нормализованный HTTP-маршрут в каталоге приложения.
 *
 * @typedef {Object} NormalizedHttpRoute
 * @property {string} method Uppercase HTTP method. / HTTP-метод в верхнем регистре.
 * @property {string} path Normalized absolute path. / Нормализованный абсолютный путь.
 * @property {string} handler Handler method name. / Имя метода HTTP-обработчика.
 * @property {Function} controller HTTP-controller class. / Класс HTTP-контроллера.
 * @property {false|string} authentication Authentication scenario or explicit opt-out. / Scenario
 * Authentication или явное отключение.
 * @private
 */

/**
 * Normalized input supplied to an HTTP handler.
 * Нормализованные входные данные HTTP-обработчика.
 *
 * @typedef {Object} HttpRequestContext
 * @property {string} method Requested HTTP method. / Запрошенный HTTP-метод.
 * @property {string} path Requested URL path. / Запрошенный URL-путь.
 * @property {Object<string, string>} params Matched route parameters. / Параметры найденного
 * HTTP-маршрута.
 * @property {URLSearchParams} query Query parameters. / Параметры query string.
 * @property {Headers} headers WHATWG request headers. / WHATWG-заголовки запроса.
 * @property {*} [body] Parsed JSON body. / Разобранное JSON-тело.
 * @property {AbortSignal} signal Request cancellation signal. / Сигнал отмены запроса.
 * @property {AuthSession} [authSession] Confirmed authentication session. / Подтверждённая сессия
 * аутентификации.
 * @public
 */

/**
 * Explicit result returned by an HTTP handler.
 * Явный результат, возвращаемый HTTP-обработчиком.
 *
 * @typedef {Object} HttpResponse
 * @property {number} status HTTP status from 200 through 599. / HTTP-статус от 200 до 599.
 * @property {Headers} [headers] WHATWG response headers. / WHATWG-заголовки ответа.
 * @property {*} [body] JSON-compatible, text, Buffer, or Uint8Array body. / JSON-совместимое,
 * текстовое тело, Buffer или Uint8Array.
 * @public
 */

/**
 * Observes an unexpected HTTP-handler error.
 * Наблюдает неожиданную ошибку HTTP-обработчика.
 *
 * @callback HttpErrorHandler
 * @param {*} error Reported error. / Ошибка.
 * @param {HttpRequestContext|HttpAuthenticationErrorContext} [ctx] Safe context when available. /
 * Безопасный контекст при наличии.
 * @returns {void|Promise<void>} Optional asynchronous completion. / Асинхронное завершение.
 * @public
 */

/**
 * Safe observer context for an HTTP authentication strategy failure.
 * Безопасный observer-контекст сбоя strategy HTTP-аутентификации.
 *
 * @typedef {Object} HttpAuthenticationErrorContext
 * @property {'authentication'} phase Failure phase. / Фаза сбоя.
 * @property {string} method Requested HTTP method. / Запрошенный HTTP-метод.
 * @property {string} path Requested pathname. / Запрошенный pathname.
 * @property {string} scenario Selected scenario name. / Имя выбранного scenario.
 * @property {AbortSignal} signal Request cancellation signal. / Сигнал отмены запроса.
 * @public
 */

/**
 * Address on which the application listens.
 * Адрес прослушивания приложения.
 *
 * @typedef {Object} ListenOptions
 * @property {number} port TCP port. / TCP-порт.
 * @property {string} [host='127.0.0.1'] Host name or address. / Имя или адрес хоста.
 * @public
 */

/**
 * WebSocket lifecycle context shared by connect and disconnect hooks.
 * Контекст жизненного цикла WebSocket для hooks подключения и отключения.
 *
 * @typedef {Object} WebSocketLifecycleContext
 * @property {string} clientId Framework-generated client identifier. / Идентификатор клиента.
 * @property {string} sessionId Framework-generated session identifier. / Идентификатор сессии.
 * @property {string} path Endpoint path. / Путь endpoint.
 * @property {string} [origin] Validated browser Origin. / Проверенный Origin браузера.
 * @property {AbortSignal} signal Session cancellation signal. / Сигнал отмены сессии.
 * @property {AuthSession} [authSession] Confirmed authentication session. / Подтверждённая сессия
 * аутентификации.
 * @public
 */

/**
 * WebSocket disconnect lifecycle context.
 * Контекст жизненного цикла отключения WebSocket.
 *
 * @typedef {Object} WebSocketDisconnectContext
 * @property {string} clientId Framework-generated client identifier. / Идентификатор клиента.
 * @property {string} sessionId Framework-generated session identifier. / Идентификатор сессии.
 * @property {AbortSignal} signal Session cancellation signal. / Сигнал отмены сессии.
 * @property {number} code WebSocket close code. / Код закрытия WebSocket.
 * @property {string} reason WebSocket close reason. / Причина закрытия WebSocket.
 * @property {AuthSession} [authSession] Confirmed authentication session. / Подтверждённая сессия
 * аутентификации.
 * @public
 */

/**
 * Context supplied to a WebSocket-event handler.
 * Контекст, передаваемый обработчику WebSocket-события.
 *
 * @typedef {Object} WebSocketHandlerContext
 * @property {Object<string, *>} body Protocol message body. / Тело сообщения протокола.
 * @property {string} clientId Framework-generated client identifier. / Идентификатор клиента.
 * @property {string} sessionId Framework-generated session identifier. / Идентификатор сессии.
 * @property {AbortSignal} signal Session cancellation signal. / Сигнал отмены сессии.
 * @public
 */

/**
 * WebSocket connection lifecycle hook.
 * Lifecycle-hook подключения WebSocket.
 *
 * @callback WebSocketConnectHandler
 * @param {WebSocketLifecycleContext} ctx Connection context. / Контекст подключения.
 * @returns {void|Promise<void>} Completion. / Завершение hook.
 * @public
 */

/**
 * WebSocket disconnection lifecycle hook.
 * Lifecycle-hook отключения WebSocket.
 *
 * @callback WebSocketDisconnectHandler
 * @param {WebSocketDisconnectContext} ctx Disconnection context. / Контекст отключения.
 * @returns {void|Promise<void>} Completion. / Завершение hook.
 * @public
 */

/**
 * Observes a WebSocket lifecycle or protocol error.
 * Наблюдает ошибку жизненного цикла или протокола WebSocket.
 *
 * @callback WebSocketErrorHandler
 * @param {*} error Reported error. / Ошибка.
 * @param {WebSocketErrorContext} [ctx] Safe lifecycle or session context. / Безопасный lifecycle-
 * или session-контекст.
 * @returns {void|Promise<void>} Optional asynchronous completion. / Асинхронное завершение.
 * @public
 */

/**
 * Safe context for a WebSocket handshake, lifecycle, or session error.
 * Безопасный контекст ошибки WebSocket handshake, lifecycle или сессии.
 *
 * @typedef {Object} WebSocketErrorContext
 * @property {'handshake'|'connect'|'session'|'disconnect'} phase Error phase. / Фаза ошибки.
 * @property {string} [clientId] Framework-generated client identifier. / Идентификатор клиента.
 * @property {string} [sessionId] Framework-generated session identifier. / Идентификатор сессии.
 * @property {string} [path] Handshake or endpoint path. / Путь handshake или endpoint.
 * @property {string} [scenario] Selected authentication scenario. / Выбранный scenario
 * аутентификации.
 * @property {string} [controller] Addressed WebSocket-controller. / Адресованный
 * WebSocket-контроллер.
 * @property {string} [event] Addressed WebSocket-event. / Адресованное WebSocket-событие.
 * @property {AbortSignal} signal Cancellation signal. / Сигнал отмены.
 * @property {AuthSession} [authSession] Confirmed authentication session. / Подтверждённая сессия
 * аутентификации.
 * @public
 */

/**
 * One tracked in-flight HTTP request.
 * Один отслеживаемый активный HTTP-запрос.
 *
 * @typedef {Object} ActiveHttpRequest
 * @property {AbortController} abortController Request cancellation controller. / Контроллер отмены.
 * @property {ServerResponse} response Server response. / Ответ сервера.
 * @private
 */
