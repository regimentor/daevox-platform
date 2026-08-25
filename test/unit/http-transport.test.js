import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';

import { Application } from '../../lib/framework/Application.js';
import { createAuthentication } from '../../lib/framework/Authentication.js';
import { HttpControllerBase } from '../../lib/framework/HttpControllerBase.js';
import { AuthenticationStrategyError, HttpError } from '../../lib/framework/errors.js';
import { JobsController } from '../../examples/jobs-http/JobsController.js';

function request(address, options = {}) {
  return new Promise((resolve, reject) => {
    const clientRequest = http.request(
      {
        host: address.address,
        port: address.port,
        path: options.path ?? '/',
        method: options.method ?? 'GET',
        headers: options.headers,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
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

function incompleteRawRequest(address, requestHead) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: address.address, port: address.port });
    const chunks = [];
    socket.setTimeout(2_000, () => {
      socket.destroy();
      reject(new Error('Timed out waiting for an HTTP response'));
    });
    socket.on('connect', () => socket.write(requestHead));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString()));
    socket.on('error', reject);
  });
}

test('Application слушает ephemeral-порт и без HTTP-контроллеров отвечает 404', async () => {
  const app = new Application({ websocket: { authentication: false } });
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
  let seenContext;
  class UsersController extends HttpControllerBase {
    static prefix = '/users';
    static routes = [{ method: 'POST', path: '/:id', handler: 'update', authentication: false }];
    update(ctx) {
      seenContext = ctx;
      return {
        status: 200,
        headers: new Headers({ 'x-handler': 'update' }),
        body: { id: ctx.params.id, values: ctx.query.getAll('value'), received: ctx.body },
      };
    }
  }
  const app = new Application({ websocket: { authentication: false } });
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
    assert.equal('webSocket' in seenContext, false);
  } finally {
    await app.close();
  }
});

