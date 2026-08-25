import assert from 'node:assert/strict';
import test from 'node:test';

import { Application } from '../../lib/framework/Application.js';
import { createAuthentication } from '../../lib/framework/Authentication.js';
import { HttpControllerBase } from '../../lib/framework/HttpControllerBase.js';
import {
  ApplicationStateError,
  DuplicateHttpControllerError,
  HttpRouteConflictError,
  InvalidHttpControllerError,
  InvalidAuthenticationOptionsError,
  InvalidHttpOptionsError,
  InvalidHttpRouteError,
  InvalidJobOptionsError,
} from '../../lib/framework/errors.js';
import { WebSocketControllerBase } from '../../lib/framework/WebSocketControllerBase.js';

function UnrelatedController() {}

function controller({ prefix = '/users', routes } = {}) {
  return class HttpController extends HttpControllerBase {
    static prefix = prefix;

    static routes = routes ?? [
      { method: 'GET', path: '/', handler: 'list', authentication: false },
    ];

    list() {}

    getById() {}

    current() {}
  };
}

test('Application регистрирует HTTP-контроллер и возвращает себя', () => {
  const app = new Application({ websocket: { authentication: false } });

  assert.equal(app.registerHttpController(controller()), app);
});

test('Application запрещает регистрацию и повторный запуск после начала listen', async () => {
  const app = new Application({ websocket: { authentication: false } });
  const listening = app.listen({ port: 0 });

  assert.throws(() => app.registerHttpController(controller()), ApplicationStateError);
  await assert.rejects(app.listen({ port: 0 }), ApplicationStateError);
  await listening;
  await app.close();
});

test('Application запрещает регистрацию WebSocket-контроллера после начала listen', async () => {
  class NotificationsController extends WebSocketControllerBase {
    static name = 'notifications';
    static events = [{ name: 'subscribe', handler: 'subscribe' }];
    subscribe() {}
  }
  const app = new Application({ websocket: { authentication: false } });
  const listening = app.listen({ port: 0 });

  assert.throws(
    () => app.registerWebSocketController(NotificationsController),
    ApplicationStateError,
  );
  await listening;
  await app.close();
});

test('Application.close до listen необратимо закрывает приложение', async () => {
  const app = new Application({ websocket: { authentication: false } });
  await app.close();

  assert.throws(() => app.registerHttpController(controller()), ApplicationStateError);
  await assert.rejects(app.listen({ port: 0 }), ApplicationStateError);
});

test('Application.close освобождает ресурсы при ошибке запуска', async () => {
  const occupied = new Application({ websocket: { authentication: false } });
  const address = await occupied.listen({ port: 0 });
  const app = new Application({ websocket: { authentication: false } });
  const listening = app.listen({ port: address.port });
  const closing = app.close();

  await assert.rejects(listening, { code: 'EADDRINUSE' });
  await closing;
  await occupied.close();
  await assert.rejects(app.listen({ port: 0 }), ApplicationStateError);
});

test('Application отклоняет повторную регистрацию того же класса', () => {
  const app = new Application({ websocket: { authentication: false } });
  const UsersController = controller();
  app.registerHttpController(UsersController);

  assert.throws(() => app.registerHttpController(UsersController), DuplicateHttpControllerError);
});

test('HTTP-контроллер обязан напрямую наследовать HttpControllerBase', () => {
  class IndirectBase extends HttpControllerBase {}
  class IndirectController extends IndirectBase {
    static prefix = '/users';
    static routes = [{ method: 'GET', path: '/', handler: 'list', authentication: false }];
    list() {}
  }

  for (const value of [null, {}, () => {}, UnrelatedController, IndirectController]) {
    assert.throws(
      () => new Application({ websocket: { authentication: false } }).registerHttpController(value),
      InvalidHttpControllerError,
    );
  }
});

test('prefix и routes должны быть собственными непустыми метаданными', () => {
  class Parent extends HttpControllerBase {
    static prefix = '/users';
    static routes = [{ method: 'GET', path: '/', handler: 'list', authentication: false }];
    list() {}
  }

  for (const HttpController of [
    class MissingPrefix extends HttpControllerBase {
      static routes = [{ method: 'GET', path: '/', handler: 'list', authentication: false }];
      list() {}
    },
    controller({ prefix: '' }),
    class MissingRoutes extends HttpControllerBase {
      static prefix = '/users';
      list() {}
    },
    controller({ routes: [] }),
    class InheritedMetadata extends Parent {},
  ]) {
    assert.throws(
      () =>
        new Application({ websocket: { authentication: false } }).registerHttpController(
          HttpController,
        ),
      InvalidHttpControllerError,
    );
  }
});

