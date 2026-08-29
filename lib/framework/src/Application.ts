import nodeHttp from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventDispatcher } from './EventDispatcher.ts';
import { HttpControllerBase } from './HttpControllerBase.ts';
import type { HttpControllerOptions } from './HttpControllerBase.ts';
import { HttpRouter } from './HttpRouter.ts';
import type { NormalizedHttpRoute } from './HttpRouter.ts';
import { EventListenerRegistry } from './EventListenerRegistry.ts';
import { JobRunner } from './JobRunner.ts';
import type { JobRunnerConfig } from './JobRunner.ts';
import { WebSocketControllerRegistry } from './WebSocketControllerRegistry.ts';
import type { WebSocketControllerClass } from './WebSocketControllerRegistry.ts';
import { WebSocketSessionStore } from './WebSocketSessionStore.ts';
import { WebSocketTransport } from './WebSocketTransport.ts';
import { WebSocketSender } from './WebSocketSender.ts';
import {
  ApplicationStateError,
  DuplicateHttpControllerError,
  InvalidHttpControllerError,
  InvalidHttpOptionsError,
  InvalidHttpPathEncodingError,
  InvalidHttpRouteError,
  HttpError,
  DuplicateWebSocketControllerError,
  InvalidEventOptionsError,
  InvalidWebSocketOptionsError,
} from './errors.ts';
import { decodePathSegments, hasExactlyOwnKeys, isHttpToken } from './httpRoute.ts';
import { composeMiddleware, snapshotDeclaredMiddleware, snapshotMiddleware } from './middleware.ts';
import type { ApplicationEventAddress } from './EventSender.ts';

/** Public metadata of a matched HTTP route. / Метаданные найденного HTTP-маршрута. @public */
export interface HttpRouteContext {
  method: string;
  path: string;
  handler: string;
}

/** Normalized HTTP-handler input. / Нормализованный контекст HTTP-обработчика. @public */
export interface HttpRequestContext<Body = any, State extends object = Record<string, unknown>> {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: Headers;
  body?: Body;
  signal: AbortSignal;
  state: State;
  route: HttpRouteContext;
}

/** Explicit HTTP-handler result. / Явный результат HTTP-обработчика. @public */
export interface HttpResponse<Body = unknown> {
  status: number;
  headers?: Headers | Record<string, string | string[]>;
  body?: Body;
}

/** HTTP middleware around a resolved handler. / HTTP middleware вокруг обработчика. @public */
export type HttpMiddleware = (
  context: HttpRequestContext,
  next: () => Promise<HttpResponse>,
) => HttpResponse | Promise<HttpResponse>;

/** Declarative HTTP route. / Декларативный HTTP-маршрут. @public */
export interface HttpRouteDeclaration {
  method: string;
  path: string;
  handler: string;
  middleware?: HttpMiddleware[];
}

/** HTTP-controller class accepted for registration. / Класс HTTP-контроллера для регистрации. @public */
export type HttpControllerClass = {
  new (options: HttpControllerOptions): HttpControllerBase;
  readonly prefix: string;
  readonly routes: readonly HttpRouteDeclaration[];
  readonly middleware?: readonly HttpMiddleware[];
};

/** HTTP transport configuration. / Конфигурация HTTP-транспорта. @public */
export interface HttpOptions {
  bodyLimit?: number;
  shutdownTimeout?: number;
  middleware?: HttpMiddleware[];
  onError?: (error: unknown, context?: HttpRequestContext) => unknown | Promise<unknown>;
}

/** WebSocket connection context. / Контекст WebSocket-подключения. @public */
export interface WebSocketLifecycleContext<State extends object = Record<string, unknown>> {
  clientId: string;
  sessionId: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  signal: AbortSignal;
  state: State;
}

/** WebSocket disconnect context. / Контекст отключения WebSocket. @public */
export interface WebSocketDisconnectContext<
  State extends object = Record<string, unknown>,
> extends WebSocketLifecycleContext<State> {
  code: number;
  reason: string;
}

/** WebSocket message-handler context. / Контекст обработчика WebSocket-сообщения. @public */
export interface WebSocketHandlerContext<
  Body = any,
  State extends object = Record<string, unknown>,
