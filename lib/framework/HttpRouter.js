import {
  HttpRouteConflictError,
  InvalidHttpPathEncodingError,
  InvalidHttpRouteError,
} from './errors.js';
import { decodePathSegments, hasExactlyOwnKeys, isHttpToken } from './httpRoute.js';

const PARAMETER_NAME = /^[A-Za-z][A-Za-z0-9]*$/;
const ROUTE_KEYS = ['controller', 'handler', 'method', 'path'];

function invalidRoute(message, cause) {
  return new InvalidHttpRouteError(message, cause ? { cause } : undefined);
}

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

function compileRoute(definition) {
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

function compareSpecificity(left, right) {
  const length = Math.min(left.pattern.length, right.pattern.length);
  for (let index = 0; index < length; index += 1) {
    if (left.pattern[index].dynamic !== right.pattern[index].dynamic) {
      return left.pattern[index].dynamic ? 1 : -1;
    }
  }
  return 0;
}

export class HttpRouter {
  #routes = [];

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
