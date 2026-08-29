import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpControllerBase } from '../../lib/framework/HttpControllerBase.ts';
import type { HttpControllerClass } from '../../lib/framework/Application.ts';
import { WebSocketControllerBase } from '../../lib/framework/WebSocketControllerBase.ts';
import type { WebSocketControllerClass } from '../../lib/framework/WebSocketControllerRegistry.ts';

class ValidHttpController extends HttpControllerBase {
  static prefix = '/typed';
  static routes = [{ method: 'GET', path: '/', handler: 'get' }];

  get() {}
}

class MissingHttpPrefix extends HttpControllerBase {
  static routes = [{ method: 'GET', path: '/', handler: 'get' }];

  get() {}
}

class InvalidHttpRoutes extends HttpControllerBase {
  static prefix = '/typed';
  static routes = [{ method: 'GET', path: '/', handler: 42 }];
}

class ValidWebSocketController extends WebSocketControllerBase {
  static name = 'typed';
  static events = [{ name: 'get', handler: 'get' }];

  get() {}
}

class MissingWebSocketEvents extends WebSocketControllerBase {
  static name = 'typed';
}

class InvalidWebSocketEvents extends WebSocketControllerBase {
  static name = 'typed';
  static events = [{ name: 'get', handler: 42 }];
}

const staticContractChecks = {
  validHttp: true satisfies typeof ValidHttpController extends HttpControllerClass ? true : false,
  missingHttpPrefix: false satisfies typeof MissingHttpPrefix extends HttpControllerClass
    ? true
    : false,
  invalidHttpRoutes: false satisfies typeof InvalidHttpRoutes extends HttpControllerClass
    ? true
    : false,
  validWebSocket: true satisfies typeof ValidWebSocketController extends WebSocketControllerClass
    ? true
    : false,
  missingWebSocketEvents:
    false satisfies typeof MissingWebSocketEvents extends WebSocketControllerClass ? true : false,
  invalidWebSocketEvents:
    false satisfies typeof InvalidWebSocketEvents extends WebSocketControllerClass ? true : false,
};

test('TypeScript проверяет статические поля HTTP- и WebSocket-контроллеров', () => {
  assert.deepEqual(staticContractChecks, {
    validHttp: true,
    missingHttpPrefix: false,
    invalidHttpRoutes: false,
    validWebSocket: true,
    missingWebSocketEvents: false,
    invalidWebSocketEvents: false,
  });
});
