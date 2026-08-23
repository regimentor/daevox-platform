import { HttpControllerBase } from './HttpControllerBase.js';
import { HttpRouter } from './HttpRouter.js';
import { JobRunner } from './JobRunner.js';
import {
  DuplicateHttpControllerError,
  InvalidHttpControllerError,
  InvalidHttpRouteError,
} from './errors.js';
import { decodePathSegments, hasExactlyOwnKeys, isHttpToken } from './httpRoute.js';

const DECLARATION_KEYS = ['handler', 'method', 'path'];

function controllerError(message, cause) {
  return new InvalidHttpControllerError(message, cause ? { cause } : undefined);
}

function routeError(message, cause) {
  return new InvalidHttpRouteError(message, cause ? { cause } : undefined);
}

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

function serializeSegment(segment) {
  return segment.replaceAll('%', '%25').replaceAll('/', '%2F');
}

function composePath(prefixSegments, path) {
  const segments = [...prefixSegments, ...pathSegments(path)];
  return segments.length === 0 ? '/' : `/${segments.map(serializeSegment).join('/')}`;
}

function ownDataValue(object, property) {
  const descriptor = Object.getOwnPropertyDescriptor(object, property);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

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

function normalizeRoute(HttpController, prefixSegments, declaration) {
  if (
    declaration === null ||
    typeof declaration !== 'object' ||
    Array.isArray(declaration) ||
    !hasExactlyOwnKeys(declaration, DECLARATION_KEYS)
  ) {
    throw routeError('HTTP route declaration must have exactly method, path and handler');
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

  return Object.freeze({
    method: method.toUpperCase(),
    path: composePath(prefixSegments, path),
    handler,
    controller: HttpController,
  });
}

export class Application {
  #httpRouter = new HttpRouter();
  #httpControllers = new Set();
  #jobRunner;

  constructor({ jobs } = {}) {
    this.#jobRunner = new JobRunner(jobs);
  }

  registerHttpController(HttpController) {
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
      normalizeRoute(HttpController, prefixSegments, declaration),
    );

    this.#httpRouter.registerAll(normalizedRoutes);
    this.#httpControllers.add(HttpController);
    return this;
  }

  close() {
    return this.#jobRunner.close();
  }
}
