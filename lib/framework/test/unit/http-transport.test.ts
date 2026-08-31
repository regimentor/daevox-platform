class TestAppState {
  readonly marker = undefined;
}
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import test from 'node:test';

import { Application } from '../../src/Application.ts';
import { HttpControllerBase } from '../../src/HttpControllerBase.ts';
import { HttpError, MiddlewareExecutionError } from '../../src/errors.ts';
import { JobsController } from '../../examples/jobs-http/JobsController.ts';

function request(address: any, options: any = {}) {
  return new Promise<any>((resolve: any, reject: any) => {
    const clientRequest = http.request(
      {
        host: address.address,
        port: address.port,
        path: options.path ?? '/',
        method: options.method ?? 'GET',
        headers: options.headers,
      },
      (response: any) => {
        const chunks: any[] = [];
        response.on('data', (chunk: any) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    clientRequest.on('error', reject);
    if (options.body !== undefined) clientRequest.end(options.body);
    else clientRequest.end();
  });
}

test('Application слушает ephemeral-порт и без HTTP-контроллеров отвечает 404', async () => {
  const app = new Application({ appState: TestAppState });
  const address = await app.listen({ port: 0 });

  try {
    assert.equal(address.address, '127.0.0.1');
    assert.ok(address.port > 0);
    const response = await request(address);
    assert.equal(response.status, 404);
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(response.body, '{"error":"Not Found"}');
  } finally {
    await app.close();
  }
});

test('HTTP transport сопоставляет HTTP-маршрут и передаёт нормализованный HttpRequestContext', async () => {
  let seenContext: any;
  class UsersController extends HttpControllerBase {
    static prefix = '/users';
    static routes = [{ method: 'POST', path: '/:id', handler: 'update' }] as const;
    update(_appState: any, ctx: any) {
      seenContext = ctx;
      return {
        status: 200,
        headers: new Headers({ 'x-handler': 'update' }),
        body: { id: ctx.params.id, values: ctx.query.getAll('value'), received: ctx.body },
      };
    }
  }
  const app = new Application({ appState: TestAppState });
  app.registerHttpController(UsersController);
  const address = await app.listen({ port: 0 });

  try {
    const response = await request(address, {
      method: 'POST',
      path: '/users/a%20b?value=first&value=second',
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-input': 'yes' },
      body: '{"active":true}',
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers['x-handler'], 'update');
    assert.equal(
      response.body,
      '{"id":"a b","values":["first","second"],"received":{"active":true}}',
    );
    assert.equal(seenContext.method, 'POST');
    assert.equal(seenContext.path, '/users/a%20b');
    assert.ok(Object.isFrozen(seenContext.params));
    assert.ok(seenContext.query instanceof URLSearchParams);
    assert.ok(seenContext.headers instanceof Headers);
    assert.equal(seenContext.headers.get('x-input'), 'yes');
    assert.ok(seenContext.signal instanceof AbortSignal);
    assert.equal('request' in seenContext, false);
    assert.equal('response' in seenContext, false);
    assert.equal('socket' in seenContext, false);
  } finally {
    await app.close();
  }
});

test('HTTP middleware выполняются на трёх уровнях вокруг HTTP-обработчика', async () => {
  const calls: any[] = [];
  const contexts: any[] = [];
  const middleware = (name: any) =>
    async function (this: any, _appState: any, ctx: any, next: any) {
      assert.equal(this, undefined);
      contexts.push(ctx);
      calls.push(`${name}:before`);
      ctx.state[name] = true;
      const result = await next();
      calls.push(`${name}:after`);
      return result;
    };

  class MiddlewareController extends HttpControllerBase {
    static prefix = '/middleware';
    static middleware = [middleware('controller')];
    static routes = [
      {
        method: 'GET',
        path: '/:id',
        handler: 'get',
        middleware: [middleware('route')],
      },
    ] as const;
    get(_appState: any, ctx: any) {
      contexts.push(ctx);
      calls.push('handler');
      return { status: 200, body: { state: ctx.state, route: ctx.route } };
    }
  }

  const app = new Application({
    appState: TestAppState,
    http: { middleware: [middleware('application')] },
  });
  app.registerHttpController(MiddlewareController);
  const address = await app.listen({ port: 0 });

  try {
    const response = await request(address, { path: '/middleware/value' });

    assert.equal(response.status, 200);
    assert.deepEqual(calls, [
      'application:before',
      'controller:before',
      'route:before',
      'handler',
      'route:after',
      'controller:after',
      'application:after',
    ]);
    assert.ok(contexts.every((ctx: any) => ctx === contexts[0]));
    assert.ok(Object.isFrozen(contexts[0]));
    assert.equal(Object.getPrototypeOf(contexts[0].state), null);
    assert.ok(Object.isFrozen(contexts[0].route));
    assert.deepEqual(contexts[0].route, {
      method: 'GET',
      path: '/middleware/:id',
      handler: 'get',
    });
    assert.deepEqual(JSON.parse(response.body), {
      state: { application: true, controller: true, route: true },
      route: { method: 'GET', path: '/middleware/:id', handler: 'get' },
    });
  } finally {
    await app.close();
  }
});

test('HTTP middleware short-circuit не создаёт HTTP-контроллер', async () => {
  let instances = 0;
  let laterCalled = false;
  class ProtectedController extends HttpControllerBase {
    static prefix = '/protected';
    static routes = [{ method: 'GET', path: '/', handler: 'get' }] as const;
    constructor(options: any) {
      super(options);
      instances += 1;
    }
    get() {
      laterCalled = true;
    }
  }
  const app = new Application({
    appState: TestAppState,
    http: {
      middleware: [() => ({ status: 401, body: { error: 'Unauthorized' } })],
    },
  });
  app.registerHttpController(ProtectedController as any);
  const address = await app.listen({ port: 0 });

  try {
    const response = await request(address, { path: '/protected' });
    assert.equal(response.status, 401);
    assert.equal(response.body, '{"error":"Unauthorized"}');
    assert.equal(instances, 0);
    assert.equal(laterCalled, false);
  } finally {
    await app.close();
  }
});

test('HTTP middleware не выполняются для инфраструктурных ошибок до маршрутизации', async () => {
  let calls = 0;
  class InputController extends HttpControllerBase {
    static prefix = '/input';
    static routes = [{ method: 'POST', path: '/', handler: 'post' }] as const;
    post() {
      return { status: 204 };
    }
  }
  const app = new Application({
    appState: TestAppState,
    http: {
      bodyLimit: 4,
      middleware: [
        (_appState: any, _ctx: any, next: any) => {
          calls += 1;
          return next();
        },
      ],
    },
  });
  app.registerHttpController(InputController);
  const address = await app.listen({ port: 0 });

  try {
    const responses = await Promise.all([
      request(address, { path: '/missing' }),
      request(address, { method: 'GET', path: '/input' }),
      request(address, {
        method: 'POST',
        path: '/input',
        headers: { 'content-type': 'application/json' },
        body: '{',
      }),
      request(address, {
        method: 'POST',
        path: '/input',
        headers: { 'content-type': 'application/json' },
        body: '{"a":1}',
      }),
    ]);
    assert.deepEqual(
      responses.map((response: any) => response.status),
      [404, 405, 400, 413],
    );
    assert.equal(calls, 0);
  } finally {
    await app.close();
  }
});

test('HTTP middleware используют снимки массивов и изолируют state параллельных запросов', async () => {
  const applicationMiddleware = [
    (_appState: any, ctx: any, next: any) => {
      ctx.state.requestId = ctx.headers.get('x-request-id');
      return next();
    },
  ];
  const controllerMiddleware = [(_appState: any, _ctx: any, next: any) => next()];
  const routeMiddleware = [(_appState: any, _ctx: any, next: any) => next()];
  let release: any;
  const bothStarted = new Promise<any>((resolve: any) => {
    release = resolve;
  });
  let started = 0;

  class StateController extends HttpControllerBase {
    static prefix = '/state';
    static middleware = controllerMiddleware;
    static routes = [
      { method: 'GET', path: '/', handler: 'get', middleware: routeMiddleware },
    ] as const;
    async get(_appState: any, ctx: any) {
      started += 1;
      if (started === 2) release();
      await bothStarted;
      return { status: 200, body: { requestId: ctx.state.requestId } };
    }
  }

  const app = new Application({
    appState: TestAppState,
    http: { middleware: applicationMiddleware },
  });
  app.registerHttpController(StateController);
  applicationMiddleware.push(() => ({ status: 500 }));
  controllerMiddleware.push(() => ({ status: 500 }));
  routeMiddleware.push(() => ({ status: 500 }));
  (StateController.routes[0] as any).middleware = [() => ({ status: 500 })];
  const address = await app.listen({ port: 0 });

  try {
    const responses = await Promise.all([
      request(address, { path: '/state', headers: { 'x-request-id': 'first' } }),
      request(address, { path: '/state', headers: { 'x-request-id': 'second' } }),
    ]);
    assert.deepEqual(
      responses.map((response: any) => JSON.parse(response.body).requestId).toSorted(),
      ['first', 'second'],
    );
  } finally {
    await app.close();
  }
});

test('ошибки HTTP middleware изолированы и сохраняют транспортную семантику', async () => {
  const observed: any[] = [];
  class HealthyController extends HttpControllerBase {
    static prefix = '/middleware-errors';
    static routes = [{ method: 'GET', path: '/:mode', handler: 'get' }] as const;
    get(_appState: any, ctx: any) {
      return { status: 200, body: { mode: ctx.params.mode } };
    }
  }
  const app = new Application({
    appState: TestAppState,
    http: {
      middleware: [
        async (_appState: any, ctx: any, next: any) => {
          if (ctx.params.mode === 'expected') {
            throw new HttpError(403, { body: { error: 'Forbidden' } });
          }
          if (ctx.params.mode === 'unexpected') throw new Error('middleware secret');
          if (ctx.params.mode === 'duplicate-next') {
            await next();
            return next();
          }
          return next();
        },
      ],
      onError(_appState: any, error: any, ctx: any) {
        observed.push({ error, path: ctx.path });
      },
    },
  });
  app.registerHttpController(HealthyController);
  const address = await app.listen({ port: 0 });

  try {
    const [unexpected, healthy] = await Promise.all([
      request(address, { path: '/middleware-errors/unexpected' }),
      request(address, { path: '/middleware-errors/healthy' }),
    ]);
    const expected = await request(address, { path: '/middleware-errors/expected' });
    const duplicate = await request(address, { path: '/middleware-errors/duplicate-next' });

    assert.equal(unexpected.status, 500);
    assert.equal(unexpected.body, '{"error":"Internal Server Error"}');
    assert.equal(healthy.status, 200);
    assert.equal(expected.status, 403);
    assert.equal(expected.body, '{"error":"Forbidden"}');
    assert.equal(duplicate.status, 500);
    assert.equal(observed.length, 2);
    assert.equal(observed[0].error.message, 'middleware secret');
    assert.ok(observed[1].error instanceof MiddlewareExecutionError);
  } finally {
    await app.close();
  }
});

test('HTTP transport детерминированно обрабатывает HEAD, OPTIONS и 405', async () => {
  class ResourceController extends HttpControllerBase {
    static prefix = '/resource';
    static routes = [
      { method: 'GET', path: '/', handler: 'get' },
      { method: 'POST', path: '/', handler: 'post' },
    ] as const;
    get() {
      return { status: 200, body: { ok: true } };
    }
    post() {
      return { status: 204 };
    }
  }
  const app = new Application({ appState: TestAppState });
  app.registerHttpController(ResourceController);
  const address = await app.listen({ port: 0 });

  try {
    const head = await request(address, { method: 'HEAD', path: '/resource' });
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], '11');
    assert.equal(head.body, '');
    const options = await request(address, { method: 'OPTIONS', path: '/resource' });
    assert.equal(options.status, 204);
    assert.equal(options.headers.allow, 'GET, HEAD, POST, OPTIONS');
    const unsupported = await request(address, { method: 'DELETE', path: '/resource' });
    assert.equal(unsupported.status, 405);
    assert.equal(unsupported.headers.allow, 'GET, HEAD, POST, OPTIONS');
    assert.equal(unsupported.body, '{"error":"Method Not Allowed"}');
    const malformedPath = await request(address, { path: '/resource/%ZZ' });
    assert.equal(malformedPath.status, 400);
    assert.equal(malformedPath.body, '{"error":"Bad Request"}');
  } finally {
    await app.close();
  }
});

test('HTTP transport ограничивает и разбирает только UTF-8 JSON-тело', async () => {
  class BodyController extends HttpControllerBase {
    static prefix = '/body';
    static routes = [{ method: 'PUT', path: '/', handler: 'put' }] as const;
    put(_appState: any, ctx: any) {
      return { status: 200, body: ctx.body };
    }
  }
  const app = new Application({ appState: TestAppState, http: { bodyLimit: 8 } });
  app.registerHttpController(BodyController);
  const address = await app.listen({ port: 0 });

  try {
    const malformed = await request(address, {
      method: 'PUT',
      path: '/body',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    assert.equal(malformed.status, 400);
    const unsupported = await request(address, {
      method: 'PUT',
      path: '/body',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    assert.equal(unsupported.status, 415);
    const charset = await request(address, {
      method: 'PUT',
      path: '/body',
      headers: { 'content-type': 'application/json; charset=utf-16' },
      body: '{}',
    });
    assert.equal(charset.status, 415);
    const tooLarge = await request(address, {
      method: 'PUT',
      path: '/body',
      headers: { 'content-type': 'application/problem+json' },
      body: '{"a":123}',
    });
    assert.equal(tooLarge.status, 413);
    const empty = await request(address, { method: 'PUT', path: '/body' });
    assert.equal(empty.status, 200);
    assert.equal(empty.body, '');
  } finally {
    await app.close();
  }
});

test('HttpError формирует ожидаемый ответ, а неожиданные ошибки безопасно проходят через onError', async () => {
  const observed: any[] = [];
  class ErrorController extends HttpControllerBase {
    static prefix = '/errors';
    static routes = [
      { method: 'GET', path: '/expected', handler: 'expected' },
      { method: 'GET', path: '/unexpected', handler: 'unexpected' },
      { method: 'GET', path: '/invalid-response', handler: 'invalidResponse' },
    ] as const;
    expected(): never {
      throw new HttpError(422, {
        headers: new Headers({ 'x-error-code': 'INVALID' }),
        body: { error: 'Invalid values' },
      });
    }
    unexpected(): never {
      throw new Error('secret details');
    }
    invalidResponse() {
      return { status: 200, extra: true };
    }
  }
  const app = new Application({
    appState: TestAppState,
    http: {
      onError: (_appState: any, error: any, ctx: any) => observed.push({ error, ctx }),
    },
  });
  app.registerHttpController(ErrorController);
  const address = await app.listen({ port: 0 });

  try {
    const expected = await request(address, { path: '/errors/expected' });
    assert.equal(expected.status, 422);
    assert.equal(expected.headers['x-error-code'], 'INVALID');
    assert.equal(expected.body, '{"error":"Invalid values"}');
    assert.equal(observed.length, 0);
    const unexpected = await request(address, { path: '/errors/unexpected' });
    assert.equal(unexpected.status, 500);
    assert.equal(unexpected.body, '{"error":"Internal Server Error"}');
    assert.equal(unexpected.body.includes('secret'), false);
    const invalid = await request(address, { path: '/errors/invalid-response' });
    assert.equal(invalid.status, 500);
    assert.equal(observed.length, 2);
    assert.equal(observed[0].error.message, 'secret details');
    assert.equal(observed[0].ctx.path, '/errors/unexpected');
  } finally {
    await app.close();
  }
});

test('Application.close по timeout отменяет оставшийся HTTP-запрос', async () => {
  let started: any;
  const handlerStarted = new Promise<any>((resolve: any) => {
    started = resolve;
  });
  let wasAborted = false;
  class SlowController extends HttpControllerBase {
    static prefix = '/slow';
    static routes = [{ method: 'GET', path: '/', handler: 'get' }] as const;
    get(_appState: any, ctx: any) {
      started();
      return new Promise<any>((resolve: any) => {
        ctx.signal.addEventListener(
          'abort',
          () => {
            wasAborted = true;
            resolve({ status: 200, body: { late: true } });
          },
          { once: true },
        );
      });
    }
  }
  const app = new Application({ appState: TestAppState, http: { shutdownTimeout: 0 } });
  app.registerHttpController(SlowController);
  const address = await app.listen({ port: 0 });
  const pendingRequest = request(address, { path: '/slow' }).catch(() => undefined);
  await handlerStarted;

  await app.close();
  await pendingRequest;

  assert.equal(wasAborted, true);
});

test('сброс соединения при чтении HTTP-запроса уничтожает HTTP-ответ', async (t: any) => {
  let handleRequest: any;
  const server: any = new EventEmitter();
  server.address = () => ({ address: '127.0.0.1', family: 'IPv4', port: 3000 });
  server.close = (callback: any) => callback();
  server.listen = (_options: any, callback: any) => callback();
  t.mock.method(http, 'createServer', (listener: any) => {
    handleRequest = listener;
    return server;
  });

  const unexpectedErrors: any[] = [];
  class BodyController extends HttpControllerBase {
    static prefix = '/body';
    static routes = [{ method: 'POST', path: '/', handler: 'accept' }] as const;
    accept() {
      return { status: 204 };
    }
  }
  const app = new Application({
    appState: TestAppState,
    http: { onError: (_appState: any, error: any) => unexpectedErrors.push(error) },
  });
  app.registerHttpController(BodyController);
  await app.listen({ port: 0 });

  const incomingRequest: any = new EventEmitter();
  incomingRequest.url = '/body';
  incomingRequest.method = 'POST';
  incomingRequest.headers = { 'content-type': 'application/json' };
  incomingRequest.aborted = false;
  incomingRequest[Symbol.asyncIterator] = () => ({
    async next() {
      const error: any = new Error('connection reset');
      error.code = 'ECONNRESET';
      throw error;
    },
  });
  let markDestroyed: any;
  const destroyed = new Promise<any>((resolve: any) => {
    markDestroyed = resolve;
  });
  const response: any = new EventEmitter();
  response.headersSent = false;
  response.destroyed = false;
  response.destroy = () => {
    response.destroyed = true;
    response.emit('close');
    markDestroyed();
  };

  try {
    handleRequest(incomingRequest, response);
    await destroyed;
    assert.equal(response.destroyed, true);
    assert.deepEqual(unexpectedErrors, []);
  } finally {
    await app.close();
  }
});

test('jobs-http HTTP-контроллер запускает SumJob в Worker', async () => {
  const app = new Application({ appState: TestAppState, jobs: { poolSize: 1 } });
  app.registerHttpController(JobsController);
  const address = await app.listen({ port: 0 });

  try {
    const success = await request(address, {
      method: 'POST',
      path: '/jobs/sum',
      headers: { 'content-type': 'application/json' },
      body: '{"values":[1,2,3]}',
    });
    assert.equal(success.status, 200);
    assert.equal(success.body, '{"sum":6}');
    const invalid = await request(address, {
      method: 'POST',
      path: '/jobs/sum',
      headers: { 'content-type': 'application/json' },
      body: '{"values":[1,null]}',
    });
    assert.equal(invalid.status, 422);
  } finally {
    await app.close();
  }
});

test('HTTP transport нормализует строковые и бинарные тела', async () => {
  class BodiesController extends HttpControllerBase {
    static prefix = '/responses';
    static routes = [
      { method: 'GET', path: '/text', handler: 'text' },
      { method: 'GET', path: '/bytes', handler: 'bytes' },
    ] as const;
    text() {
      return { status: 200, body: 'hello' };
    }
    bytes() {
      return { status: 200, body: new Uint8Array([0, 1, 2]) };
    }
  }
  const app = new Application({ appState: TestAppState });
  app.registerHttpController(BodiesController);
  const address = await app.listen({ port: 0 });

  try {
    const text = await request(address, { path: '/responses/text' });
    assert.equal(text.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(text.body, 'hello');
    const bytes = await request(address, { path: '/responses/bytes' });
    assert.equal(bytes.headers['content-type'], 'application/octet-stream');
    assert.deepEqual(Buffer.from(bytes.body, 'binary'), Buffer.from([0, 1, 2]));
  } finally {
    await app.close();
  }
});

test('HTTP transport принимает только граничные статусы 200 и 599', async () => {
  class StatusController extends HttpControllerBase {
    static prefix = '/status';
    static routes = [
      { method: 'GET', path: '/minimum', handler: 'minimum' },
      { method: 'GET', path: '/maximum', handler: 'maximum' },
      { method: 'GET', path: '/below', handler: 'below' },
      { method: 'GET', path: '/above', handler: 'above' },
    ] as const;
    minimum() {
      return { status: 200 };
    }
    maximum() {
      return { status: 599 };
    }
    below() {
      return { status: 199 };
    }
    above() {
      return { status: 600 };
    }
  }
  const observed: any[] = [];
  const app = new Application({
    appState: TestAppState,
    http: { onError: (_appState: any, error: any) => observed.push(error) },
  });
  app.registerHttpController(StatusController);
  const address = await app.listen({ port: 0 });

  try {
    assert.equal((await request(address, { path: '/status/minimum' })).status, 200);
    assert.equal((await request(address, { path: '/status/maximum' })).status, 599);
    assert.equal((await request(address, { path: '/status/below' })).status, 500);
    assert.equal((await request(address, { path: '/status/above' })).status, 500);
    assert.equal(observed.length, 2);
    assert.ok(observed.every((error: any) => error instanceof TypeError));
  } finally {
    await app.close();
  }
});

test('ошибка до создания HttpRequestContext получает безопасный 500', async () => {
  const observed: any[] = [];
  const app = new Application({
    appState: TestAppState,
    http: {
      onError: (_appState: any, error: any, ctx: any) => observed.push({ error, ctx }),
    },
  });
  const address = await app.listen({ port: 0 });

  try {
    const response = await request(address, { path: 'http://[invalid' });
    assert.equal(response.status, 500);
    assert.equal(response.body, '{"error":"Internal Server Error"}');
    assert.equal(observed.length, 1);
    assert.equal(observed[0].ctx, undefined);
  } finally {
    await app.close();
  }
});

test('синхронная ошибка onError попадает в console.error и не меняет HTTP-ответ', async (t: any) => {
  const reportingError = new Error('reporting failed');
  const consoleError = t.mock.method(console, 'error', () => {});
  class FailingController extends HttpControllerBase {
    static prefix = '/failure';
    static routes = [{ method: 'GET', path: '/', handler: 'get' }] as const;
    get(): never {
      throw new Error('handler failed');
    }
  }
  const app = new Application({
    appState: TestAppState,
    http: {
      onError: () => {
        throw reportingError;
      },
    },
  });
  app.registerHttpController(FailingController);
  const address = await app.listen({ port: 0 });

  try {
    const response = await request(address, { path: '/failure' });
    assert.equal(response.status, 500);
    assert.equal(consoleError.mock.callCount(), 1);
    assert.equal(consoleError.mock.calls[0].arguments[0], reportingError);
  } finally {
    await app.close();
  }
});
