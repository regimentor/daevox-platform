import assert from 'node:assert/strict';
import test from 'node:test';

import { Application } from '../../lib/framework/Application.js';
import { createAuthentication } from '../../lib/framework/Authentication.js';
import { WebSocketControllerBase } from '../../lib/framework/WebSocketControllerBase.js';
import {
  DuplicateWebSocketControllerError,
  InvalidAuthenticationOptionsError,
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

  const app = new Application({ websocket: { authentication: false } });
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
      () =>
        new Application({ websocket: { authentication: false } }).registerWebSocketController(
          Controller,
        ),
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
      () =>
        new Application({ websocket: { authentication: false } }).registerWebSocketController(
          Controller,
        ),
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

  const app = new Application({ websocket: { authentication: false } });
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
      authentication: false,
      allowedOrigins: ['https://app.example.com'],
      path: '/socket',
      maxPayload: 0,
      maxWriteQueueBytes: 0,
      onConnect: noop,
      onDisconnect: noop,
      onError: noop,
    },
  });
  await app.close();

  const explicitLimit = new Application({
    websocket: {
      authentication: false,
      maxPayload: Number.MAX_SAFE_INTEGER,
      maxWriteQueueBytes: 0,
    },
  });
  await explicitLimit.close();

  for (const websocket of [
    { authentication: true },
    { authentication: 'invalid scenario' },
    { authentication: false, allowedOrigins: null },
    { authentication: false, allowedOrigins: ['https://app.example.com/'] },
    { authentication: false, allowedOrigins: ['ws://app.example.com'] },
    { authentication: false, allowedOrigins: ['null'] },
    { authentication: false, allowedOrigins: Array(1) },
    {
      authentication: false,
      allowedOrigins: ['https://app.example.com', 'https://app.example.com'],
    },
    { path: 'relative' },
    { path: '/..' },
    { maxPayload: -1 },
    { maxPayload: 1.5 },
    { maxPayload: Number.POSITIVE_INFINITY },
    { maxPayload: Number.MAX_SAFE_INTEGER },
    { maxWriteQueueBytes: -1 },
    { maxWriteQueueBytes: null },
    { maxWriteQueueBytes: undefined },
    { maxWriteQueueBytes: 1.5 },
    { maxWriteQueueBytes: Number.POSITIVE_INFINITY },
    { maxWriteQueueBytes: Number.MAX_SAFE_INTEGER + 1 },
    { onConnect: true },
    { onDisconnect: true },
    { onError: true },
    { unknown: true },
  ]) {
    assert.throws(
      () => new Application({ websocket: { authentication: false, ...websocket } }),
      InvalidWebSocketOptionsError,
    );
  }

  for (const websocket of [undefined, null, [], {}]) {
    assert.throws(() => new Application({ websocket }), InvalidWebSocketOptionsError);
  }
  assert.throws(
    () =>
      new Application({
        websocket: { authentication: false },
        unknown: true,
      }),
    InvalidWebSocketOptionsError,
  );

  let accessorWasRead = false;
  const websocketAccessor = {};
  Object.defineProperty(websocketAccessor, 'authentication', {
    enumerable: true,
    get() {
      accessorWasRead = true;
      return false;
    },
  });
  assert.throws(
    () => new Application({ websocket: websocketAccessor }),
    InvalidWebSocketOptionsError,
  );
  assert.equal(accessorWasRead, false);

  const authentication = createAuthentication({
    strategies: { session: { authenticate: () => ({ status: 'abstain' }) } },
    scenarios: { browser: { use: ['session'], required: true } },
  });
  const authenticated = new Application({
    authentication,
    websocket: { authentication: 'browser' },
  });
  await authenticated.close();
  assert.throws(
    () => new Application({ websocket: { authentication: 'browser' } }),
    InvalidAuthenticationOptionsError,
  );
});