test('HTTP-обработчик должен быть собственным методом экземпляра', () => {
  class Parent extends HttpControllerBase {
    list() {}
  }
  class InheritedHandler extends Parent {
    static prefix = '/users';
    static routes = [{ method: 'GET', path: '/', handler: 'list', authentication: false }];
  }
  class StaticHandler extends HttpControllerBase {
    static prefix = '/users';
    static routes = [{ method: 'GET', path: '/', handler: 'list', authentication: false }];
    static list() {}
  }

  for (const HttpController of [InheritedHandler, StaticHandler]) {
    assert.throws(
      () =>
        new Application({ websocket: { authentication: false } }).registerHttpController(
          HttpController,
        ),
      InvalidHttpControllerError,
    );
  }
});

test('декларация HTTP-маршрута требует exact-key authentication selector', () => {
  for (const definition of [
    null,
    { method: 'GET', path: '/', handler: 'list' },
    { method: 'GET', path: '/', handler: 'list', authentication: false, extra: true },
    { method: '', path: '/', handler: 'list', authentication: false },
    { method: 'GET', path: '', handler: 'list', authentication: false },
    { method: 'GET', path: '/', handler: '', authentication: false },
    { method: 'GET', path: '/', handler: 'list', authentication: true },
    { method: 'GET', path: '/', handler: 'list', authentication: 'invalid scenario' },
  ]) {
    assert.throws(
      () =>
        new Application({ websocket: { authentication: false } }).registerHttpController(
          controller({ routes: [definition] }),
        ),
      InvalidHttpRouteError,
    );
  }
});

test('декларация HTTP-маршрута отклоняет неизвестные own fields', () => {
  const definition = { method: 'GET', path: '/', handler: 'list', authentication: false };
  Object.defineProperty(definition, 'hidden', { value: true });
  definition[Symbol('unknown')] = true;

  assert.throws(
    () =>
      new Application({ websocket: { authentication: false } }).registerHttpController(
        controller({ routes: [definition] }),
      ),
    InvalidHttpRouteError,
  );
});

test('декларация HTTP-маршрута не вызывает accessors', () => {
  let authenticationWasRead = false;
  const definition = { method: 'GET', path: '/', handler: 'list' };
  Object.defineProperty(definition, 'authentication', {
    enumerable: true,
    get() {
      authenticationWasRead = true;
      return false;
    },
  });

  assert.throws(
    () =>
      new Application({ websocket: { authentication: false } }).registerHttpController(
        controller({ routes: [definition] }),
      ),
    InvalidHttpRouteError,
  );
  assert.equal(authenticationWasRead, false);
});

test('некорректное percent-кодирование пути отклоняется при регистрации', () => {
  assert.throws(
    () =>
      new Application({ websocket: { authentication: false } }).registerHttpController(
        controller({
          routes: [{ method: 'GET', path: '/%ZZ', handler: 'list', authentication: false }],
        }),
      ),
    InvalidHttpRouteError,
  );
});

test('некорректный prefix является ошибкой HTTP-контроллера', () => {
  assert.throws(
    () =>
      new Application({ websocket: { authentication: false } }).registerHttpController(
        controller({ prefix: '/..' }),
      ),
    InvalidHttpControllerError,
  );
});

test('регистрация нормализует метод и композицию пути до проверки конфликтов', () => {
  const app = new Application({ websocket: { authentication: false } });
  app.registerHttpController(
    controller({
      prefix: 'users//',
      routes: [{ method: 'get', path: '/hello%20world/', handler: 'list', authentication: false }],
    }),
  );

  assert.throws(
    () =>
      app.registerHttpController(
        controller({
          prefix: '/users',
          routes: [{ method: 'GET', path: 'hello world', handler: 'list', authentication: false }],
        }),
      ),
    HttpRouteConflictError,
  );
});