> {
  body: Body;
  clientId: string;
  controller: string;
  event: string;
  sessionId: string;
  signal: AbortSignal;
  state: State;
}

/** WebSocket message middleware. / Middleware WebSocket-сообщения. @public */
export type WebSocketMessageMiddleware = (
  context: WebSocketHandlerContext,
  next: () => Promise<unknown>,
) => unknown | Promise<unknown>;

/** WebSocket transport and lifecycle configuration. / Конфигурация WebSocket. @public */
export interface WebSocketOptions {
  path?: string;
  maxPayload?: number;
  shutdownTimeout?: number;
  middleware?: WebSocketMessageMiddleware[];
  onConnect?: (context: WebSocketLifecycleContext) => unknown | Promise<unknown>;
  onDisconnect?: (context: WebSocketDisconnectContext) => unknown | Promise<unknown>;
  onError?: (
    error: unknown,
    context?: Partial<WebSocketHandlerContext>,
  ) => unknown | Promise<unknown>;
}

/** Addressed application-event configuration. / Конфигурация внутренних событий. @public */
export interface EventOptions {
  queueSize?: number;
  handlerTimeout?: number;
  shutdownTimeout?: number;
  onError?: (error: unknown, context: ApplicationEventAddress) => unknown | Promise<unknown>;
}

/** Application configuration. / Конфигурация приложения. @public */
export interface ApplicationOptions {
  jobs?: JobRunnerConfig;
  http?: HttpOptions;
  websocket?: WebSocketOptions;
  events?: EventOptions;
}

/** Address on which the application listens. / Адрес прослушивания приложения. @public */
export interface ListenOptions {
  port: number;
  host?: string;
}

/** Normalized application-event options. / Нормализованные параметры внутренних событий. @private */
interface NormalizedEventOptions {
  readonly queueSize: number;
  readonly handlerTimeout: number;
  readonly shutdownTimeout: number;
  readonly onError?: EventOptions['onError'];
}

/** Normalized HTTP options. / Нормализованные параметры HTTP. @private */
interface NormalizedHttpOptions {
  bodyLimit: number;
  middleware: readonly HttpMiddleware[];
  shutdownTimeout: number;
  onError?: HttpOptions['onError'];
}

/** Normalized WebSocket options. / Нормализованные параметры WebSocket. @private */
export interface NormalizedWebSocketOptions {
  maxPayload: number;
  middleware: readonly WebSocketMessageMiddleware[];
  path: string;
  shutdownTimeout: number;
  onConnect?: WebSocketOptions['onConnect'];
  onDisconnect?: WebSocketOptions['onDisconnect'];
  onError?: WebSocketOptions['onError'];
}

/** Active HTTP request tracked during shutdown. / Активный HTTP-запрос, отслеживаемый при shutdown. @private */
interface ActiveHttpRequest {
  abortController: AbortController;
  response: ServerResponse;
}

/**

 * Exact fields accepted in an HTTP-route declaration. / Точные поля объявления HTTP-маршрута.

 *
 * @private

 */
const DECLARATION_KEYS = ['handler', 'method', 'path'];
/**
 * Exact fields accepted in an HTTP-route declaration with middleware.
 * Точные поля объявления HTTP-маршрута с middleware.
 * @private
 */
const MIDDLEWARE_DECLARATION_KEYS = ['handler', 'method', 'middleware', 'path'];
/**
 * Supported HTTP configuration keys. / Поддерживаемые ключи конфигурации HTTP.
 * @private
 */
const HTTP_OPTION_KEYS = new Set(['bodyLimit', 'middleware', 'shutdownTimeout', 'onError']);
/**
 * Strict decoder for UTF-8 HTTP request bodies. / Строгий декодер UTF-8 для тел HTTP-запросов.
 * @private
 */
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
/**
 * Supported WebSocket configuration keys. / Поддерживаемые ключи конфигурации WebSocket.
 * @private
 */
const WEBSOCKET_OPTION_KEYS = new Set([
  'maxPayload',
  'middleware',
  'onConnect',
  'onDisconnect',
  'onError',
  'path',
  'shutdownTimeout',
]);
/**
 * Supported application-event configuration keys.
 * Поддерживаемые ключи конфигурации внутренних событий.
 * @private
 */
const EVENT_OPTION_KEYS = new Set(['queueSize', 'handlerTimeout', 'shutdownTimeout', 'onError']);

