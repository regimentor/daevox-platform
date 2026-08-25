import { InvalidAuthenticationOptionsError } from './errors.js';

/**
 * RFC token syntax used by cookie names. / Синтаксис RFC token для имён cookie.
 *
 * @type {RegExp}
 * @private
 */
const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Valid unquoted RFC cookie-octet sequence. / Допустимая непустая RFC cookie-octet последовательность.
 *
 * @type {RegExp}
 * @private
 */
const COOKIE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/;

/**
 * RFC token68 credential syntax. / Синтаксис credential RFC token68.
 *
 * @type {RegExp}
 * @private
 */
const TOKEN68 = /^[A-Za-z0-9\-._~+/]+=*$/;

/**
 * Credential-free failure used when a user preset callback fails.
 * Ошибка без credential для сбоя пользовательского callback preset.
 *
 * @private
 */
class AuthenticationPresetCallbackError extends Error {
  /**
   * Creates a stable failure without retaining the callback error.
   * Создаёт стабильную ошибку без сохранения ошибки callback.
   *
   * @private
   */
  constructor() {
    super('Authentication preset callback failed');
  }
}

/**
 * Tests whether a value has exactly the required own data properties.
 * Проверяет точное наличие обязательных собственных data-свойств.
 *
 * @param {*} value Candidate object. / Проверяемый объект.
 * @param {string[]} keys Required keys. / Обязательные ключи.
 * @returns {boolean} Whether the shape is exact. / Является ли форма точной.
 * @private
 */
function hasExactDataKeys(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string'))
    return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor && descriptor.value !== undefined;
  });
}

/**
 * Calls a user credential callback without retaining a rejected error.
 * Вызывает пользовательский credential callback без сохранения отклонённой ошибки.
 *
 * @param {Function} callback User callback. / Пользовательский callback.
 * @param {string} credential Raw credential. / Исходный credential.
 * @param {Object} metadata Safe callback metadata. / Безопасные metadata callback.
 * @returns {Promise<*>} Callback outcome. / Результат callback.
 * @throws {AuthenticationPresetCallbackError} When the callback fails. / При сбое callback.
 * @private
 */
async function callPresetCallback(callback, credential, metadata) {
  try {
    return await callback(credential, metadata);
  } catch {
    throw new AuthenticationPresetCallbackError();
  }
}

/**
 * Creates an HTTP Bearer authentication strategy.
 * Создаёт strategy HTTP Bearer-аутентификации.
 *
 * @param {BearerTokenOptions} options Preset options. / Параметры preset.
 * @returns {AuthenticationStrategy} Authentication strategy. / Strategy аутентификации.
 * @throws {InvalidAuthenticationOptionsError} When options are invalid. / При неверных параметрах.
 * @public
 */
