class TestAppState {
  readonly marker = undefined;
}
import assert from 'node:assert/strict';
import test from 'node:test';

import { Application } from '../../src/Application.ts';
import { HttpControllerBase } from '../../src/HttpControllerBase.ts';
import {
  ApplicationStateError,
  DuplicateHttpControllerError,
  HttpRouteConflictError,
  InvalidHttpControllerError,
  InvalidHttpOptionsError,
  InvalidHttpRouteError,
  InvalidJobOptionsError,
} from '../../src/errors.ts';
import { WebSocketControllerBase } from '../../src/WebSocketControllerBase.ts';

function UnrelatedController() {}

function controller({ prefix = '/users', routes }: any = {}) {
  return class HttpController extends HttpControllerBase {
    static prefix = prefix;

    static routes = routes ?? [{ method: 'GET', path: '/', handler: 'list' }];

    list() {}

    getById() {}

    current() {}
  } as any;
}

test('Application регистрирует HTTP-контроллер и возвращает себя', () => {
  const app = new Application({ appState: TestAppState });

  assert.equal(app.registerHttpController(controller()), app);
});

test('Application запрещает регистрацию и повторный запуск после начала listen', async () => {
  const app = new Application({ appState: TestAppState });
  const listening = app.listen({ port: 0 });

  assert.throws(() => app.registerHttpController(controller()), ApplicationStateError);
  await assert.rejects(app.listen({ port: 0 }), ApplicationStateError);
  await listening;
  await app.close();
});

test('Application запрещает регистрацию WebSocket-контроллера после начала listen', async () => {
  class NotificationsController extends WebSocketControllerBase {
    static name = 'notifications';
    static events = [{ name: 'subscribe', handler: 'subscribe' }] as const;
    subscribe() {}
  }
  const app = new Application({ appState: TestAppState });
  const listening = app.listen({ port: 0 });

  assert.throws(
    () => app.registerWebSocketController(NotificationsController),
    ApplicationStateError,
  );
  await listening;
  await app.close();
});

test('Application публикует HTTP-контроллер runtime-регистрацией для следующего ingress', async () => {
  class RuntimeController extends HttpControllerBase {
    static prefix = '/runtime';
    static routes = [{ method: 'GET', path: '/', handler: 'status' }] as const;

    status() {
      return { status: 200, body: { source: 'runtime' } };
    }
  }

  const app = new Application({ appState: TestAppState });
  const address = await app.listen({ port: 0 });
  try {
    const before = await fetch(`http://127.0.0.1:${address.port}/runtime/`);
    assert.equal(before.status, 404);

    assert.equal(app.registerRuntimeHttpController(RuntimeController), app);

    const after = await fetch(`http://127.0.0.1:${address.port}/runtime/`);
    assert.equal(after.status, 200);
    assert.deepEqual(await after.json(), { source: 'runtime' });
  } finally {
    await app.close();
  }
});

test('runtime-регистрация открыта только в running и закрывается синхронно', async () => {
  class RuntimeController extends HttpControllerBase {
    static prefix = '/runtime-state';
    static routes = [{ method: 'GET', path: '/', handler: 'status' }] as const;
    status() {
      return { status: 200 };
    }
  }

  let application: Application<any>;
  class HookState {
    beforeAppStart() {
      assert.throws(
        () => application.registerRuntimeHttpController(RuntimeController),
        ApplicationStateError,
      );
    }
    onAppStart() {
      assert.throws(
        () => application.registerRuntimeHttpController(RuntimeController),
        ApplicationStateError,
      );
    }
  }

  application = new Application({ appState: HookState });
  assert.throws(
    () => application.registerRuntimeHttpController(RuntimeController),
    ApplicationStateError,
  );
  await application.listen({ port: 0 });
  await application.close();
  assert.throws(
    () => application.registerRuntimeHttpController(RuntimeController),
    ApplicationStateError,
  );
});

