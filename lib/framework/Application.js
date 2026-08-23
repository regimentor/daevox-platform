import nodeHttp from 'node:http';
import { HttpControllerBase } from './HttpControllerBase.js';
import { HttpRouter } from './HttpRouter.js';
import { JobRunner } from './JobRunner.js';
import {
  ApplicationStateError,
  DuplicateHttpControllerError,
  InvalidHttpControllerError,
  InvalidHttpOptionsError,
  InvalidHttpPathEncodingError,
  InvalidHttpRouteError,
  HttpError,
} from './errors.js';
import { decodePathSegments, hasExactlyOwnKeys, isHttpToken } from './httpRoute.js';

const DECLARATION_KEYS = ['handler', 'method', 'path'];
const HTTP_OPTION_KEYS = new Set(['bodyLimit', 'shutdownTimeout', 'onError']);

class InfrastructureHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function invalidHttpOptions(message) {
  throw new InvalidHttpOptionsError(message);
}

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
  #httpOptions;
  #httpServer;
  #closePromise;
  #listenPromise;
  #state = 'new';
  #activeRequests = new Set();
  #activeWaiters = new Set();

  constructor({ jobs, http } = {}) {
    this.#jobRunner = new JobRunner(jobs);
    this.#httpOptions = normalizeHttpOptions(http);
  }

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
      normalizeRoute(HttpController, prefixSegments, declaration),
    );

    this.#httpRouter.registerAll(normalizedRoutes);
    this.#httpControllers.add(HttpController);
    return this;
  }

  async listen({ port, host = '127.0.0.1' }) {
    if (this.#state !== 'new') throw new ApplicationStateError('Application cannot listen');
    this.#state = 'starting';
    this.#listenPromise = new Promise((resolve, reject) => {
      const server = nodeHttp.createServer((request, response) => {
        this.#handleHttpRequest(request, response).catch((error) => {
          if (response.headersSent || response.destroyed) return;
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
        body = JSON.parse(bytes.toString('utf8'));
      } catch {
        throw new InfrastructureHttpError(400, 'Bad Request');
      }
    }
    const ctx = {
      method: request.method.toUpperCase(),
      path: url.pathname,
      params: match.params,
      query: new URLSearchParams(url.searchParams),
      headers: new Headers(request.headers),
      body,
      signal: abortController.signal,
    };
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

  #reportUnexpected(error, ctx) {
    if (!this.#httpOptions.onError) return;
    try {
      Promise.resolve(this.#httpOptions.onError(error, ctx)).catch(console.error);
    } catch (reportingError) {
      console.error(reportingError);
    }
  }

  #waitForActiveRequests() {
    if (this.#activeRequests.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.#activeWaiters.add(resolve));
  }

  #writeJson(response, status, value, headers = {}) {
    const body = Buffer.from(JSON.stringify(value));
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.byteLength,
      ...headers,
    });
    response.end(body);
  }

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
        }
        await this.#jobRunner.close();
        this.#state = 'closed';
      })();
    }
    return this.#closePromise;
  }
}
