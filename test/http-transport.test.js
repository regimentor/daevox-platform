import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { Application } from '../lib/framework/Application.js';
import { HttpControllerBase } from '../lib/framework/HttpControllerBase.js';
import { HttpError } from '../lib/framework/errors.js';
import { JobsController } from '../examples/jobs-http/JobsController.js';

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

test('Application слушает ephemeral-порт и без HTTP-контроллеров отвечает 404', async () => {
  const app = new Application();
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
    static routes = [{ method: 'POST', path: '/:id', handler: 'update' }];
    update(ctx) {
      seenContext = ctx;
      return {
        status: 200,
        headers: new Headers({ 'x-handler': 'update' }),
        body: { id: ctx.params.id, values: ctx.query.getAll('value'), received: ctx.body },
      };
    }
  }
  const app = new Application();
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

test('HTTP transport детерминированно обрабатывает HEAD, OPTIONS и 405', async () => {
  class ResourceController extends HttpControllerBase {
    static prefix = '/resource';
    static routes = [
      { method: 'GET', path: '/', handler: 'get' },
      { method: 'POST', path: '/', handler: 'post' },
    ];
    get() {
      return { status: 200, body: { ok: true } };
    }
    post() {
      return { status: 204 };
    }
  }
  const app = new Application();
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
    static routes = [{ method: 'PUT', path: '/', handler: 'put' }];
    put(ctx) {
      return { status: 200, body: ctx.body };
    }
  }
  const app = new Application({ http: { bodyLimit: 8 } });
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
      { method: 'GET', path: '/expected', handler: 'expected' },
      { method: 'GET', path: '/unexpected', handler: 'unexpected' },
      { method: 'GET', path: '/invalid-response', handler: 'invalidResponse' },
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
  const app = new Application({ http: { onError: (error, ctx) => observed.push({ error, ctx }) } });
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
    static routes = [{ method: 'GET', path: '/', handler: 'get' }];
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
  const app = new Application({ http: { shutdownTimeout: 0 } });
  app.registerHttpController(SlowController);
  const address = await app.listen({ port: 0 });
  const pendingRequest = request(address, { path: '/slow' }).catch(() => undefined);
  await handlerStarted;

  await app.close();
  await pendingRequest;

  assert.equal(wasAborted, true);
});

test('jobs-http HTTP-контроллер запускает SumJob в Worker', async () => {
  const app = new Application({ jobs: { poolSize: 1 } });
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
    ];
    text() {
      return { status: 200, body: 'hello' };
    }
    bytes() {
      return { status: 200, body: new Uint8Array([0, 1, 2]) };
    }
  }
  const app = new Application();
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

test('ошибка до создания HttpRequestContext получает безопасный 500', async () => {
  const observed = [];
  const app = new Application({ http: { onError: (error, ctx) => observed.push({ error, ctx }) } });
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
    static routes = [{ method: 'GET', path: '/', handler: 'get' }];
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