test('Application.close до listen необратимо закрывает приложение', async () => {
  const app = new Application({ appState: TestAppState });
  await app.close();

  assert.throws(() => app.registerHttpController(controller()), ApplicationStateError);
  await assert.rejects(app.listen({ port: 0 }), ApplicationStateError);
});

test('Application.close освобождает ресурсы при ошибке запуска', async () => {
  const occupied = new Application({ appState: TestAppState });
  const address = await occupied.listen({ port: 0 });
  const app = new Application({ appState: TestAppState });
  const listening = app.listen({ port: address.port });
  const closing = app.close();

  await assert.rejects(listening, { code: 'EADDRINUSE' });
  await closing;
  await occupied.close();
  await assert.rejects(app.listen({ port: 0 }), ApplicationStateError);
});

test('Application отклоняет повторную регистрацию того же класса', () => {
  const app = new Application({ appState: TestAppState });
  const UsersController = controller();
  app.registerHttpController(UsersController);

  assert.throws(() => app.registerHttpController(UsersController), DuplicateHttpControllerError);
});

test('HTTP-контроллер обязан напрямую наследовать HttpControllerBase', () => {
  class IndirectBase extends HttpControllerBase {}
  class IndirectController extends IndirectBase {
    static prefix = '/users';
    static routes = [{ method: 'GET', path: '/', handler: 'list' }] as const;
    list() {}
  }

  for (const value of [null, {}, () => {}, UnrelatedController, IndirectController]) {
    assert.throws(
      () => new Application({ appState: TestAppState }).registerHttpController(value as any),
      InvalidHttpControllerError,
    );
  }
});

