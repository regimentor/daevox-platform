import {
  AuthenticationAbortedError,
  AuthenticationStrategyError,
  InvalidAuthenticationOptionsError,
  InvalidAuthenticationResultError,
} from './errors.js';

/**
 * Valid Authentication catalog-name syntax. / Допустимый синтаксис имён каталога Authentication.
 *
 * @type {RegExp}
 * @private
 */
const CATALOG_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Valid rejected-result code syntax. / Допустимый синтаксис кода rejected-результата.
 *
 * @type {RegExp}
 * @private
 */
const REJECTION_CODE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Valid uppercase HTTP method syntax. / Допустимый синтаксис HTTP-метода в верхнем регистре.
 *
 * @type {RegExp}
 * @private
 */
const HTTP_METHOD = /^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]*$/;

/**
 * Exact top-level Authentication configuration keys.
 * Точные ключи верхнеуровневой конфигурации Authentication.
 *
 * @type {string[]}
 * @private
 */
const AUTHENTICATION_KEYS = ['scenarios', 'strategies'];

/**
 * Exact custom-strategy keys. / Точные ключи custom strategy.
 *
 * @type {string[]}
 * @private
 */
const STRATEGY_KEYS = ['authenticate'];

/**
 * Exact scenario keys. / Точные ключи scenario.
 *
 * @type {string[]}
 * @private
 */
const SCENARIO_KEYS = ['required', 'use'];

/**
 * Exact HTTP strategy-input keys. / Точные ключи HTTP input strategy.
 *
 * @type {string[]}
 * @private
 */
const HTTP_INPUT_KEYS = ['headers', 'method', 'path', 'query', 'signal', 'transport'];

/**
 * Exact WebSocket strategy-input keys. / Точные ключи WebSocket input strategy.
 *
 * @type {string[]}
 * @private
 */
const WEBSOCKET_INPUT_KEYS = [
  'headers',
  'method',
  'origin',
  'path',
  'query',
  'signal',
  'transport',
];

/**
 * Framework-created Authentication instances. / Созданные фреймворком экземпляры Authentication.
 *
 * @type {WeakSet<Object>}
 * @private
 */
const AUTHENTICATION_INSTANCES = new WeakSet();

/**
 * Scenario catalogs owned by framework-created Authentication instances.
 * Каталоги scenarios, принадлежащие созданным фреймворком экземплярам Authentication.
 *
 * @type {WeakMap<Object, Map<string, AuthenticationScenario>>}
 * @private
 */
const AUTHENTICATION_SCENARIOS = new WeakMap();

/**
 * Throws a normalized Authentication-options error.
 * Выбрасывает нормализованную ошибку параметров Authentication.
 *
 * @param {string} message Error text without configuration values. / Текст без значений
 * конфигурации.
 * @throws {InvalidAuthenticationOptionsError} Always. / Всегда.
 * @private
 */
function invalidOptions(message) {
  throw new InvalidAuthenticationOptionsError(message);
}

/**
 * Tests an object for exact own data-property keys.
 * Проверяет точный набор собственных data-свойств объекта.
 *
 * @param {*} value Candidate object. / Проверяемый объект.
 * @param {string[]} keys Allowed keys. / Допустимые ключи.
 * @param {string[]} [optional=[]] Optional keys. / Необязательные ключи.
 * @returns {boolean} Whether the object has the exact shape. / Соответствует ли объект форме.
 * @private
 */
function hasExactDataKeys(value, keys, optional = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) return false;
  const allowed = new Set(keys);
  if (ownKeys.some((key) => !allowed.has(key))) return false;
  if (keys.some((key) => !optional.includes(key) && !ownKeys.includes(key))) return false;
  return ownKeys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor && descriptor.value !== undefined;
  });
}

