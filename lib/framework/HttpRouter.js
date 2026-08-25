import {
  HttpRouteConflictError,
  InvalidHttpPathEncodingError,
  InvalidHttpRouteError,
} from './errors.js';
import { decodePathSegments, hasExactlyOwnKeys, isHttpToken } from './httpRoute.js';

/**

 * Valid parameter-name syntax. / Допустимый синтаксис имени параметра.

 *

 * @type {RegExp}

 * @private

 */
const PARAMETER_NAME = /^[A-Za-z][A-Za-z0-9]*$/;
/**
 * Exact normalized-route fields. / Точные поля нормализованного HTTP-маршрута.
 *
 * @type {string[]}
 * @private
 */
const ROUTE_KEYS = ['authentication', 'controller', 'handler', 'method', 'path'];

/**
 * Valid Authentication scenario-name syntax. / Допустимый синтаксис имени scenario Authentication.
 *
 * @type {RegExp}
 * @private
 */
const AUTHENTICATION_SCENARIO_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**

 * Creates an invalid-route error with an optional cause. / Создаёт ошибку HTTP-маршрута с необязательной причиной.

 *

 * @param {string} message Error text. / Текст ошибки.

 * @param {Error} [cause] Original error. / Исходная ошибка.

 * @returns {InvalidHttpRouteError} Created error. / Созданная ошибка.

 * @private

 */
function invalidRoute(message, cause) {
  return new InvalidHttpRouteError(message, cause ? { cause } : undefined);
}

/**

 * Parses a declared or requested absolute path. / Разбирает объявленный или запрошенный абсолютный путь.

 *

 * @param {string} path Path to parse. / Разбираемый путь.

 * @param {boolean} [matchInput=false] Whether the path came from a request. / Получен ли путь из запроса.

 * @returns {string[]} Decoded segments. / Декодированные сегменты.

 * @private

 */
function parsePath(path, matchInput = false) {
  if (typeof path !== 'string' || path === '' || !path.startsWith('/')) {
    throw invalidRoute('pathname must be a non-empty absolute path');
  }

  try {
    return decodePathSegments(path);
  } catch (cause) {
    if (matchInput && cause instanceof URIError) {
      throw new InvalidHttpPathEncodingError('pathname contains invalid percent-encoding', {
        cause,
      });
    }
    const message =
      cause instanceof URIError
        ? 'HTTP route path contains invalid percent-encoding'
        : 'HTTP route path contains a forbidden character or segment';
    throw invalidRoute(message, cause);
  }
}

/**

 * Compiles a normalized HTTP route into a matchable record. / Компилирует нормализованный HTTP-маршрут в запись для сопоставления.

 *

 * @param {NormalizedHttpRoute} definition Normalized route. / Нормализованный HTTP-маршрут.

 * @returns {CompiledHttpRoute} Compiled route. / Скомпилированный HTTP-маршрут.

 * @private

 */
function compileRoute(definition) {
  if (
    definition === null ||
    typeof definition !== 'object' ||
    Array.isArray(definition) ||
    !hasExactlyOwnKeys(definition, ROUTE_KEYS)
  ) {
    throw invalidRoute('HTTP route must have exactly the normalized route fields');
  }

  const { authentication, controller, handler, method, path } = definition;
  if (
    !isHttpToken(method) ||
    method !== method.toUpperCase() ||
    typeof handler !== 'string' ||
    handler === '' ||
    typeof controller !== 'function' ||
    (authentication !== false &&
      (typeof authentication !== 'string' || !AUTHENTICATION_SCENARIO_NAME.test(authentication)))
  ) {
    throw invalidRoute('HTTP route has invalid normalized fields');
  }

  const segments = parsePath(path);
  const storedDefinition = Object.isFrozen(definition)
    ? definition
    : Object.freeze({ method, path, handler, controller, authentication });
  const parameterNames = new Set();
  const pattern = segments.map((segment) => {
    if (!segment.includes(':') && !segment.includes('*')) {
      return { dynamic: false, value: segment };
    }

    if (!segment.startsWith(':') || segment.includes('*')) {
      throw invalidRoute('HTTP route has an invalid dynamic segment');
    }

    const name = segment.slice(1);
    if (!PARAMETER_NAME.test(name) || parameterNames.has(name)) {
      throw invalidRoute('HTTP route has an invalid dynamic segment');
    }
    parameterNames.add(name);
    return { dynamic: true, value: name };
  });

  return {
    definition: storedDefinition,
    method,
    pattern,
    structuralKey: JSON.stringify([
      method,
      pattern.map((segment) => (segment.dynamic ? null : segment.value)),
    ]),
  };
}

/**

 * Orders static segments ahead of parameter segments. / Упорядочивает статические сегменты перед параметризованными.

 *

 * @param {CompiledHttpRoute} left Left route. / Левый HTTP-маршрут.

 * @param {CompiledHttpRoute} right Right route. / Правый HTTP-маршрут.

 * @returns {number} Sort order. / Порядок сортировки.

 * @private

 */
