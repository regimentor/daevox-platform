import assert from 'node:assert/strict';
import test from 'node:test';

import { WebSocketControllerBase } from '../../lib/framework/WebSocketControllerBase.js';
import { InvalidWebSocketControllerError } from '../../lib/framework/errors.js';

test('WebSocketControllerBase нельзя создать напрямую', () => {
  assert.throws(() => new WebSocketControllerBase(), InvalidWebSocketControllerError);
});

test('WebSocketControllerBase предоставляет зависимости прямому наследнику', () => {
  class EventsController extends WebSocketControllerBase {}
  const jobRunner = {};
  const events = { push() {} };
  const controller = new EventsController({ jobRunner, events });

  assert.equal(controller.jobRunner, jobRunner);
  assert.equal(controller.events, events);
  assert.deepEqual(Object.keys(controller), ['jobRunner', 'events']);
  assert.equal('clientSessions' in controller, false);
});

test('WebSocketControllerBase строго проверяет options', () => {
  class EventsController extends WebSocketControllerBase {}
  const options = { jobRunner: {}, events: {} };
  for (const value of [undefined, null, {}, { jobRunner: {} }, { ...options, extra: true }]) {
    assert.throws(() => new EventsController(value), InvalidWebSocketControllerError);
  }
});