/**
 * Reads a non-empty catalog containing enumerable data properties.
 * Читает непустой каталог с перечислимыми data-свойствами.
 *
 * @param {*} value Candidate catalog. / Проверяемый каталог.
 * @param {string} label Catalog label for errors. / Название каталога для ошибок.
 * @returns {Array<[string, *]>} Stable catalog entries. / Стабильные элементы каталога.
 * @private
 */
function catalogEntries(value, label) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    invalidOptions(`${label} must be a record`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length === 0) invalidOptions(`${label} must not be empty`);
  const entries = [];
  for (const key of keys) {
    if (typeof key !== 'string' || !CATALOG_NAME.test(key)) {
      invalidOptions(`${label} contains an invalid name`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      invalidOptions(`${label} must contain enumerable data properties`);
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

/**
 * Copies and freezes a custom strategy declaration.
 * Копирует и замораживает декларацию custom strategy.
 *
 * @param {*} declaration User declaration. / Пользовательская декларация.
 * @returns {AuthenticationStrategy} Normalized strategy. / Нормализованная strategy.
 * @private
 */
function normalizeStrategy(declaration) {
  if (
    !hasExactDataKeys(declaration, STRATEGY_KEYS) ||
    typeof declaration.authenticate !== 'function'
  ) {
    invalidOptions('strategy must contain exactly an authenticate function');
  }
  return Object.freeze({ authenticate: declaration.authenticate });
}

/**
 * Copies and freezes one declarative scenario.
 * Копирует и замораживает один декларативный scenario.
 *
 * @param {*} declaration User declaration. / Пользовательская декларация.
 * @param {Map<string, AuthenticationStrategy>} strategies Normalized strategies. /
 * Нормализованные strategies.
 * @returns {AuthenticationScenario} Normalized scenario. / Нормализованный scenario.
 * @private
 */
function normalizeScenario(declaration, strategies) {
  if (
    !hasExactDataKeys(declaration, SCENARIO_KEYS) ||
    !Array.isArray(declaration.use) ||
    declaration.use.length === 0 ||
    typeof declaration.required !== 'boolean'
  ) {
    invalidOptions('scenario must contain exactly non-empty use and boolean required');
  }
  const use = [];
  const unique = new Set();
  for (const strategy of declaration.use) {
    if (
      typeof strategy !== 'string' ||
      !CATALOG_NAME.test(strategy) ||
      unique.has(strategy) ||
      !strategies.has(strategy)
    ) {
      invalidOptions('scenario contains an invalid strategy reference');
    }
    unique.add(strategy);
    use.push(strategy);
  }
  return Object.freeze({ use: Object.freeze(use), required: declaration.required });
}

/**
 * Validates and snapshots a transport-neutral authentication input.
 * Проверяет и создаёт snapshot transport-neutral input аутентификации.
 *
 * @param {*} input User or transport input. / Пользовательский или transport input.
 * @returns {AuthenticationInputSnapshot} Stable input snapshot. / Стабильный snapshot input.
 * @throws {TypeError} When the input violates its exact transport form. / При нарушении точной
 * transport-формы.
 * @private
 */
function snapshotInput(input) {
  const transport = input?.transport;
  const keys = transport === 'websocket' ? WEBSOCKET_INPUT_KEYS : HTTP_INPUT_KEYS;
  const optional = transport === 'websocket' ? ['origin'] : [];
  if (
    !['http', 'websocket'].includes(transport) ||
    !hasExactDataKeys(input, keys, optional) ||
    !(input.headers instanceof Headers) ||
    !(input.query instanceof URLSearchParams) ||
    !(input.signal instanceof AbortSignal) ||
    typeof input.path !== 'string' ||
    input.path === '' ||
    !input.path.startsWith('/') ||
    typeof input.method !== 'string' ||
    !HTTP_METHOD.test(input.method) ||
    (transport === 'websocket' && input.method !== 'GET') ||
    (Object.hasOwn(input, 'origin') && (typeof input.origin !== 'string' || input.origin === ''))
  ) {
    throw new TypeError('Authentication input is invalid');
  }
  return Object.freeze({
    transport,
    method: input.method,
    path: input.path,
    headers: new Headers(input.headers),
    query: new URLSearchParams(input.query),
    ...(Object.hasOwn(input, 'origin') ? { origin: input.origin } : {}),
    signal: input.signal,
  });
}

/**
 * Creates a fresh isolated input for one strategy invocation.
 * Создаёт новый изолированный input для одного вызова strategy.
 *
 * @param {AuthenticationInputSnapshot} snapshot Stable attempt snapshot. / Стабильный snapshot
 * попытки.
 * @returns {AuthenticationStrategyInput} Frozen strategy input. / Замороженный input strategy.
 * @private
 */
function strategyInput(snapshot) {
  return Object.freeze({
    transport: snapshot.transport,
    method: snapshot.method,
    path: snapshot.path,
    headers: new Headers(snapshot.headers),
    query: new URLSearchParams(snapshot.query),
    ...(Object.hasOwn(snapshot, 'origin') ? { origin: snapshot.origin } : {}),
    signal: snapshot.signal,
  });
}

/**
 * Deeply copies and freezes one JSON-compatible value.
 * Глубоко копирует и замораживает одно JSON-совместимое значение.
 *
 * @param {*} value Candidate value. / Проверяемое значение.
 * @param {Set<Object>} ancestors Objects on the current recursion path. / Объекты в текущем пути
 * рекурсии.
 * @returns {*} Frozen copy or primitive. / Замороженная копия или примитив.
 * @throws {TypeError} When the value is not JSON-compatible. / Если значение несовместимо с JSON.
 * @private
 */
function cloneJson(value, ancestors = new Set()) {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    throw new TypeError('principal is not JSON-compatible');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      const indexes = Array.from({ length: value.length }, (_, index) => String(index));
      if (
        keys.some((key) => typeof key === 'symbol') ||
        keys.length !== value.length + 1 ||
        indexes.some((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          return !descriptor || !descriptor.enumerable || !('value' in descriptor);
        })
      ) {
        throw new TypeError('principal is not JSON-compatible');
      }
      return Object.freeze(value.map((item) => cloneJson(item, ancestors)));
    }
    const prototype = Object.getPrototypeOf(value);
    if (![Object.prototype, null].includes(prototype)) {
      throw new TypeError('principal is not JSON-compatible');
    }
    const copy = Object.create(prototype);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new TypeError('principal is not JSON-compatible');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError('principal is not JSON-compatible');
      }
      Object.defineProperty(copy, key, {
        value: cloneJson(descriptor.value, ancestors),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return Object.freeze(copy);
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Copies and freezes an authenticated session.
 * Копирует и замораживает подтверждённую сессию аутентификации.
 *
 * @param {*} value Candidate session. / Проверяемая сессия.
 * @returns {AuthSession} Normalized session. / Нормализованная сессия.
 * @throws {TypeError} When the session is invalid or expired. / Если сессия неверна или истекла.
 * @private
 */
function normalizeSession(value) {
  if (
    !hasExactDataKeys(value, ['authSessionId', 'expiresAt', 'principal'], ['expiresAt']) ||
    typeof value.authSessionId !== 'string' ||
    value.authSessionId.length === 0 ||
    value.principal === null ||
    typeof value.principal !== 'object' ||
    Array.isArray(value.principal) ||
    (Object.hasOwn(value, 'expiresAt') &&
      (!Number.isSafeInteger(value.expiresAt) ||
        value.expiresAt <= 0 ||
        value.expiresAt <= Date.now()))
  ) {
    throw new TypeError('AuthSession is invalid');
  }
  return Object.freeze({
    authSessionId: value.authSessionId,
    principal: cloneJson(value.principal),
    ...(Object.hasOwn(value, 'expiresAt') ? { expiresAt: value.expiresAt } : {}),
  });
}

/**
 * Copies and validates one strategy result.
 * Копирует и проверяет один результат strategy.
 *
 * @param {*} result Candidate result. / Проверяемый результат.
 * @returns {AuthenticationResult} Normalized result. / Нормализованный результат.
 * @throws {TypeError} When the result is invalid. / Если результат неверен.
 * @private
 */
function normalizeResult(result) {
  const statusDescriptor =
    result !== null && typeof result === 'object' && !Array.isArray(result)
      ? Object.getOwnPropertyDescriptor(result, 'status')
      : undefined;
  if (!statusDescriptor || !('value' in statusDescriptor) || statusDescriptor.value === undefined) {
    throw new TypeError('result is invalid');
  }
  if (result.status === 'abstain') {
    if (!hasExactDataKeys(result, ['status'])) throw new TypeError('abstain result is invalid');
    return Object.freeze({ status: 'abstain' });
  }
  if (result.status === 'rejected') {
    if (
      !hasExactDataKeys(result, ['challenge', 'code', 'status'], ['challenge']) ||
      typeof result.code !== 'string' ||
      !REJECTION_CODE.test(result.code) ||
      (Object.hasOwn(result, 'challenge') &&
        (typeof result.challenge !== 'string' ||
          result.challenge.trim() === '' ||
          !/^[\t\x20-\x7e]+$/.test(result.challenge)))
    ) {
      throw new TypeError('rejected result is invalid');
    }
    return Object.freeze({
      status: 'rejected',
      code: result.code,
      ...(Object.hasOwn(result, 'challenge') ? { challenge: result.challenge } : {}),
    });
  }
  if (result.status === 'authenticated' && hasExactDataKeys(result, ['session', 'status'])) {
    return Object.freeze({ status: 'authenticated', session: normalizeSession(result.session) });
  }
  throw new TypeError('result is invalid');
}

/**
 * Creates a stable invalid-result failure for one strategy.
 * Создаёт стабильную ошибку неверного результата одной strategy.
 *
 * @param {string} strategy Strategy name. / Имя strategy.
 * @returns {AuthenticationStrategyError} Wrapped failure. / Обёрнутый сбой.
 * @private
 */
function invalidResult(strategy) {
  return new AuthenticationStrategyError(strategy, new InvalidAuthenticationResultError(strategy));
}

/**
 * Throws when an authentication attempt has been aborted.
 * Выбрасывает ошибку при отмене попытки аутентификации.
 *
 * @param {AbortSignal} signal Attempt signal. / Сигнал попытки.
 * @returns {void}
 * @throws {AuthenticationAbortedError} When the signal is aborted. / Если сигнал отменён.
 * @private
 */
function throwIfAborted(signal) {
  if (signal.aborted) throw new AuthenticationAbortedError('Authentication was aborted');
}

/**
 * Transport-neutral orchestrator for named authentication scenarios.
 * Transport-neutral оркестратор именованных сценариев аутентификации.
 *
 * Instances are created by {@link createAuthentication}; the constructor is not exported.
 * Экземпляры создаются через {@link createAuthentication}; конструктор не экспортируется.
 *
 * @public
 */
class Authentication {
  /**
   * Normalized scenarios by name. / Нормализованные scenarios по имени.
   *
   * @type {Map<string, AuthenticationScenario>}
   * @private
   */
  #scenarios;

  /**
   * Normalized strategies by name. / Нормализованные strategies по имени.
   *
   * @type {Map<string, AuthenticationStrategy>}
   * @private
   */
  #strategies;

  /**
   * Stores complete validated catalogs.
   * Сохраняет полностью проверенные каталоги.
   *
   * @param {Map<string, AuthenticationStrategy>} strategies Strategies by name. / Strategies по
   * имени.
   * @param {Map<string, AuthenticationScenario>} scenarios Scenarios by name. / Scenarios по
   * имени.
   * @private
   */
  constructor(strategies, scenarios) {
    this.#strategies = strategies;
    this.#scenarios = scenarios;
    AUTHENTICATION_INSTANCES.add(this);
    AUTHENTICATION_SCENARIOS.set(this, scenarios);
    Object.freeze(this);
  }

  /**
   * Executes one named scenario against a normalized transport input.
   * Выполняет один именованный scenario для нормализованного transport input.
   *
   * @param {string} scenarioName Scenario name. / Имя scenario.
   * @param {AuthenticationStrategyInput} input HTTP or WebSocket input. / HTTP- или WebSocket
   * input.
   * @returns {Promise<AuthenticationResult>} Normalized outcome. / Нормализованный результат.
   * @throws {InvalidAuthenticationOptionsError} When the scenario does not exist. / Если scenario
   * отсутствует.
   * @throws {AuthenticationStrategyError} When a strategy fails or returns invalid data. / При
   * сбое strategy или неверных данных.
   * @throws {AuthenticationAbortedError} When the attempt is aborted. / При отмене попытки.
   * @public
   */
  async authenticate(scenarioName, input) {
    if (typeof scenarioName !== 'string' || !this.#scenarios.has(scenarioName)) {
      invalidOptions('authentication scenario does not exist');
    }
    const snapshot = snapshotInput(input);
    const scenario = this.#scenarios.get(scenarioName);
    for (const strategyName of scenario.use) {
      throwIfAborted(snapshot.signal);
      let result;
      try {
        result = await this.#strategies.get(strategyName).authenticate(strategyInput(snapshot));
      } catch (cause) {
        if (snapshot.signal.aborted) throwIfAborted(snapshot.signal);
        throw new AuthenticationStrategyError(strategyName, cause);
      }
      throwIfAborted(snapshot.signal);
      try {
        result = normalizeResult(result);
      } catch {
        throw invalidResult(strategyName);
      }
      if (result.status !== 'abstain') return result;
    }
    return scenario.required
      ? Object.freeze({ status: 'rejected', code: 'AUTHENTICATION_REQUIRED' })
      : Object.freeze({ status: 'abstain' });
  }
}

/**
 * Creates an immutable Authentication module from named strategies and scenarios.
 * Создаёт неизменяемый модуль Authentication из именованных strategies и scenarios.
 *
 * @param {AuthenticationOptions} options Declarative Authentication configuration. /
 * Декларативная конфигурация Authentication.
 * @returns {Authentication} Authentication module. / Модуль Authentication.
 * @throws {InvalidAuthenticationOptionsError} When configuration is invalid. / При неверной
 * конфигурации.
 * @public
 */
export function createAuthentication(options) {
  if (!hasExactDataKeys(options, AUTHENTICATION_KEYS)) {
    invalidOptions('Authentication configuration must contain exactly strategies and scenarios');
  }
  const strategies = new Map();
  for (const [name, declaration] of catalogEntries(options.strategies, 'strategies')) {
    strategies.set(name, normalizeStrategy(declaration));
  }
  const scenarios = new Map();
  for (const [name, declaration] of catalogEntries(options.scenarios, 'scenarios')) {
    scenarios.set(name, normalizeScenario(declaration, strategies));
  }
  return new Authentication(strategies, scenarios);
}

/**
 * Tests whether a value is a framework-created Authentication module.
 * Проверяет, является ли значение созданным фреймворком модулем Authentication.
 *
 * @param {*} value Candidate value. / Проверяемое значение.
 * @returns {boolean} Whether the brand matches. / Совпадает ли brand.
 * @private
 */
export function isAuthentication(value) {
  return AUTHENTICATION_INSTANCES.has(value);
}

/**
 * Tests whether a framework Authentication contains a named scenario.
 * Проверяет наличие именованного scenario в framework Authentication.
 *
 * @param {*} authentication Candidate Authentication module. / Проверяемый модуль Authentication.
 * @param {string} scenarioName Scenario name. / Имя scenario.
 * @returns {boolean} Whether the scenario exists. / Существует ли scenario.
 * @private
 */
export function hasAuthenticationScenario(authentication, scenarioName) {
  return AUTHENTICATION_SCENARIOS.get(authentication)?.has(scenarioName) === true;
}

/**
 * Authentication module configuration. / Конфигурация модуля Authentication.
 *
 * @typedef {Object} AuthenticationOptions
 * @property {Object<string, AuthenticationStrategy>} strategies Named strategies. / Именованные
 * strategies.
 * @property {Object<string, AuthenticationScenario>} scenarios Named scenarios. / Именованные
 * scenarios.
 * @public
 */

/**
 * User-defined authentication strategy. / Пользовательская strategy аутентификации.
 *
 * @typedef {Object} AuthenticationStrategy
 * @property {AuthenticationStrategyHandler} authenticate Credential adapter. / Adapter credential.
 * @public
 */

/**
 * Declarative authentication scenario. / Декларативный scenario аутентификации.
 *
 * @typedef {Object} AuthenticationScenario
 * @property {string[]} use Ordered unique strategy names. / Упорядоченные уникальные имена
 * strategies.
 * @property {boolean} required Whether full abstention is rejected. / Отклоняется ли полный
 * abstain.
 * @public
 */

/**
 * Executes one authentication strategy. / Выполняет одну strategy аутентификации.
 *
 * @callback AuthenticationStrategyHandler
 * @param {AuthenticationStrategyInput} input Normalized transport input. / Нормализованный
 * transport input.
 * @returns {AuthenticationResult|Promise<AuthenticationResult>} Tagged outcome. / Tagged result.
 * @public
 */

/**
 * Normalized HTTP or WebSocket authentication input.
 * Нормализованный HTTP- или WebSocket input аутентификации.
 *
 * @typedef {Object} AuthenticationStrategyInput
 * @property {'http'|'websocket'} transport Transport kind. / Вид transport.
 * @property {string} method Uppercase HTTP method. / HTTP-метод в верхнем регистре.
 * @property {string} path Percent-encoded pathname. / Percent-encoded pathname.
 * @property {Headers} headers Isolated WHATWG headers snapshot. / Изолированный snapshot
 * WHATWG-заголовков.
 * @property {URLSearchParams} query Isolated query snapshot. / Изолированный snapshot query.
 * @property {string} [origin] Validated WebSocket Origin. / Проверенный WebSocket Origin.
 * @property {AbortSignal} signal Request or handshake signal. / Сигнал запроса или handshake.
 * @public
 */

/**
 * Stable internal authentication-input snapshot.
 * Стабильный внутренний snapshot input аутентификации.
 *
 * @typedef {AuthenticationStrategyInput} AuthenticationInputSnapshot
 * @private
 */

/**
 * Confirmed identity shared by HTTP and WebSocket transports.
 * Подтверждённая общая идентичность HTTP- и WebSocket-транспортов.
 *
 * @typedef {Object} AuthSession
 * @property {string} authSessionId Stable opaque session identifier. / Стабильный непрозрачный
 * идентификатор сессии.
 * @property {Object} principal Immutable JSON-compatible identity data. / Неизменяемые
 * JSON-совместимые данные идентичности.
 * @property {number} [expiresAt] Unix expiry time in milliseconds. / Unix-время истечения в
 * миллисекундах.
 * @public
 */

/**
 * Authentication strategy or scenario outcome.
 * Результат strategy или scenario аутентификации.
 *
 * @typedef {Object} AuthenticationResult
 * @property {'abstain'|'rejected'|'authenticated'} status Outcome tag. / Тег результата.
 * @property {string} [code] Stable rejection code. / Стабильный код отказа.
 * @property {string} [challenge] WWW-Authenticate challenge. / Challenge WWW-Authenticate.
 * @property {AuthSession} [session] Confirmed session. / Подтверждённая сессия.
 * @public
 */