test('композиция корневых путей и encoded slash сохраняют границы сегментов', () => {
  const app = new Application({ websocket: { authentication: false } });
  app.registerHttpController(
    controller({
      prefix: '/',
      routes: [{ method: 'GET', path: '/value%2Fpart', handler: 'list', authentication: false }],
    }),
  );

  assert.throws(
    () =>
      app.registerHttpController(
        controller({
          prefix: '/',
          routes: [
            { method: 'GET', path: '/value%2fpart/', handler: 'list', authentication: false },
          ],
        }),
      ),
    HttpRouteConflictError,
  );
});

test('изменение метаданных после регистрации не изменяет каталог', () => {
  const app = new Application({ websocket: { authentication: false } });
  const UsersController = controller();
  app.registerHttpController(UsersController);
  UsersController.prefix = '/changed';
  UsersController.routes[0].path = '/changed';

  assert.throws(() => app.registerHttpController(controller()), HttpRouteConflictError);
});

test('неуспешная регистрация не изменяет состояние Application', () => {
  const app = new Application({ websocket: { authentication: false } });
  const UsersController = controller({
    routes: [
      { method: 'GET', path: '/:id', handler: 'getById', authentication: false },
      { method: 'GET', path: '/:userId', handler: 'getById', authentication: false },
    ],
  });

  assert.throws(() => app.registerHttpController(UsersController), HttpRouteConflictError);

  UsersController.routes = [
    { method: 'GET', path: '/:id', handler: 'getById', authentication: false },
  ];
  assert.equal(app.registerHttpController(UsersController), app);
});

test('Application атомарно проверяет ссылки HTTP-маршрутов на scenarios', () => {
  const authentication = createAuthentication({
    strategies: { session: { authenticate: () => ({ status: 'abstain' }) } },
    scenarios: { browser: { use: ['session'], required: true } },
  });
  const app = new Application({ authentication, websocket: { authentication: false } });
  const UsersController = controller({
    routes: [
      { method: 'GET', path: '/current', handler: 'current', authentication: 'browser' },
      { method: 'GET', path: '/legacy', handler: 'list', authentication: 'missing' },
    ],
  });

  assert.throws(
    () => app.registerHttpController(UsersController),
    InvalidAuthenticationOptionsError,
  );

  UsersController.routes = [
    { method: 'GET', path: '/current', handler: 'current', authentication: 'browser' },
  ];
  assert.equal(app.registerHttpController(UsersController), app);
});

test('Application требует framework Authentication для строкового selector', () => {
  assert.throws(
    () =>
      new Application({ websocket: { authentication: false } }).registerHttpController(
        controller({
          routes: [{ method: 'GET', path: '/', handler: 'list', authentication: 'browser' }],
        }),
      ),
    InvalidAuthenticationOptionsError,
  );
  assert.throws(
    () =>
      new Application({
        authentication: { authenticate() {} },
        websocket: { authentication: false },
      }),
    InvalidAuthenticationOptionsError,
  );
});

test('Application проверяет вложенную конфигурацию jobs', () => {
  for (const jobs of [null, [], { poolSize: 0 }, { queueSize: -1 }, { unknown: true }]) {
    assert.throws(
      () => new Application({ jobs, websocket: { authentication: false } }),
      InvalidJobOptionsError,
    );
  }
});

test('Application строго проверяет вложенную конфигурацию http', () => {
  for (const http of [
    null,
    [],
    { bodyLimit: -1 },
    { bodyLimit: 1.5 },
    { shutdownTimeout: -1 },
    { onError: true },
    { unknown: true },
  ]) {
    assert.throws(
      () => new Application({ http, websocket: { authentication: false } }),
      InvalidHttpOptionsError,
    );
  }
});

test('Application не раскрывает JobRunner или WorkerPool публичными свойствами', async () => {
  const app = new Application({
    jobs: { poolSize: 1, queueSize: 0 },
    websocket: { authentication: false },
  });

  assert.deepEqual(Object.keys(app), []);
  assert.equal('jobRunner' in app, false);
  assert.equal('workerPool' in app, false);
  await app.close();
});

test('Application.close идемпотентно закрывает принадлежащие ресурсы', async () => {
  const app = new Application({ websocket: { authentication: false } });
  const closing = app.close();

  assert.equal(app.close(), closing);
  await closing;
});