test('prefix и routes должны быть собственными непустыми метаданными', () => {
  class Parent extends HttpControllerBase {
    static prefix = '/users';
    static routes = [{ method: 'GET', path: '/', handler: 'list' }] as const;
    list() {}
  }

  for (const HttpController of [
    class MissingPrefix extends HttpControllerBase {
      static routes = [{ method: 'GET', path: '/', handler: 'list' }] as const;
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
        new Application({ appState: TestAppState }).registerHttpController(HttpController as any),
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
    static routes = [{ method: 'GET', path: '/', handler: 'list' }] as const;
  }
  class StaticHandler extends HttpControllerBase {
    static prefix = '/users';
    static routes = [{ method: 'GET', path: '/', handler: 'list' }] as const;
    static list() {}
  }

  for (const HttpController of [InheritedHandler, StaticHandler]) {
    assert.throws(
      () =>
        new Application({ appState: TestAppState }).registerHttpController(HttpController as any),
      InvalidHttpControllerError,
    );
  }
});

test('декларация HTTP-маршрута содержит обязательные строковые поля', () => {
  for (const definition of [
    null,
    { method: 'GET', path: '/', handler: 'list', extra: true },
    { method: '', path: '/', handler: 'list' },
    { method: 'GET', path: '', handler: 'list' },
    { method: 'GET', path: '/', handler: '' },
  ]) {
    assert.throws(
      () =>
        new Application({ appState: TestAppState }).registerHttpController(
          controller({ routes: [definition] }),
        ),
      InvalidHttpRouteError,
    );
  }
});

test('декларация HTTP-маршрута отклоняет неизвестные own fields', () => {
  const definition: any = { method: 'GET', path: '/', handler: 'list' };
  Object.defineProperty(definition, 'hidden', { value: true });
  definition[Symbol('unknown')] = true;

  assert.throws(
    () =>
      new Application({ appState: TestAppState }).registerHttpController(
        controller({ routes: [definition] }),
      ),
    InvalidHttpRouteError,
  );
});

test('некорректное percent-кодирование пути отклоняется при регистрации', () => {
  assert.throws(
    () =>
      new Application({ appState: TestAppState }).registerHttpController(
        controller({
          routes: [{ method: 'GET', path: '/%ZZ', handler: 'list' }],
        }),
      ),
    InvalidHttpRouteError,
  );
});

test('некорректный prefix является ошибкой HTTP-контроллера', () => {
  assert.throws(
    () =>
      new Application({ appState: TestAppState }).registerHttpController(
        controller({ prefix: '/..' }),
      ),
    InvalidHttpControllerError,
  );
});

test('регистрация нормализует метод и композицию пути до проверки конфликтов', () => {
  const app = new Application({ appState: TestAppState });
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
  const app = new Application({ appState: TestAppState });
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
  const app = new Application({ appState: TestAppState });
  const UsersController = controller();
  app.registerHttpController(UsersController);
  UsersController.prefix = '/changed';
  UsersController.routes[0].path = '/changed';

  assert.throws(() => app.registerHttpController(controller()), HttpRouteConflictError);
});

test('неуспешная регистрация не изменяет состояние Application', () => {
  const app = new Application({ appState: TestAppState });
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
    assert.throws(
      () => new Application({ appState: TestAppState, jobs } as any),
      InvalidJobOptionsError,
    );
  }
});

test('Application строго проверяет вложенную конфигурацию http', () => {
  const sparseMiddleware = Array(1);
  const extendedMiddleware: any = [() => {}];
  extendedMiddleware.extra = true;
  const symbolMiddleware: any = [() => {}];
  symbolMiddleware[Symbol('extra')] = true;
  for (const http of [
    null,
    [],
    { bodyLimit: -1 },
    { bodyLimit: 1.5 },
    { shutdownTimeout: -1 },
    { onError: true },
    { middleware: null },
    { middleware: [null] },
    { middleware: sparseMiddleware },
    { middleware: extendedMiddleware },
    { middleware: symbolMiddleware },
    { unknown: true },
  ]) {
    assert.throws(
      () => new Application({ appState: TestAppState, http } as any),
      InvalidHttpOptionsError,
    );
  }
});

test('bodyLimit принимает строгие SI и IEC size-строки', () => {
  assert.doesNotThrow(
    () => new Application({ appState: TestAppState, http: { bodyLimit: ' 1KiB ' } } as any),
  );

  for (const bodyLimit of ['1.5KB', '1e3B', '-1B', '1 KB', '1XB', '9007199254740991GiB']) {
    assert.throws(
      () => new Application({ appState: TestAppState, http: { bodyLimit } } as any),
      InvalidHttpOptionsError,
    );
  }
});

test('HTTP-контроллер и HTTP-маршрут строго и атомарно проверяют middleware', () => {
  const invalidController = controller();
  (invalidController as any).middleware = [null];
  const invalidRoute = controller({
    routes: [{ method: 'GET', path: '/', handler: 'list', middleware: [null] }],
  });
  const undefinedController = controller();
  (undefinedController as any).middleware = undefined;
  const undefinedRoute = controller({
    routes: [{ method: 'GET', path: '/', handler: 'list', middleware: undefined }],
  });

  for (const HttpController of [
    invalidController,
    invalidRoute,
    undefinedController,
    undefinedRoute,
  ]) {
    const app = new Application({ appState: TestAppState });
    assert.throws(() => app.registerHttpController(HttpController), TypeError);

    (HttpController as any).middleware = [];
    HttpController.routes[0].middleware = [];
    assert.equal(app.registerHttpController(HttpController), app);
  }
});

test('Application принимает HTTP middleware в конфигурации транспорта', async () => {
  const app = new Application({
    appState: TestAppState,
    http: { middleware: [(() => {}) as any] },
  });

  await app.close();
});

test('Application не раскрывает JobRunner или WorkerPool публичными свойствами', async () => {
  const app = new Application({ appState: TestAppState, jobs: { poolSize: 1, queueSize: 0 } });

  assert.deepEqual(Object.keys(app), []);
  assert.equal('jobRunner' in app, false);
  assert.equal('workerPool' in app, false);
  await app.close();
});

test('Application.close идемпотентно закрывает принадлежащие ресурсы', async () => {
  const app = new Application({ appState: TestAppState });
  const closing = app.close();

  assert.equal(app.close(), closing);
  await closing;
});
