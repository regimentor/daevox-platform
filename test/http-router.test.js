import assert from 'node:assert/strict';
import test from 'node:test';

import { HttpRouter } from '../lib/framework/HttpRouter.js';
import {
  HttpRouteConflictError,
  InvalidHttpPathEncodingError,
  InvalidHttpRouteError,
} from '../lib/framework/errors.js';

class UsersController {
  list() {}
}

function route(overrides = {}) {
  return Object.freeze({
    method: 'GET',
    path: '/users',
    handler: 'list',
    controller: UsersController,
    ...overrides,
  });
}

test('HttpRouter регистрирует и сопоставляет статический HTTP-маршрут', () => {
  const router = new HttpRouter();
  const definition = route();

  assert.equal(router.registerAll([definition]), undefined);
  assert.deepEqual(router.match('GET', '/users'), {
    route: definition,
    params: {},
  });
  assert.equal(router.match('POST', '/users'), null);
});

test('HttpRouter сохраняет замороженное определение HTTP-маршрута', () => {
  const router = new HttpRouter();
  const mutableDefinition = {
    method: 'GET',
    path: '/users',
    handler: 'list',
    controller: UsersController,
  };
  router.registerAll([mutableDefinition]);
  mutableDefinition.path = '/changed';

  const match = router.match('GET', '/users');
  assert.ok(Object.isFrozen(match.route));
  assert.equal(match.route.path, '/users');
});

test('HttpRouter извлекает декодированные параметры в новый замороженный объект', () => {
  const router = new HttpRouter();
  const definition = route({ path: '/users/:id', handler: 'getById' });
  router.registerAll([definition]);

  const first = router.match('get', '/users/hello%20world');
  const second = router.match('GET', '/users/hello%20world');

  assert.deepEqual(first, {
    route: definition,
    params: { id: 'hello world' },
  });
  assert.ok(Object.isFrozen(first.params));
  assert.notEqual(first.params, second.params);
});

test('статический HTTP-маршрут выигрывает независимо от порядка регистрации', () => {
  const dynamic = route({ path: '/users/:id', handler: 'getById' });
  const staticRoute = route({ path: '/users/me', handler: 'current' });

  for (const definitions of [
    [dynamic, staticRoute],
    [staticRoute, dynamic],
  ]) {
    const router = new HttpRouter();
    router.registerAll(definitions);
    assert.equal(router.match('GET', '/users/me').route, staticRoute);
  }
});

test('приоритет определяется первым различающимся сегментом слева', () => {
  const earlierStatic = route({ path: '/files/static/:name' });
  const laterStatic = route({ path: '/files/:folder/readme' });
  const router = new HttpRouter();
  router.registerAll([laterStatic, earlierStatic]);

  assert.equal(router.match('GET', '/files/static/readme').route, earlierStatic);
});

test('pathname нормализует повторные и завершающие слэши', () => {
  const router = new HttpRouter();
  const definition = route({ path: '/users/:id' });
  router.registerAll([definition]);

  assert.equal(router.match('GET', '//users//42///').route, definition);
});

test('encoded slash остаётся частью одного сегмента', () => {
  const router = new HttpRouter();
  const definition = route({ path: '/value%2Fpart' });
  router.registerAll([definition]);

  assert.equal(router.match('GET', '/value%2fpart').route, definition);
  assert.equal(router.match('GET', '/value/part'), null);
});

test('одинаковая структура динамических шаблонов конфликтует атомарно', () => {
  const router = new HttpRouter();
  const existing = route({ path: '/health' });
  router.registerAll([existing]);

  assert.throws(
    () => router.registerAll([route({ path: '/users/:id' }), route({ path: '/users/:userId' })]),
    HttpRouteConflictError,
  );
  assert.equal(router.match('GET', '/users/42'), null);
  assert.equal(router.match('GET', '/health').route, existing);
});

test('один шаблон разрешён для разных HTTP-методов', () => {
  const router = new HttpRouter();
  const getRoute = route({ path: '/users/:id' });
  const deleteRoute = route({ method: 'DELETE', path: '/users/:userId' });
  router.registerAll([getRoute, deleteRoute]);

  assert.equal(router.match('GET', '/users/1').route, getRoute);
  assert.equal(router.match('DELETE', '/users/1').route, deleteRoute);
  assert.equal(router.match('HEAD', '/users/1'), null);
});

test('HttpRouter отклоняет неверную пачку до изменения каталога', () => {
  const router = new HttpRouter();

  assert.throws(
    () => router.registerAll([route(), route({ method: 'not valid' })]),
    InvalidHttpRouteError,
  );
  assert.equal(router.match('GET', '/users'), null);
});

test('HttpRouter отклоняет разреженную пачку как неверный HTTP-маршрут', () => {
  const router = new HttpRouter();
  const routes = [];
  routes.length = 1;

  assert.throws(() => router.registerAll(routes), InvalidHttpRouteError);
  assert.equal(router.match('GET', '/users'), null);
});

test('HttpRouter отклоняет неверные аргументы и pathname', () => {
  const router = new HttpRouter();

  for (const definitions of [
    null,
    [],
    [null],
    [route({ path: '/users/:bad-name' })],
    [route({ path: '/users/:id/:id' })],
    [route({ path: '/users/file-:id' })],
    [route({ path: '/users/*' })],
    [route({ path: '/users/.' })],
    [route({ path: '/users?active' })],
  ]) {
    assert.throws(() => router.registerAll(definitions), InvalidHttpRouteError);
  }

  for (const args of [
    [null, '/'],
    ['not valid', '/'],
    ['GET', 'users'],
    ['GET', '/users?active'],
  ]) {
    assert.throws(() => router.match(...args), InvalidHttpRouteError);
  }
});

test('некорректное percent-кодирование pathname имеет отдельный класс ошибки', () => {
  const router = new HttpRouter();

  assert.throws(() => router.match('GET', '/users/%ZZ'), InvalidHttpPathEncodingError);
});