/**
 * Validates and fills application-event configuration defaults.
 * Проверяет конфигурацию внутренних событий и заполняет значения по умолчанию.
 * @param [options] Event configuration. / Конфигурация событий.
 * @returns Normalized configuration. / Нормализованная конфигурация.
 * @private
 */
function normalizeEventOptions(options: any = {}): NormalizedEventOptions {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new InvalidEventOptionsError('events configuration must be an object');
  }
  if (
    Reflect.ownKeys(options).some(
      (key: any) => typeof key !== 'string' || !EVENT_OPTION_KEYS.has(key),
    )
  ) {
    throw new InvalidEventOptionsError('events configuration contains an unknown field');
  }
  const result: NormalizedEventOptions = {
    queueSize: options.queueSize ?? 1000,
    handlerTimeout: options.handlerTimeout ?? 30_000,
    shutdownTimeout: options.shutdownTimeout ?? 30_000,
    onError: options.onError,
  };
  for (const key of ['queueSize', 'handlerTimeout', 'shutdownTimeout'] as const) {
    if (!Number.isSafeInteger(result[key]) || result[key] <= 0) {
      throw new InvalidEventOptionsError(`${key} is invalid`);
    }
  }
  if (result.onError !== undefined && typeof result.onError !== 'function') {
    throw new InvalidEventOptionsError('onError is invalid');
  }
  return Object.freeze(result);
}

/**
 * Internal HTTP failure with a client-visible status and message.
 * Внутренняя HTTP-ошибка со статусом и сообщением для клиента.
 * @private
 */
class InfrastructureHttpError extends Error {
  /** Client-visible HTTP status. / Видимый клиенту HTTP-статус. @private */
  declare status: number;

  /**
   * @param status HTTP status. / HTTP-статус.
   * @param message Client-visible message. / Сообщение для клиента.
   */
  constructor(status: any, message: any) {
    super(message);
    this.status = status;
  }
}

/**

 * Throws a normalized HTTP-options error. / Выбрасывает нормализованную ошибку параметров HTTP.

 *
 * @param message Error text. / Текст ошибки.

 * @throws {InvalidHttpOptionsError} Always. / Всегда.

 * @private

 */
function invalidHttpOptions(message: any) {
  throw new InvalidHttpOptionsError(message);
}

/**
 * Validates and fills HTTP configuration defaults.
 * Проверяет конфигурацию HTTP и заполняет значения по умолчанию.
 * @param [options] HTTP configuration. / Конфигурация HTTP.
 * @returns Normalized configuration. / Нормализованная конфигурация.
 * @private
 */
function normalizeHttpOptions(options: any = {}): NormalizedHttpOptions {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    invalidHttpOptions('http configuration must be an object');
  }
  if (
    Reflect.ownKeys(options).some(
      (key: any) => typeof key !== 'string' || !HTTP_OPTION_KEYS.has(key),
    )
  ) {
    invalidHttpOptions('http configuration contains an unknown field');
  }
  const bodyLimit = options.bodyLimit ?? 1024 * 1024;
  const shutdownTimeout = options.shutdownTimeout ?? 30_000;
  const onError = options.onError;
  const middleware = snapshotMiddleware<HttpRequestContext, HttpResponse>(
    options.middleware,
    (message: any) => new InvalidHttpOptionsError(message),
  );
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
  return { bodyLimit, middleware, shutdownTimeout, onError };
}

/**
 * Validates and fills WebSocket configuration defaults.
 * Проверяет конфигурацию WebSocket и заполняет значения по умолчанию.
 * @param [options] WebSocket configuration. / Конфигурация WebSocket.
 * @returns Normalized configuration. / Нормализованная конфигурация.
 * @private
 */
