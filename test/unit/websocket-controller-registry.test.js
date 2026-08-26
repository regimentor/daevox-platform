import assert from 'node:assert/strict';
import test from 'node:test';

import { Application } from '../../lib/framework/Application.js';
import { WebSocketControllerBase } from '../../lib/framework/WebSocketControllerBase.js';
import {
  DuplicateWebSocketControllerError,
  InvalidWebSocketControllerError,
  WebSocketControllerConflictError,
  InvalidWebSocketOptionsError,
} from '../../lib/framework/errors.js';

function noop() {}

function eventController(event, prototype = {}) {
  class EventsController extends WebSocketControllerBase {
    static name = 'events';
    static events = [event];
  }
  Object.defineProperties(EventsController.prototype, Object.getOwnPropertyDescriptors(prototype));
  return EventsController;
}

test('Application регистрирует декларативный WebSocket-контроллер', async () => {
  class NotificationsController extends WebSocketControllerBase {
    static name = 'notifications';
    static events = [{ name: 'subscribe', handler: 'subscribe' }];

    subscribe() {}
  }

  const app = new Application();
  assert.equal(app.registerWebSocketController(NotificationsController), app);
  await app.close();
});

test('WebSocket-контроллер строго проверяет собственные name и events', () => {
  class Parent extends WebSocketControllerBase {
    static name = 'parent';
    static events = [{ name: 'event', handler: 'handle' }];
    handle() {}
  }

  for (const Controller of [
    class MissingName extends WebSocketControllerBase {
      static events = [{ name: 'event', handler: 'handle' }];
      handle() {}
    },
    class InvalidName extends WebSocketControllerBase {
      static name = 'invalid.name';
      static events = [{ name: 'event', handler: 'handle' }];
      handle() {}
    },
    class MissingEvents extends WebSocketControllerBase {
      static name = 'missing-events';
    },
    class EmptyEvents extends WebSocketControllerBase {
      static name = 'empty-events';
      static events = [];
    },
    class InheritedMetadata extends Parent {},
  ]) {
    assert.throws(
      () => new Application().registerWebSocketController(Controller),
      InvalidWebSocketControllerError,
    );
  }
});

test('WebSocket-событие имеет точную форму и собственный handler', () => {
  const handle = { handle() {} };
  const symbolField = { name: 'valid', handler: 'handle' };
  symbolField[Symbol('extra')] = true;

  for (const Controller of [
    eventController(null, handle),
    eventController({ name: 'valid', handler: 'handle', extra: true }, handle),
    eventController(symbolField, handle),
    eventController({ name: 'invalid.name', handler: 'handle' }, handle),
    eventController({ name: 'valid', handler: '' }, handle),
    eventController({ name: 'valid', handler: 'missing' }, handle),
  ]) {
    assert.throws(
      () => new Application().registerWebSocketController(Controller),
      InvalidWebSocketControllerError,
    );
  }
});

test('WebSocket-контроллер и событие строго и атомарно проверяют middleware', async () => {
  class MiddlewareController extends WebSocketControllerBase {
    static name = 'middleware';
    static middleware = [null];
    static events = [{ name: 'run', handler: 'run', middleware: [null] }];
    run() {}
  }
  const app = new Application();

  assert.throws(
    () => app.registerWebSocketController(MiddlewareController),
    InvalidWebSocketControllerError,
  );
  MiddlewareController.middleware = [];
  MiddlewareController.events[0].middleware = [];
  assert.equal(app.registerWebSocketController(MiddlewareController), app);
  await app.close();

  for (const Controller of [
    class UndefinedControllerMiddleware extends WebSocketControllerBase {
      static name = 'undefined-controller-middleware';
      static middleware = undefined;
      static events = [{ name: 'run', handler: 'run' }];
      run() {}
    },
    class UndefinedEventMiddleware extends WebSocketControllerBase {
      static name = 'undefined-event-middleware';
      static events = [{ name: 'run', handler: 'run', middleware: undefined }];
      run() {}
    },
  ]) {
    assert.throws(
      () => new Application().registerWebSocketController(Controller),
      InvalidWebSocketControllerError,
    );
  }
});

test('регистрация отклоняет повторные классы, имена и события атомарно', () => {
  class FirstController extends WebSocketControllerBase {
    static name = 'shared';
    static events = [{ name: 'first', handler: 'first' }];
    first() {}
  }
  class ConflictingController extends WebSocketControllerBase {
    static name = 'shared';
    static events = [{ name: 'second', handler: 'second' }];
    second() {}
  }
  class DuplicateEventController extends WebSocketControllerBase {
    static name = 'duplicate-events';
    static events = [
      { name: 'same', handler: 'first' },
      { name: 'same', handler: 'second' },
    ];
    first() {}
    second() {}
  }

  const app = new Application();
  app.registerWebSocketController(FirstController);
  assert.throws(
    () => app.registerWebSocketController(FirstController),
    DuplicateWebSocketControllerError,
  );
  assert.throws(
    () => app.registerWebSocketController(ConflictingController),
    WebSocketControllerConflictError,
  );
  assert.throws(
    () => app.registerWebSocketController(DuplicateEventController),
    InvalidWebSocketControllerError,
  );

  DuplicateEventController.events = [{ name: 'same', handler: 'first' }];
  assert.equal(app.registerWebSocketController(DuplicateEventController), app);
});

test('Application строго проверяет конфигурацию единого WebSocket endpoint', async () => {
  const app = new Application({
    websocket: {
      path: '/socket',
      maxPayload: 0,
      middleware: [noop],
      onConnect: noop,
      onDisconnect: noop,
      onError: noop,
    },
  });
  await app.close();

  const sparseMiddleware = Array(1);
  const extendedMiddleware = [noop];
  extendedMiddleware.extra = true;
  const symbolMiddleware = [noop];
  symbolMiddleware[Symbol('extra')] = true;
  for (const websocket of [
    null,
    [],
    { path: 'relative' },
    { path: '/..' },
    { maxPayload: -1 },
    { maxPayload: 1.5 },
    { maxPayload: Number.POSITIVE_INFINITY },
    { onConnect: true },
    { onDisconnect: true },
    { onError: true },
    { middleware: null },
    { middleware: [null] },
    { middleware: sparseMiddleware },
    { middleware: extendedMiddleware },
    { middleware: symbolMiddleware },
    { connectionMiddleware: [] },
    { unknown: true },
  ]) {
    assert.throws(() => new Application({ websocket }), InvalidWebSocketOptionsError);
  }
});
