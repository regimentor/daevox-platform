import assert from 'node:assert/strict';
import test from 'node:test';

import { HttpControllerBase } from '../../lib/framework/HttpControllerBase.ts';
import { InvalidHttpControllerError } from '../../lib/framework/errors.ts';

test('HttpControllerBase нельзя создать напрямую', () => {
  assert.throws(() => new HttpControllerBase(), InvalidHttpControllerError);
});

test('прямого наследника HttpControllerBase можно создать', () => {
  class UsersController extends HttpControllerBase {}
  const jobRunner = { run() {}, close() {} };
  const websocket = { send() {} };
  const events = { push() {} };

  const controller = new UsersController({ jobRunner, websocket, events } as any);

  assert.ok(controller instanceof HttpControllerBase);
  assert.equal(controller.jobRunner, jobRunner);
  assert.equal(controller.websocket, websocket);
  assert.equal(controller.events, events);
  assert.deepEqual(Object.keys(controller), ['jobRunner', 'websocket', 'events']);
  assert.throws(() => {
    (controller as any).jobRunner = undefined;
  }, TypeError);
});

test('HttpControllerBase принимает объект ровно с jobRunner', () => {
  class UsersController extends HttpControllerBase {}
  const jobRunner = { run() {}, close() {} };
  const websocket = { send() {} };
  const events = { push() {} };

  for (const options of [
    undefined,
    null,
    {},
    { jobRunner },
    { jobRunner, websocket },
    { jobRunner, websocket, events, extra: true },
  ]) {
    assert.throws(() => new UsersController(options as any), InvalidHttpControllerError);
  }
});