function compareSpecificity(left, right) {
  const length = Math.min(left.pattern.length, right.pattern.length);
  for (let index = 0; index < length; index += 1) {
    if (left.pattern[index].dynamic !== right.pattern[index].dynamic) {
      return left.pattern[index].dynamic ? 1 : -1;
    }
  }
  return 0;
}

/**
 * Internal catalog that registers and matches normalized HTTP routes.
 * Внутренний каталог, регистрирующий и сопоставляющий нормализованные HTTP-маршруты.
 *
 * @private
 */
export class HttpRouter {
  /**
   * @type {CompiledHttpRoute[]} Specificity-ordered routes. / HTTP-маршруты в порядке специфичности.
   * @private
   */
  #routes = [];

  /**

   * Atomically registers a non-empty set of normalized routes. / Атомарно регистрирует непустой набор нормализованных HTTP-маршрутов.

   *

   * @param {NormalizedHttpRoute[]} routes Routes to register. / Регистрируемые HTTP-маршруты.

   * @returns {void}

   * @private

   */
  registerAll(routes) {
    if (!Array.isArray(routes) || routes.length === 0) {
      throw invalidRoute('routes must be a non-empty array');
    }

    const compiled = Array.from(routes, compileRoute);
    const keys = new Set(this.#routes.map((route) => route.structuralKey));
    for (const candidate of compiled) {
      if (keys.has(candidate.structuralKey)) {
        throw new HttpRouteConflictError(`HTTP route conflicts with ${candidate.structuralKey}`);
      }
      keys.add(candidate.structuralKey);
    }

    this.#routes = [...this.#routes, ...compiled].toSorted(compareSpecificity);
  }

  /**

   * Matches an HTTP method and requested path. / Сопоставляет HTTP-метод и запрошенный путь.

   *

   * @param {string} method HTTP method. / HTTP-метод.

   * @param {string} pathname Requested path. / Запрошенный путь.

   * @returns {HttpRouteMatch|null} Match or `null`. / Результат или `null`.

   * @private

   */
  match(method, pathname) {
    if (!isHttpToken(method)) {
      throw invalidRoute('method must be a valid HTTP token');
    }
    const segments = parsePath(pathname, true);
    const normalizedMethod = method.toUpperCase();

    for (const candidate of this.#routes) {
      if (candidate.method !== normalizedMethod || candidate.pattern.length !== segments.length) {
        continue;
      }

      const params = {};
      let matches = true;
      for (let index = 0; index < segments.length; index += 1) {
        const expected = candidate.pattern[index];
        const actual = segments[index];
        if (expected.dynamic) params[expected.value] = actual;
        else if (expected.value !== actual) matches = false;
      }

      if (matches) {
        return {
          route: candidate.definition,
          params: Object.freeze(params),
        };
      }
    }
    return null;
  }

  /**

   * Lists explicitly registered methods for a requested path shape. / Возвращает явно зарегистрированные методы для формы запрошенного пути.

   *

   * @param {string} pathname Requested path. / Запрошенный путь.

   * @returns {string[]} Ordered unique methods. / Упорядоченные уникальные методы.

   * @private

   */
  methodsFor(pathname) {
    const segments = parsePath(pathname, true);
    const methods = [];
    for (const candidate of this.#routes) {
      if (candidate.pattern.length !== segments.length) continue;
      const matches = candidate.pattern.every(
        (expected, index) => expected.dynamic || expected.value === segments[index],
      );
      if (matches && !methods.includes(candidate.method)) methods.push(candidate.method);
    }
    return methods;
  }
}

/**
 * One path pattern segment.
 * Один сегмент шаблона пути.
 *
 * @typedef {Object} HttpRoutePatternSegment
 * @property {boolean} dynamic Whether the value names a parameter. / Является ли значение именем
 * параметра.
 * @property {string} value Static value or parameter name. / Статическое значение или имя.
 * @private
 */

/**
 * Matchable internal HTTP-route record.
 * Внутренняя запись HTTP-маршрута для сопоставления.
 *
 * @typedef {Object} CompiledHttpRoute
 * @property {NormalizedHttpRoute} definition Stored normalized route. / Нормализованный маршрут.
 * @property {string} method Uppercase HTTP method. / HTTP-метод в верхнем регистре.
 * @property {HttpRoutePatternSegment[]} pattern Compiled path pattern. / Шаблон пути.
 * @property {string} structuralKey Conflict key. / Ключ конфликта.
 * @private
 */

/**
 * Successful HTTP-route lookup.
 * Успешный поиск HTTP-маршрута.
 *
 * @typedef {Object} HttpRouteMatch
 * @property {NormalizedHttpRoute} route Matched route. / Найденный HTTP-маршрут.
 * @property {Object<string, string>} params Frozen path parameters. / Замороженные параметры пути.
 * @private
 */