export function bearerToken(options) {
  if (!hasExactDataKeys(options, ['verify']) || typeof options.verify !== 'function') {
    throw new InvalidAuthenticationOptionsError('bearerToken options are invalid');
  }
  const verify = options.verify;

  return Object.freeze({
    /**
     * Authenticates one normalized input with a Bearer credential.
     * Аутентифицирует один нормализованный input с Bearer credential.
     *
     * @param {Object} input Normalized strategy input. / Нормализованный input strategy.
     * @returns {Promise<Object>} Tagged strategy result. / Tagged result strategy.
     * @public
     */
    async authenticate(input) {
      const authorization = input.headers.get('authorization');
      if (authorization === null) return { status: 'abstain' };
      const match = /^Bearer( +)(.*)$/i.exec(authorization);
      if (!match) {
        if (!/^Bearer(?:$|[^!#$%&'*+.^_`|~0-9A-Za-z-])/i.test(authorization)) {
          return { status: 'abstain' };
        }
        return { status: 'rejected', code: 'INVALID_TOKEN', challenge: 'Bearer' };
      }
      const token = match[2];
      if (!TOKEN68.test(token)) {
        return { status: 'rejected', code: 'INVALID_TOKEN', challenge: 'Bearer' };
      }
      const session = await callPresetCallback(
        verify,
        token,
        Object.freeze({ transport: input.transport, signal: input.signal }),
      );
      if (
        session === null ||
        (session !== null &&
          typeof session === 'object' &&
          Number.isSafeInteger(session.expiresAt) &&
          session.expiresAt > 0 &&
          session.expiresAt <= Date.now())
      ) {
        return { status: 'rejected', code: 'INVALID_TOKEN', challenge: 'Bearer' };
      }
      return { status: 'authenticated', session };
    },
  });
}

/**
 * Creates a cookie-backed authentication strategy.
 * Создаёт strategy аутентификации на основе cookie.
 *
 * @param {CookieSessionOptions} options Preset options. / Параметры preset.
 * @returns {AuthenticationStrategy} Authentication strategy. / Strategy аутентификации.
 * @throws {InvalidAuthenticationOptionsError} When options are invalid. / При неверных параметрах.
 * @public
 */
export function cookieSession(options) {
  if (
    !hasExactDataKeys(options, ['cookie', 'resolve']) ||
    !hasExactDataKeys(options.cookie, ['name']) ||
    typeof options.cookie.name !== 'string' ||
    !COOKIE_NAME.test(options.cookie.name) ||
    typeof options.resolve !== 'function'
  ) {
    throw new InvalidAuthenticationOptionsError('cookieSession options are invalid');
  }
  const cookieName = options.cookie.name;
  const resolve = options.resolve;

  return Object.freeze({
    /**
     * Authenticates one normalized input with a session cookie.
     * Аутентифицирует один нормализованный input с session cookie.
     *
     * @param {Object} input Normalized strategy input. / Нормализованный input strategy.
     * @returns {Promise<Object>} Tagged strategy result. / Tagged result strategy.
     * @public
     */
    async authenticate(input) {
      const values = [];
      for (const segment of (input.headers.get('cookie') ?? '').split(';')) {
        const trimmed = segment.replace(/^[\t ]+|[\t ]+$/g, '');
        const separator = trimmed.indexOf('=');
        if (separator !== -1 && trimmed.slice(0, separator) === cookieName) {
          values.push(trimmed.slice(separator + 1));
        }
      }
      if (values.length === 0) return { status: 'abstain' };
      if (values.length !== 1 || !COOKIE_VALUE.test(values[0])) {
        return { status: 'rejected', code: 'INVALID_SESSION' };
      }
      const session = await callPresetCallback(
        resolve,
        values[0],
        Object.freeze({ transport: input.transport, signal: input.signal }),
      );
      if (
        session === null ||
        (session !== null &&
          typeof session === 'object' &&
          Number.isSafeInteger(session.expiresAt) &&
          session.expiresAt > 0 &&
          session.expiresAt <= Date.now())
      ) {
        return { status: 'rejected', code: 'INVALID_SESSION' };
      }
      return { status: 'authenticated', session };
    },
  });
}

/**
 * Creates a one-time WebSocket-handshake ticket strategy.
 * Создаёт strategy одноразового ticket WebSocket-handshake.
 *
 * @param {OneTimeWebSocketTicketOptions} options Preset options. / Параметры preset.
 * @returns {AuthenticationStrategy} Authentication strategy. / Strategy аутентификации.
 * @throws {InvalidAuthenticationOptionsError} When options are invalid. / При неверных параметрах.
 * @public
 */
export function oneTimeWebSocketTicket(options) {
  if (!hasExactDataKeys(options, ['consume']) || typeof options.consume !== 'function') {
    throw new InvalidAuthenticationOptionsError('oneTimeWebSocketTicket options are invalid');
  }
  const consume = options.consume;

  return Object.freeze({
    /**
     * Authenticates one normalized WebSocket input with a one-time ticket.
     * Аутентифицирует один нормализованный WebSocket input одноразовым ticket.
     *
     * @param {Object} input Normalized strategy input. / Нормализованный input strategy.
     * @returns {Promise<Object>} Tagged strategy result. / Tagged result strategy.
     * @public
     */
    async authenticate(input) {
      if (input.transport !== 'websocket') return { status: 'abstain' };
      const tickets = input.query.getAll('ticket');
      if (tickets.length === 0) return { status: 'abstain' };
      if (tickets.length !== 1 || tickets[0] === '') {
        return { status: 'rejected', code: 'INVALID_TICKET' };
      }
      const metadata = Object.freeze({
        ...(Object.hasOwn(input, 'origin') ? { origin: input.origin } : {}),
        signal: input.signal,
      });
      const session = await callPresetCallback(consume, tickets[0], metadata);
      if (
        session === null ||
        (session !== null &&
          typeof session === 'object' &&
          Number.isSafeInteger(session.expiresAt) &&
          session.expiresAt > 0 &&
          session.expiresAt <= Date.now())
      ) {
        return { status: 'rejected', code: 'INVALID_TICKET' };
      }
      return { status: 'authenticated', session };
    },
  });
}

/**
 * Bearer-token preset configuration. / Конфигурация Bearer-token preset.
 *
 * @typedef {Object} BearerTokenOptions
 * @property {BearerTokenVerifier} verify Credential verifier. / Функция проверки credential.
 * @public
 */

/**
 * Verifies one Bearer token. / Проверяет один Bearer token.
 *
 * @callback BearerTokenVerifier
 * @param {string} token Exact token68 credential. / Точный credential token68.
 * @param {AuthenticationPresetMetadata} metadata Safe attempt metadata. / Безопасные metadata
 * попытки.
 * @returns {Object|null|Promise<Object|null>} Session or rejection signal. / Session или сигнал
 * отказа.
 * @public
 */

/**
 * Shared metadata for cookie and Bearer callbacks.
 * Общие metadata для cookie- и Bearer-callback.
 *
 * @typedef {Object} AuthenticationPresetMetadata
 * @property {'http'|'websocket'} transport Transport kind. / Вид transport.
 * @property {AbortSignal} signal Attempt cancellation signal. / Сигнал отмены попытки.
 * @public
 */

/**
 * One-time WebSocket-ticket preset configuration.
 * Конфигурация preset одноразового WebSocket-ticket.
 *
 * @typedef {Object} OneTimeWebSocketTicketOptions
 * @property {OneTimeWebSocketTicketConsumer} consume Atomic ticket consumer. / Функция атомарного
 * погашения ticket.
 * @public
 */

/**
 * Atomically consumes one WebSocket ticket. / Атомарно погашает один WebSocket-ticket.
 *
 * @callback OneTimeWebSocketTicketConsumer
 * @param {string} ticket Decoded opaque query value. / Декодированное opaque query-значение.
 * @param {WebSocketTicketMetadata} metadata Safe handshake metadata. / Безопасные metadata
 * handshake.
 * @returns {Object|null|Promise<Object|null>} Session or rejection signal. / Session или сигнал
 * отказа.
 * @public
 */

/**
 * Safe callback metadata for a WebSocket ticket.
 * Безопасные metadata callback для WebSocket-ticket.
 *
 * @typedef {Object} WebSocketTicketMetadata
 * @property {string} [origin] Validated handshake Origin. / Проверенный Origin handshake.
 * @property {AbortSignal} signal Handshake cancellation signal. / Сигнал отмены handshake.
 * @public
 */

/**
 * Cookie-session preset configuration. / Конфигурация cookie-session preset.
 *
 * @typedef {Object} CookieSessionOptions
 * @property {CookieSelector} cookie Cookie selector. / Селектор cookie.
 * @property {CookieSessionResolver} resolve Credential resolver. / Функция разрешения credential.
 * @public
 */

/**
 * Session-cookie selector. / Селектор session cookie.
 *
 * @typedef {Object} CookieSelector
 * @property {string} name Exact case-sensitive RFC cookie name. / Точное регистрозависимое RFC-имя
 * cookie.
 * @public
 */

/**
 * Resolves one session-cookie value. / Разрешает одно значение session cookie.
 *
 * @callback CookieSessionResolver
 * @param {string} cookieValue Exact opaque cookie value. / Точное opaque-значение cookie.
 * @param {AuthenticationPresetMetadata} metadata Safe attempt metadata. / Безопасные metadata
 * попытки.
 * @returns {Object|null|Promise<Object|null>} Session or rejection signal. / Session или сигнал
 * отказа.
 * @public
 */
