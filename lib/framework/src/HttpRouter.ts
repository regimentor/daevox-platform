import {
  HttpRouteConflictError,
  InvalidHttpPathEncodingError,
  InvalidHttpRouteError,
} from './errors.ts';
import { decodePathSegments, hasExactlyOwnKeys, isHttpToken } from './httpRoute.ts';

/** Validated HTTP-route metadata. / Проверенные метаданные HTTP-маршрута. @private */
export interface NormalizedHttpRoute {
  readonly method: string;
  readonly path: string;
  readonly handler: string;
  readonly controller: new (options: any) => Record<string, any>;
}

/** One compiled route-pattern segment. / Один сегмент скомпилированного шаблона маршрута. @private */
interface HttpRoutePatternSegment {
  dynamic: boolean;
  value: string;
}

/** Compiled route used for matching. / Скомпилированный маршрут для сопоставления. @private */
interface CompiledHttpRoute {
  definition: NormalizedHttpRoute;
  method: string;
  pattern: HttpRoutePatternSegment[];
  structuralKey: string;
}

/** Resolved route and path parameters. / Найденный маршрут и параметры пути. @private */
export interface HttpRouteMatch {
  route: NormalizedHttpRoute;
  params: Readonly<Record<string, string>>;
}

/**

 * Valid parameter-name syntax. / Допустимый синтаксис имени параметра.

 *
 * @private

 */
const PARAMETER_NAME = /^[A-Za-z][A-Za-z0-9]*$/;
/**
 * Exact normalized-route fields. / Точные поля нормализованного HTTP-маршрута.
 * @private
 */
const ROUTE_KEYS = ['controller', 'handler', 'method', 'path'];

/**

 * Creates an invalid-route error with an optional cause. / Создаёт ошибку HTTP-маршрута с необязательной причиной.

 *
 * @param message Error text. / Текст ошибки.

 * @param [cause] Original error. / Исходная ошибка.

 * @returns Created error. / Созданная ошибка.

 * @private

 */
function invalidRoute(message: string, cause: unknown = undefined): InvalidHttpRouteError {
  return new InvalidHttpRouteError(message, cause ? { cause } : undefined);
}

/**

 * Parses a declared or requested absolute path. / Разбирает объявленный или запрошенный абсолютный путь.

 *
 * @param path Path to parse. / Разбираемый путь.

 * @param [matchInput=false] Whether the path came from a request. / Получен ли путь из запроса.

 * @returns Decoded segments. / Декодированные сегменты.

 * @private

 */
function parsePath(path: string, matchInput = false): string[] {
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
 * @param definition Normalized route. / Нормализованный HTTP-маршрут.

 * @returns Compiled route. / Скомпилированный HTTP-маршрут.

 * @private

 */
function compileRoute(definition: NormalizedHttpRoute): CompiledHttpRoute {
  if (
    definition === null ||
    typeof definition !== 'object' ||
    Array.isArray(definition) ||
    !hasExactlyOwnKeys(definition, ROUTE_KEYS)
  ) {
    throw invalidRoute('HTTP route must have exactly the normalized route fields');
  }

  const { controller, handler, method, path } = definition;
  if (
    !isHttpToken(method) ||
    method !== method.toUpperCase() ||
    typeof handler !== 'string' ||
    handler === '' ||
    typeof controller !== 'function'
  ) {
    throw invalidRoute('HTTP route has invalid normalized fields');
  }

  const segments = parsePath(path);
  const storedDefinition = Object.isFrozen(definition)
    ? definition
    : Object.freeze({ method, path, handler, controller });
  const parameterNames = new Set<string>();
  const pattern = segments.map((segment): HttpRoutePatternSegment => {
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
 * @param left Left route. / Левый HTTP-маршрут.

 * @param right Right route. / Правый HTTP-маршрут.

 * @returns Sort order. / Порядок сортировки.

 * @private

 */
function compareSpecificity(left: CompiledHttpRoute, right: CompiledHttpRoute): number {
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
 * @private
 */
export class HttpRouter {
  /**
   * Specificity-ordered routes. / HTTP-маршруты в порядке специфичности.
   * @private
   */
  #routes: CompiledHttpRoute[] = [];

  /**

   * Atomically registers a non-empty set of normalized routes. / Атомарно регистрирует непустой набор нормализованных HTTP-маршрутов.

   *
   * @param routes Routes to register. / Регистрируемые HTTP-маршруты.

   * @private

   */
  registerAll(routes: NormalizedHttpRoute[]): void {
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
   * @param method HTTP method. / HTTP-метод.

   * @param pathname Requested path. / Запрошенный путь.

   * @returns Match or `null`. / Результат или `null`.

   * @private

   */
  match(method: string, pathname: string): HttpRouteMatch | null {
    if (!isHttpToken(method)) {
      throw invalidRoute('method must be a valid HTTP token');
    }
    const segments = parsePath(pathname, true);
    const normalizedMethod = method.toUpperCase();

    for (const candidate of this.#routes) {
      if (candidate.method !== normalizedMethod || candidate.pattern.length !== segments.length) {
        continue;
      }

      const params: Record<string, string> = {};
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
   * @param pathname Requested path. / Запрошенный путь.

   * @returns Ordered unique methods. / Упорядоченные уникальные методы.

   * @private

   */
  methodsFor(pathname: string): string[] {
    const segments = parsePath(pathname, true);
    const methods: string[] = [];
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