function normalizeWebSocketOptions(options: any = {}): NormalizedWebSocketOptions {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new InvalidWebSocketOptionsError('websocket configuration must be an object');
  }
  if (
    Reflect.ownKeys(options).some(
      (key: any) => typeof key !== 'string' || !WEBSOCKET_OPTION_KEYS.has(key),
    )
  ) {
    throw new InvalidWebSocketOptionsError('websocket configuration contains an unknown field');
  }
  const maxPayload = options.maxPayload ?? 1024 * 1024;
  const shutdownTimeout = options.shutdownTimeout ?? 30_000;
  const middleware = snapshotMiddleware<WebSocketHandlerContext, unknown>(
    options.middleware,
    (message: any) => new InvalidWebSocketOptionsError(message),
  );
  if (!Number.isInteger(maxPayload) || maxPayload < 0) {
    throw new InvalidWebSocketOptionsError('maxPayload is invalid');
  }
  if (!Number.isSafeInteger(shutdownTimeout) || shutdownTimeout <= 0) {
    throw new InvalidWebSocketOptionsError('shutdownTimeout is invalid');
  }
  let path: any;
  try {
    if (
      options.path !== undefined &&
      (typeof options.path !== 'string' || !options.path.startsWith('/'))
    ) {
      throw new TypeError();
    }
    path = composePath([], options.path ?? '/websocket');
  } catch {
    throw new InvalidWebSocketOptionsError('path is invalid');
  }
  for (const hook of ['onConnect', 'onDisconnect', 'onError']) {
    if (options[hook] !== undefined && typeof options[hook] !== 'function') {
      throw new InvalidWebSocketOptionsError(`${hook} is invalid`);
    }
  }
  return {
    maxPayload,
    middleware,
    path,
    shutdownTimeout,
    onConnect: options.onConnect,
    onDisconnect: options.onDisconnect,
    onError: options.onError,
  };
}

/**

 * Creates an invalid-controller error with an optional cause. / Создаёт ошибку HTTP-контроллера с необязательной причиной.

 *
 * @param message Error text. / Текст ошибки.

 * @param [cause] Original error. / Исходная ошибка.

 * @returns Created error. / Созданная ошибка.

 * @private

 */
function controllerError(message: any, cause: any = undefined) {
  return new InvalidHttpControllerError(message, cause ? { cause } : undefined);
}

/**

 * Creates an invalid-route error with an optional cause. / Создаёт ошибку HTTP-маршрута с необязательной причиной.

 *
 * @param message Error text. / Текст ошибки.

 * @param [cause] Original error. / Исходная ошибка.

 * @returns Created error. / Созданная ошибка.

 * @private

 */
function routeError(message: any, cause: any = undefined) {
  return new InvalidHttpRouteError(message, cause ? { cause } : undefined);
}

/**

 * Decodes and validates path segments for a route declaration. / Декодирует и проверяет сегменты пути объявления HTTP-маршрута.

 *
 * @param path Absolute path. / Абсолютный путь.

 * @returns Decoded segments. / Декодированные сегменты.

 * @private

 */