test('HTTP transport детерминированно обрабатывает HEAD, OPTIONS и 405', async () => {
  class ResourceController extends HttpControllerBase {
    static prefix = '/resource';
    static routes = [
      { method: 'GET', path: '/', handler: 'get', authentication: false },
      { method: 'POST', path: '/', handler: 'post', authentication: false },
    ];
    get() {
      return { status: 200, body: { ok: true } };
    }
    post() {
      return { status: 204 };
    }
  }
  const app = new Application({ websocket: { authentication: false } });
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
    static routes = [{ method: 'PUT', path: '/', handler: 'put', authentication: false }];
    put(ctx) {
      return { status: 200, body: ctx.body };
    }
  }
  const app = new Application({
    http: { bodyLimit: 8 },
    websocket: { authentication: false },
  });
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
  const observed = [];
  class ErrorController extends HttpControllerBase {
    static prefix = '/errors';
    static routes = [
      { method: 'GET', path: '/expected', handler: 'expected', authentication: false },
      { method: 'GET', path: '/unexpected', handler: 'unexpected', authentication: false },
      {
        method: 'GET',
        path: '/invalid-response',
        handler: 'invalidResponse',
        authentication: false,
      },
    ];
    expected() {
      throw new HttpError(422, {
        headers: new Headers({ 'x-error-code': 'INVALID' }),
        body: { error: 'Invalid values' },
      });
    }
    unexpected() {
      throw new Error('secret details');
    }
    invalidResponse() {
      return { status: 200, extra: true };
    }
  }
  const app = new Application({
    http: { onError: (error, ctx) => observed.push({ error, ctx }) },
    websocket: { authentication: false },
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
  let started;
  const handlerStarted = new Promise((resolve) => {
    started = resolve;
  });
  let wasAborted = false;
  class SlowController extends HttpControllerBase {
    static prefix = '/slow';
    static routes = [{ method: 'GET', path: '/', handler: 'get', authentication: false }];
    get(ctx) {
      started();
      return new Promise((resolve) => {
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
  const app = new Application({
    http: { shutdownTimeout: 0 },
    websocket: { authentication: false },
  });
  app.registerHttpController(SlowController);
  const address = await app.listen({ port: 0 });
  const pendingRequest = request(address, { path: '/slow' }).catch(() => undefined);
  await handlerStarted;

  await app.close();
  await pendingRequest;

  assert.equal(wasAborted, true);
});

test('сброс соединения при чтении HTTP-запроса уничтожает HTTP-ответ', async (t) => {
  let handleRequest;
  const server = new EventEmitter();
  server.address = () => ({ address: '127.0.0.1', family: 'IPv4', port: 3000 });
  server.close = (callback) => callback();
  server.listen = (_options, callback) => callback();
  t.mock.method(http, 'createServer', (listener) => {
    handleRequest = listener;
    return server;
  });

  const unexpectedErrors = [];
  class BodyController extends HttpControllerBase {
    static prefix = '/body';
    static routes = [{ method: 'POST', path: '/', handler: 'accept', authentication: false }];
    accept() {
      return { status: 204 };
    }
  }
  const app = new Application({
    http: { onError: (error) => unexpectedErrors.push(error) },
    websocket: { authentication: false },
  });
  app.registerHttpController(BodyController);
  await app.listen({ port: 0 });

  const incomingRequest = new EventEmitter();
  incomingRequest.url = '/body';
  incomingRequest.method = 'POST';
  incomingRequest.headers = { 'content-type': 'application/json' };
  incomingRequest.aborted = false;
  incomingRequest[Symbol.asyncIterator] = () => ({
    async next() {
      const error = new Error('connection reset');
      error.code = 'ECONNRESET';
      throw error;
    },
  });
  let markDestroyed;
  const destroyed = new Promise((resolve) => {
    markDestroyed = resolve;
  });
  const response = new EventEmitter();
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
  const app = new Application({
    jobs: { poolSize: 1 },
    websocket: { authentication: false },
  });
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
      { method: 'GET', path: '/text', handler: 'text', authentication: false },
      { method: 'GET', path: '/bytes', handler: 'bytes', authentication: false },
    ];
    text() {
      return { status: 200, body: 'hello' };
    }
    bytes() {
      return { status: 200, body: new Uint8Array([0, 1, 2]) };
    }
  }
  const app = new Application({ websocket: { authentication: false } });
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
      { method: 'GET', path: '/minimum', handler: 'minimum', authentication: false },
      { method: 'GET', path: '/maximum', handler: 'maximum', authentication: false },
      { method: 'GET', path: '/below', handler: 'below', authentication: false },
      { method: 'GET', path: '/above', handler: 'above', authentication: false },
    ];
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
  const observed = [];
  const app = new Application({
    http: { onError: (error) => observed.push(error) },
    websocket: { authentication: false },
  });
  app.registerHttpController(StatusController);
  const address = await app.listen({ port: 0 });

  try {
    assert.equal((await request(address, { path: '/status/minimum' })).status, 200);
    assert.equal((await request(address, { path: '/status/maximum' })).status, 599);
    assert.equal((await request(address, { path: '/status/below' })).status, 500);
    assert.equal((await request(address, { path: '/status/above' })).status, 500);
    assert.equal(observed.length, 2);
    assert.ok(observed.every((error) => error instanceof TypeError));
  } finally {
    await app.close();
  }
});

test('ошибка до создания HttpRequestContext получает безопасный 500', async () => {
  const observed = [];
  const app = new Application({
    http: { onError: (error, ctx) => observed.push({ error, ctx }) },
    websocket: { authentication: false },
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

test('синхронная ошибка onError попадает в console.error и не меняет HTTP-ответ', async (t) => {
  const reportingError = new Error('reporting failed');
  const consoleError = t.mock.method(console, 'error', () => {});
  class FailingController extends HttpControllerBase {
    static prefix = '/failure';
    static routes = [{ method: 'GET', path: '/', handler: 'get', authentication: false }];
    get() {
      throw new Error('handler failed');
    }
  }
  const app = new Application({
    http: {
      onError: () => {
        throw reportingError;
      },
    },
    websocket: { authentication: false },
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

test('HTTP transport отображает outcomes Authentication до вызова HTTP-обработчика', async () => {
  const attempts = [];
  const observed = [];
  let controllerCreations = 0;
  let authenticatedContext;
  const authentication = createAuthentication({
    strategies: {
      session: {
        authenticate(input) {
          attempts.push(input);
          if (input.path === '/auth/error') throw new Error('credential details');
          const credential = input.headers.get('authorization');
          if (credential === null) return { status: 'abstain' };
          if (credential !== 'Session valid') {
            return {
              status: 'rejected',
              code: 'INVALID_CREDENTIALS',
              challenge: 'Session realm="daevox"',
            };
          }
          return {
            status: 'authenticated',
            session: {
              authSessionId: 'session-42',
              principal: { id: 'user-42', roles: ['member'] },
            },
          };
        },
      },
    },
    scenarios: {
      optional: { use: ['session'], required: false },
      required: { use: ['session'], required: true },
    },
  });
  class AuthController extends HttpControllerBase {
    static prefix = '/auth';
    static routes = [
      { method: 'GET', path: '/optional', handler: 'optional', authentication: 'optional' },
      { method: 'GET', path: '/required', handler: 'required', authentication: 'required' },
      { method: 'GET', path: '/error', handler: 'required', authentication: 'required' },
    ];
    constructor(options) {
      super(options);
      controllerCreations += 1;
    }
    optional(ctx) {
      return {
        status: 200,
        body: {
          hasAuthSession: Object.hasOwn(ctx, 'authSession'),
          hasWebSocket: Object.hasOwn(ctx, 'webSocket'),
        },
      };
    }
    required(ctx) {
      authenticatedContext = ctx;
      return { status: 200, body: ctx.authSession };
    }
  }
  const app = new Application({
    authentication,
    http: { onError: (error, ctx) => observed.push({ error, ctx }) },
    websocket: { authentication: false },
  });
  app.registerHttpController(AuthController);
  const address = await app.listen({ port: 0 });

  try {
    const notFound = await request(address, { path: '/missing' });
    const options = await request(address, { method: 'OPTIONS', path: '/auth/required' });
    const methodNotAllowed = await request(address, {
      method: 'DELETE',
      path: '/auth/required',
    });
    assert.equal(notFound.status, 404);
    assert.equal(options.status, 204);
    assert.equal(methodNotAllowed.status, 405);
    assert.equal(attempts.length, 0);

    const optional = await request(address, { path: '/auth/optional?source=test' });
    assert.equal(optional.status, 200);
    assert.equal(optional.body, '{"hasAuthSession":false,"hasWebSocket":false}');

    const required = await request(address, { path: '/auth/required' });
    assert.equal(required.status, 401);
    assert.equal(required.headers['www-authenticate'], undefined);
    assert.equal(required.body, '{"error":{"code":"AUTHENTICATION_REQUIRED"}}');

    const rejected = await request(address, {
      path: '/auth/required',
      headers: { authorization: 'Session invalid' },
    });
    assert.equal(rejected.status, 401);
    assert.equal(rejected.headers['www-authenticate'], 'Session realm="daevox"');
    assert.equal(rejected.body, '{"error":{"code":"INVALID_CREDENTIALS"}}');

    const authenticated = await request(address, {
      path: '/auth/required',
      headers: { authorization: 'Session valid' },
    });
    assert.equal(authenticated.status, 200);
    assert.equal(
      authenticated.body,
      '{"authSessionId":"session-42","principal":{"id":"user-42","roles":["member"]}}',
    );
    assert.ok(Object.isFrozen(authenticatedContext));
    assert.ok(Object.isFrozen(authenticatedContext.authSession));
    assert.ok(Object.isFrozen(authenticatedContext.authSession.principal));
    assert.deepEqual(Object.keys(authenticatedContext.authSession), ['authSessionId', 'principal']);
    assert.equal('authorization' in authenticatedContext.authSession, false);

    const failed = await request(address, { path: '/auth/error' });
    assert.equal(failed.status, 500);
    assert.equal(failed.body, '{"error":{"code":"INTERNAL_SERVER_ERROR"}}');
    assert.equal(controllerCreations, 2);
    assert.equal(observed.length, 1);
    assert.ok(observed[0].error instanceof AuthenticationStrategyError);
    assert.deepEqual(Object.keys(observed[0].ctx).toSorted(), [
      'method',
      'path',
      'phase',
      'scenario',
      'signal',
    ]);
    assert.ok(Object.isFrozen(observed[0].ctx));
    assert.equal(observed[0].ctx.phase, 'authentication');

    assert.equal(attempts[0].transport, 'http');
    assert.equal(attempts[0].method, 'GET');
    assert.equal(attempts[0].path, '/auth/optional');
    assert.equal(attempts[0].query.get('source'), 'test');
    assert.ok(Object.isFrozen(attempts[0]));
    assert.equal('params' in attempts[0], false);
    assert.equal('body' in attempts[0], false);
    assert.equal('request' in attempts[0], false);
    assert.equal('socket' in attempts[0], false);
    assert.equal(observed[0].error.cause.message, 'credential details');
  } finally {
    await app.close();
  }
});

test('авторизованный HttpRequestContext получает request-scoped WebSocket sender', async () => {
  let seenContext;
  let sendResult;
  const authentication = createAuthentication({
    strategies: {
      session: {
        authenticate: () => ({
          status: 'authenticated',
          session: { authSessionId: 'session-42', principal: { id: 'user-42' } },
        }),
      },
    },
    scenarios: { required: { use: ['session'], required: true } },
  });
  class PushController extends HttpControllerBase {
    static prefix = '/push';
    static routes = [{ method: 'POST', path: '/', handler: 'send', authentication: 'required' }];
    send(ctx) {
      seenContext = ctx;
      sendResult = ctx.webSocket.send({
        controller: 'notifications',
        event: 'changed',
        body: { resourceId: 'resource-1' },
      });
      return { status: 202, body: sendResult };
    }
  }
  const app = new Application({
    authentication,
    websocket: { authentication: false },
  });
  app.registerHttpController(PushController);
  const address = await app.listen({ port: 0 });

  try {
    const response = await request(address, { method: 'POST', path: '/push/' });

    assert.equal(response.status, 202);
    assert.equal(response.body, '{"matched":0,"queued":0,"dropped":0}');
    assert.ok(Object.isFrozen(seenContext.webSocket));
    assert.deepEqual(Object.keys(seenContext.webSocket), ['send']);
    assert.ok(Object.isFrozen(sendResult));
    assert.deepEqual(Object.keys(sendResult), ['matched', 'queued', 'dropped']);
  } finally {
    await app.close();
  }
});

test('HTTP authentication отклоняет запрос до чтения первого body chunk', async () => {
  let controllerCreations = 0;
  let handlerCalls = 0;
  const authentication = createAuthentication({
    strategies: {
      session: {
        authenticate: () => ({
          status: 'rejected',
          code: 'INVALID_CREDENTIALS',
          challenge: 'Bearer',
        }),
      },
    },
    scenarios: { required: { use: ['session'], required: true } },
  });
  class UploadController extends HttpControllerBase {
    static prefix = '/upload';
    static routes = [{ method: 'POST', path: '/', handler: 'upload', authentication: 'required' }];
    constructor(options) {
      super(options);
      controllerCreations += 1;
    }
    upload() {
      handlerCalls += 1;
      return { status: 204 };
    }
  }
  const app = new Application({
    authentication,
    http: { bodyLimit: 0 },
    websocket: { authentication: false },
  });
  app.registerHttpController(UploadController);
  const address = await app.listen({ port: 0 });

  try {
    const response = await incompleteRawRequest(
      address,
      [
        'POST /upload HTTP/1.1',
        `Host: ${address.address}:${address.port}`,
        'Content-Type: text/plain',
        'Content-Length: 100',
        'Connection: close',
        '',
        '',
      ].join('\r\n'),
    );
    assert.match(response, /^HTTP\/1\.1 401 Unauthorized\r\n/);
    assert.match(response, /www-authenticate: Bearer\r\n/i);
    assert.match(response, /\{"error":\{"code":"INVALID_CREDENTIALS"\}\}$/);
    assert.equal(controllerCreations, 0);
    assert.equal(handlerCalls, 0);
  } finally {
    await app.close();
  }
});

test('HTTP authentication прекращается при отмене клиента без handler и onError', async () => {
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  let markAborted;
  const aborted = new Promise((resolve) => {
    markAborted = resolve;
  });
  let handlerCalls = 0;
  const observed = [];
  const authentication = createAuthentication({
    strategies: {
      slow: {
        authenticate(input) {
          markStarted();
          return new Promise((resolve) => {
            input.signal.addEventListener(
              'abort',
              () => {
                markAborted();
                resolve({ status: 'abstain' });
              },
              { once: true },
            );
          });
        },
      },
    },
    scenarios: { required: { use: ['slow'], required: true } },
  });
  class SlowAuthController extends HttpControllerBase {
    static prefix = '/slow-auth';
    static routes = [{ method: 'POST', path: '/', handler: 'post', authentication: 'required' }];
    post() {
      handlerCalls += 1;
      return { status: 204 };
    }
  }
  const app = new Application({
    authentication,
    http: { onError: (error) => observed.push(error) },
    websocket: { authentication: false },
  });
  app.registerHttpController(SlowAuthController);
  const address = await app.listen({ port: 0 });
  const socket = net.createConnection({ host: address.address, port: address.port });

  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write(
      [
        'POST /slow-auth HTTP/1.1',
        `Host: ${address.address}:${address.port}`,
        'Content-Length: 1',
        '',
        '',
      ].join('\r\n'),
    );
    await started;
    socket.destroy();
    await aborted;
    assert.equal(handlerCalls, 0);
    assert.deepEqual(observed, []);
  } finally {
    socket.destroy();
    await app.close();
  }
});
