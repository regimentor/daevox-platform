import assert from 'node:assert/strict';
import test from 'node:test';

import { Application } from '../lib/framework/Application.js';
import { HttpControllerBase } from '../lib/framework/HttpControllerBase.js';
import {
  DuplicateHttpControllerError,
  HttpRouteConflictError,
  InvalidHttpControllerError,
  InvalidHttpRouteError,
  InvalidJobOptionsError,
} from '../lib/framework/errors.js';

function UnrelatedController() {}

function controller({ prefix = '/users', routes } = {}) {
  return class HttpController extends HttpControllerBase {
    static prefix = prefix;

    static routes = routes ?? [{ method: 'GET', path: '/', handler: 'list' }];

    list() {}

    getById() {}

    current() {}
  };
}

test('Application регистрирует HTTP-контроллер и возвращает себя', () => {
  const app = new Application();

  assert.equal(app.registerHttpController(controller()), app);
});

test('Application отклоняет повторную регистрацию того же класса', () => {
  const app = new Application();
  const UsersController = controller();
  app.registerHttpController(UsersController);

  assert.throws(() => app.registerHttpController(UsersController), DuplicateHttpControllerError);
});

test('HTTP-контроллер обязан напрямую наследовать HttpControllerBase', () => {
  class IndirectBase extends HttpControllerBase {}
  class IndirectController extends IndirectBase {
    static prefix = '/users';
    static routes = [{ method: 'GET', path: '/', handler: 'list' }];
    list() {}
  }

  for (const value of [null, {}, () => {}, UnrelatedController, IndirectController]) {
    assert.throws(
      () => new Application().registerHttpController(value),
      InvalidHttpControllerError,
    );
  }
});

test('prefix и routes должны быть собственными непустыми метаданными', () => {
  class Parent extends HttpControllerBase {
    static prefix = '/users';
    static routes = [{ method: 'GET', path: '/', handler: 'list' }];
    list() {}
  }

  for (const HttpController of [
    class MissingPrefix extends HttpControllerBase {
      static routes = [{ method: 'GET', path: '/', handler: 'list' }];
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
      () => new Application().registerHttpController(HttpController),
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
    static routes = [{ method: 'GET', path: '/', handler: 'list' }];
  }
  class StaticHandler extends HttpControllerBase {
    static prefix = '/users';
    static routes = [{ method: 'GET', path: '/', handler: 'list' }];
    static list() {}
  }

  for (const HttpController of [InheritedHandler, StaticHandler]) {
    assert.throws(
      () => new Application().registerHttpController(HttpController),
      InvalidHttpControllerError,
    );
  }
});

test('декларация HTTP-маршрута содержит ровно три строковых поля', () => {
  for (const definition of [
    null,
    { method: 'GET', path: '/', handler: 'list', extra: true },
    { method: '', path: '/', handler: 'list' },
    { method: 'GET', path: '', handler: 'list' },
    { method: 'GET', path: '/', handler: '' },
  ]) {
    assert.throws(
      () => new Application().registerHttpController(controller({ routes: [definition] })),
      InvalidHttpRouteError,
    );
  }
});

test('декларация HTTP-маршрута отклоняет неизвестные own fields', () => {
  const definition = { method: 'GET', path: '/', handler: 'list' };
  Object.defineProperty(definition, 'hidden', { value: true });
  definition[Symbol('unknown')] = true;

  assert.throws(
    () => new Application().registerHttpController(controller({ routes: [definition] })),
    InvalidHttpRouteError,
  );
});

test('некорректное percent-кодирование пути отклоняется при регистрации', () => {
  assert.throws(
    () =>
      new Application().registerHttpController(
        controller({
          routes: [{ method: 'GET', path: '/%ZZ', handler: 'list' }],
        }),
      ),
    InvalidHttpRouteError,
  );
});

test('некорректный prefix является ошибкой HTTP-контроллера', () => {
  assert.throws(
    () => new Application().registerHttpController(controller({ prefix: '/..' })),
    InvalidHttpControllerError,
  );
});

test('регистрация нормализует метод и композицию пути до проверки конфликтов', () => {
  const app = new Application();
  app.registerHttpController(
    controller({
      prefix: 'users//',
      routes: [{ method: 'get', path: '/hello%20world/', handler: 'list' }],
    }),
  );

  assert.throws(
    () =>
      app.registerHttpController(
        controller({
          prefix: '/users',
          routes: [{ method: 'GET', path: 'hello world', handler: 'list' }],
        }),
      ),
    HttpRouteConflictError,
  );
});

test('композиция корневых путей и encoded slash сохраняют границы сегментов', () => {
  const app = new Application();
  app.registerHttpController(
    controller({
      prefix: '/',
      routes: [{ method: 'GET', path: '/value%2Fpart', handler: 'list' }],
    }),
  );

  assert.throws(
    () =>
      app.registerHttpController(
        controller({
          prefix: '/',
          routes: [{ method: 'GET', path: '/value%2fpart/', handler: 'list' }],
        }),
      ),
    HttpRouteConflictError,
  );
});

test('изменение метаданных после регистрации не изменяет каталог', () => {
  const app = new Application();
  const UsersController = controller();
  app.registerHttpController(UsersController);
  UsersController.prefix = '/changed';
  UsersController.routes[0].path = '/changed';

  assert.throws(() => app.registerHttpController(controller()), HttpRouteConflictError);
});

test('неуспешная регистрация не изменяет состояние Application', () => {
  const app = new Application();
  const UsersController = controller({
    routes: [
      { method: 'GET', path: '/:id', handler: 'getById' },
      { method: 'GET', path: '/:userId', handler: 'getById' },
    ],
  });

  assert.throws(() => app.registerHttpController(UsersController), HttpRouteConflictError);

  UsersController.routes = [{ method: 'GET', path: '/:id', handler: 'getById' }];
  assert.equal(app.registerHttpController(UsersController), app);
});

test('Application проверяет вложенную конфигурацию jobs', () => {
  for (const jobs of [null, [], { poolSize: 0 }, { queueSize: -1 }, { unknown: true }]) {
    assert.throws(() => new Application({ jobs }), InvalidJobOptionsError);
  }
});

test('Application не раскрывает JobRunner или WorkerPool публичными свойствами', async () => {
  const app = new Application({ jobs: { poolSize: 1, queueSize: 0 } });

  assert.deepEqual(Object.keys(app), []);
  assert.equal('jobRunner' in app, false);
  assert.equal('workerPool' in app, false);
  await app.close();
});

test('Application.close идемпотентно закрывает принадлежащие ресурсы', async () => {
  const app = new Application();
  const closing = app.close();

  assert.equal(app.close(), closing);
  await closing;
});