function pathSegments(path: any) {
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
 * @param segment Decoded segment. / Декодированный сегмент.

 * @returns Serialized segment. / Сериализованный сегмент.

 * @private

 */
function serializeSegment(segment: any) {
  return segment.replaceAll('%', '%25').replaceAll('/', '%2F');
}

/**

 * Joins decoded prefix segments with a declared route path. / Объединяет сегменты префикса с объявленным путём HTTP-маршрута.

 *
 * @param prefixSegments Prefix segments. / Сегменты префикса.

 * @param path Declared path. / Объявленный путь.

 * @returns Normalized absolute path. / Нормализованный абсолютный путь.

 * @private

 */
function composePath(prefixSegments: any, path: any) {
  const segments = [...prefixSegments, ...pathSegments(path)];
  return segments.length === 0 ? '/' : `/${segments.map(serializeSegment).join('/')}`;
}

/**

 * Reads an own data-property without invoking accessors. / Читает собственное data-свойство без вызова аксессоров.

 *
 * @param object Owner. / Владелец.

 * @param property Property key. / Ключ свойства.

 * @returns Stored value or `undefined`. / Сохранённое значение или `undefined`.

 * @private

 */
function ownDataValue(object: any, property: any) {
  const descriptor = Object.getOwnPropertyDescriptor(object, property);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/**

 * Validates the nominal HTTP-controller contract. / Проверяет номинальный контракт HTTP-контроллера.

 *
 * @param HttpController Candidate class. / Проверяемый класс.

 * @returns Controller metadata. / Метаданные контроллера.

 * @private

 */
function validateControllerClass(HttpController: any) {
  if (
    typeof HttpController !== 'function' ||
    !HttpController.prototype ||
    Object.getPrototypeOf(HttpController.prototype) !== HttpControllerBase.prototype
  ) {
    throw controllerError('HTTP controller must directly extend HttpControllerBase');
  }

  const prefix = ownDataValue(HttpController, 'prefix');
  const routes = ownDataValue(HttpController, 'routes');
  const middleware = snapshotDeclaredMiddleware<HttpRequestContext, HttpResponse>(
    HttpController,
    (message) => controllerError(message),
  );
  if (typeof prefix !== 'string' || prefix === '') {
    throw controllerError('HTTP controller must have its own non-empty prefix');
  }
  if (!Array.isArray(routes) || routes.length === 0) {
    throw controllerError('HTTP controller must have its own non-empty routes array');
  }
  return { middleware, prefix, routes };
}

/**

 * Normalizes one controller route declaration. / Нормализует одно объявление HTTP-маршрута контроллера.

 *
 * @param HttpController Controller class. / Класс контроллера.

 * @param prefixSegments Decoded prefix. / Декодированный префикс.

 * @param declaration Route declaration. / Объявление HTTP-маршрута.

 * @returns Frozen route and middleware snapshot. / Замороженный
 * HTTP-маршрут и снимок middleware.

 * @private

 */
function normalizeRoute(HttpController: any, prefixSegments: any, declaration: any) {
  if (
    declaration === null ||
    typeof declaration !== 'object' ||
    Array.isArray(declaration) ||
    (!hasExactlyOwnKeys(declaration, DECLARATION_KEYS) &&
      !hasExactlyOwnKeys(declaration, MIDDLEWARE_DECLARATION_KEYS))
  ) {
    throw routeError('HTTP route declaration has invalid fields');
  }

  const { handler, method, path } = declaration;
  if (
    !isHttpToken(method) ||
    typeof path !== 'string' ||
    path === '' ||
    typeof handler !== 'string' ||
    handler === ''
  ) {
    throw routeError('HTTP route declaration fields must be valid non-empty strings');
  }

  const handlerDescriptor = Object.getOwnPropertyDescriptor(HttpController.prototype, handler);
  if (
    handler === 'constructor' ||
    !handlerDescriptor ||
    typeof handlerDescriptor.value !== 'function'
  ) {
    throw controllerError('HTTP handler must be an own instance method');
  }

  const middleware = snapshotDeclaredMiddleware<HttpRequestContext, HttpResponse>(
    declaration,
    (message) => routeError(message),
  );
  return {
    route: Object.freeze({
      method: method.toUpperCase(),
      path: composePath(prefixSegments, path),
      handler,
      controller: HttpController,
    }),
    middleware,
  };
}

/**
 * Composes HTTP, WebSocket, and background-job capabilities and owns their lifecycle.
 * Компонует HTTP-, WebSocket-возможности и фоновые задачи и владеет их жизненным циклом.
 * @public
 */
export class Application {
  /**
   * HTTP-route catalog. / Каталог HTTP-маршрутов.
   * @private
   */
  #httpRouter = new HttpRouter();
  /**
   * Registered HTTP-controller classes. / Классы зарегистрированных HTTP-контроллеров.
   * @private
   */
  #httpControllers = new Set<NormalizedHttpRoute['controller']>();
  /**
   * HTTP-controller middleware snapshots. / Снимки middleware
   * HTTP-контроллеров.
   * @private
   */
  #httpControllerMiddleware = new Map<
    NormalizedHttpRoute['controller'],
    readonly HttpMiddleware[]
  >();
  /**
   * HTTP-route middleware snapshots. / Снимки
   * middleware HTTP-маршрутов.
   * @private
   */
  #httpRouteMiddleware = new WeakMap<NormalizedHttpRoute, readonly HttpMiddleware[]>();
  /**
   * Application-owned job runner. / Принадлежащий приложению исполнитель задач.
   * @private
   */
  #jobRunner: JobRunner;
  /**
   * HTTP transport options. / Параметры HTTP-транспорта.
   * @private
   */
  #httpOptions: NormalizedHttpOptions;
  /**
   * Shared HTTP server. / Общий HTTP-сервер.
   * @private
   */
  #httpServer: Server | undefined;
  /**
   * Idempotent close operation. / Идемпотентная операция закрытия.
   * @private
   */
  #closePromise: Promise<void> | undefined;
  /**
   * One-shot listen operation. / Однократная операция запуска.
   * @private
   */
  #listenPromise: Promise<AddressInfo> | undefined;
  /**
   * Lifecycle state. / Состояние жизненного цикла.
   * @private
   */
  #state: 'new' | 'starting' | 'running' | 'failed' | 'closing' | 'closed' = 'new';
  /**
   * In-flight HTTP requests. / Активные HTTP-запросы.
   * @private
   */
  #activeRequests = new Set<ActiveHttpRequest>();
  /**
   * Resolvers waiting for HTTP requests. / Ожидающие HTTP-запросы функции завершения.
   * @private
   */
  #activeWaiters = new Set<() => void>();
  /**
   * Unsettled user HTTP-handler operations. / Незавершённые операции
   * пользовательских HTTP-обработчиков.
   * @private
   */
  #activeHttpHandlers = new Set<Promise<unknown>>();
  /**
   * HTTP-handler settlement waiters. / Ожидающие settlement HTTP-handler.
   * @private
   */
  #httpHandlerWaiters = new Set<() => void>();
  /**
   * WebSocket-controller catalog. / Каталог WebSocket-контроллеров.
   * @private
   */
  #webSocketControllers = new WebSocketControllerRegistry();
  /**
   * Registered WebSocket-controller classes. / Классы зарегистрированных WebSocket-контроллеров.
   * @private
   */
  #webSocketControllerClasses = new Set<WebSocketControllerClass>();
  /**
   * WebSocket transport options. / Параметры WebSocket-транспорта.
   * @private
   */
  #webSocketOptions: NormalizedWebSocketOptions;
  /**
   * Active WebSocket sessions. / Активные WebSocket-сессии.
   * @private
   */
  #webSocketSessions = new WebSocketSessionStore();
  /**
   * WebSocket transport. / WebSocket-транспорт.
   * @private
   */
  #webSocketTransport: WebSocketTransport | undefined;
  /** HTTP-controller server-push facade. / Фасад server push HTTP-контроллеров. */
  #webSocketSender: WebSocketSender;
  /**
   * Registered event-listener catalog. / Каталог зарегистрированных
   * слушателей событий.
   * @private
   */
  #eventListeners = new EventListenerRegistry();
  /**
   * Application-event options. / Параметры внутренних событий.
   * @private
   */
  #eventOptions: NormalizedEventOptions;
  /**
   * Application-event runtime. / Runtime внутренних событий.
   * @private
   */
  #eventDispatcher: EventDispatcher;

  /**
   * Creates an application and its owned job runner.
   * Создаёт приложение и принадлежащий ему исполнитель задач.
   * @param [options] Application configuration. / Конфигурация приложения.
   * @throws {InvalidEventOptionsError|InvalidHttpOptionsError|InvalidWebSocketOptionsError|InvalidJobOptionsError}
   * When a configuration section is invalid. / Если раздел конфигурации некорректен.
   */
  constructor({ jobs, http, websocket, events }: ApplicationOptions = {}) {
    this.#jobRunner = new JobRunner(jobs);
    this.#httpOptions = normalizeHttpOptions(http);
    this.#webSocketOptions = normalizeWebSocketOptions(websocket);
    this.#eventOptions = normalizeEventOptions(events);
    this.#eventDispatcher = new EventDispatcher(this.#eventListeners, this.#eventOptions);
    this.#webSocketSender = new WebSocketSender(
      this.#webSocketSessions,
      this.#webSocketOptions.maxPayload,
    );
  }

  /**
   * Registers a named WebSocket-controller class before listening starts.
   * Регистрирует именованный класс WebSocket-контроллера до начала запуска.
   * @param WebSocketController Direct subclass of {@link WebSocketControllerBase}. /
   * Прямой подкласс {@link WebSocketControllerBase}.
   * @returns This application. / Это приложение.
   */
  registerWebSocketController(WebSocketController: WebSocketControllerClass): this {
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
   * Registers an addressed application-event listener before listening starts.
   * Регистрирует слушателя адресуемых внутренних событий до начала запуска.
   * @param EventListener Listener class. / Класс слушателя.
   * @returns This application. / Это приложение.
   * @public
   */
  registerEventListener(EventListener: any) {
    if (this.#state !== 'new') {
      throw new ApplicationStateError('Application no longer accepts event listeners');
    }
    this.#eventListeners.register(EventListener);
    return this;
  }

  /**
   * Registers all declared HTTP routes of an HTTP-controller class.
   * Регистрирует все объявленные HTTP-маршруты класса HTTP-контроллера.
   * @param HttpController Direct subclass of {@link HttpControllerBase}. / Прямой
   * подкласс {@link HttpControllerBase}.
   * @returns This application. / Это приложение.
   */
  registerHttpController(HttpController: HttpControllerClass): this {
    if (this.#state !== 'new') {
      throw new ApplicationStateError('Application no longer accepts HTTP controllers');
    }
    if (this.#httpControllers.has(HttpController)) {
      throw new DuplicateHttpControllerError('HTTP controller has already been registered');
    }

    const { middleware, prefix, routes } = validateControllerClass(HttpController);
    let prefixSegments: any;
    try {
      prefixSegments = pathSegments(prefix);
    } catch (error) {
      throw controllerError('HTTP controller prefix is invalid', error);
    }
    const normalizedMetadata = routes.map((declaration: any) =>
      normalizeRoute(HttpController, prefixSegments, declaration),
    );
    const normalizedRoutes = normalizedMetadata.map((metadata: any) => metadata.route);

    this.#httpRouter.registerAll(normalizedRoutes);
    this.#httpControllerMiddleware.set(HttpController, middleware);
    for (const metadata of normalizedMetadata) {
      this.#httpRouteMiddleware.set(metadata.route, metadata.middleware);
    }
    this.#httpControllers.add(HttpController);
    return this;
  }

  /**
   * Starts the shared HTTP/WebSocket transport exactly once.
   * Однократно запускает общий HTTP/WebSocket-транспорт.
   * @param options Listen address. / Адрес прослушивания.
   * @returns Bound address. / Фактический
   * адрес.
   * @throws {ApplicationStateError} When the application has already started or closed. / Если
   * приложение уже запускалось или закрыто.
   */
  async listen({ port, host = '127.0.0.1' }: ListenOptions): Promise<AddressInfo> {
    if (this.#state !== 'new') throw new ApplicationStateError('Application cannot listen');
    this.#state = 'starting';
    try {
      this.#eventDispatcher.start({
        jobRunner: this.#jobRunner,
        websocket: this.#webSocketSender,
      });
    } catch (error) {
      this.#state = 'failed';
      throw error;
    }
    this.#listenPromise = new Promise<any>((resolve: any, reject: any) => {
      const server = nodeHttp.createServer((request: any, response: any) => {
        this.#handleHttpRequest(request, response).catch((error: any) => {
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
        controllers: this.#webSocketControllers,
        events: this.#eventDispatcher.sender,
        jobRunner: this.#jobRunner,
        onError: this.#webSocketOptions.onError,
        options: this.#webSocketOptions,
        sessionStore: this.#webSocketSessions,
      });
      this.#webSocketTransport.attach(server);
      server.once('error', (error: any) => {
        this.#state = 'failed';
        reject(error);
      });
      server.listen({ port, host }, () => {
        this.#state = 'running';
        resolve(server.address());
      });
    });
    return this.#listenPromise as Promise<AddressInfo>;
  }

  /**

   * Handles one HTTP request through routing, normalization, and response writing. / Обрабатывает один HTTP-запрос через маршрутизацию, нормализацию и запись ответа.

   *
   * @param request Incoming request. / Входящий запрос.

   * @param response Server response. / Ответ сервера.

   * @returns Completion. / Завершение обработки.

   * @private

   */
  async #handleHttpRequest(request: any, response: any) {
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
    const chunks: any[] = [];
    let byteLength = 0;
    for await (const chunk of request) {
      byteLength += chunk.byteLength;
      if (byteLength <= this.#httpOptions.bodyLimit) chunks.push(chunk);
    }
    if (byteLength > this.#httpOptions.bodyLimit) {
      throw new InfrastructureHttpError(413, 'Payload Too Large');
    }
    const bytes = Buffer.concat(chunks);
    let body: any;
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
      state: Object.create(null),
      route: Object.freeze({
        method: match.route.method,
        path: match.route.path,
        handler: match.route.handler,
      }),
    });
    try {
      const execute = composeMiddleware(
        [
          ...this.#httpOptions.middleware,
          ...this.#httpControllerMiddleware.get(match.route.controller)!,
          ...this.#httpRouteMiddleware.get(match.route)!,
        ],
        () => {
          const controller = new match.route.controller({
            jobRunner: this.#jobRunner,
            websocket: this.#webSocketSender,
            events: this.#eventDispatcher.sender,
          });
          let result: any;
          try {
            result = controller[match.route.handler](ctx);
          } catch (error) {
            result = Promise.reject(error);
          }
          const operation = Promise.resolve(result);
          this.#activeHttpHandlers.add(operation);
          const settled = () => {
            this.#activeHttpHandlers.delete(operation);
            if (this.#activeHttpHandlers.size === 0) {
              for (const resolve of this.#httpHandlerWaiters) resolve();
              this.#httpHandlerWaiters.clear();
            }
          };
          operation.then(settled, settled);
          return operation;
        },
      );
      const result = await execute(ctx);
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
   * @param response Server response. / Ответ сервера.

   * @param requestedMethod Requested method. / Запрошенный метод.

   * @param result Handler result. / Результат HTTP-обработчика.

   * @private

   */
  #writeHttpResult(response: any, requestedMethod: any, result: any) {
    if (
      result === null ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      Reflect.ownKeys(result).some(
        (key: any) => typeof key !== 'string' || !['status', 'headers', 'body'].includes(key),
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
    let serialized: any;
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
   * @param value Header value. / Значение заголовка.

   * @returns Match result. / Результат проверки.

   * @private

   */
  #isJsonMediaType(value: any) {
    if (typeof value !== 'string') return false;
    const [type, ...parameters] = value.split(';').map((part: any) => part.trim().toLowerCase());
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
   * @param error Reported error. / Ошибка.

   * @param [ctx] Request context. / Контекст HTTP-запроса.

   * @private

   */
  #reportUnexpected(error: any, ctx?: any) {
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
   * @returns Completion. / Завершение ожидания.

   * @private

   */
  #waitForActiveRequests() {
    if (this.#activeRequests.size === 0) return Promise.resolve();
    return new Promise<any>((resolve: any) => this.#activeWaiters.add(resolve));
  }

  /**
   * Waits for settlement of all started user HTTP handlers.
   * Ждёт settlement всех запущенных пользовательских HTTP-обработчиков.
   * @returns Completion. / Завершение ожидания.
   * @private
   */
  #waitForHttpHandlers() {
    if (this.#activeHttpHandlers.size === 0) return Promise.resolve();
    return new Promise<any>((resolve: any) => this.#httpHandlerWaiters.add(resolve));
  }

  /**

   * Writes an infrastructure JSON response. / Записывает инфраструктурный JSON-ответ.

   *
   * @param response Server response. / Ответ сервера.

   * @param status HTTP status. / HTTP-статус.

   * @param value JSON value. / JSON-значение.

   * @param [headers] Additional headers. / Дополнительные заголовки.

   * @private

   */
  #writeJson(response: any, status: any, value: any, headers: any = {}) {
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
   * Repeated calls return the same operation.
   * Повторные вызовы возвращают ту же операцию.
   * @returns Application shutdown. / Завершение приложения.
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
          const server = this.#httpServer;
          this.#webSocketSessions.closeAll();
          const serverClosing = new Promise<any>((resolve: any, reject: any) => {
            server.close((error: any) => {
              if (error?.code === 'ERR_SERVER_NOT_RUNNING') resolve();
              else if (error) reject(error);
              else resolve();
            });
          });
          let shutdownTimer: any;
          await Promise.race([
            Promise.all([this.#waitForActiveRequests(), this.#waitForHttpHandlers()]),
            new Promise<any>((resolve: any) => {
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
          await this.#webSocketTransport!.waitForSettlement(
            serverClosing,
            this.#webSocketOptions.shutdownTimeout,
          );
          await serverClosing;
        }
        await this.#eventDispatcher.close();
        await this.#jobRunner.close();
        this.#state = 'closed';
      })();
    }
    return this.#closePromise;
  }
}
