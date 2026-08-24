import assert from 'node:assert/strict';
import test from 'node:test';

import { HttpControllerBase } from '../../lib/framework/HttpControllerBase.js';
import { InvalidHttpControllerError } from '../../lib/framework/errors.js';

test('HttpControllerBase нельзя создать напрямую', () => {
  assert.throws(() => new HttpControllerBase(), InvalidHttpControllerError);
});

test('прямого наследника HttpControllerBase можно создать', () => {
  class UsersController extends HttpControllerBase {}
  const jobRunner = { run() {}, close() {} };

  const controller = new UsersController({ jobRunner });

  assert.ok(controller instanceof HttpControllerBase);
  assert.equal(controller.jobRunner, jobRunner);
  assert.throws(() => {
    controller.jobRunner = undefined;
  }, TypeError);
});

test('HttpControllerBase принимает объект ровно с jobRunner', () => {
  class UsersController extends HttpControllerBase {}
  const jobRunner = { run() {}, close() {} };

  for (const options of [undefined, null, {}, { jobRunner, extra: true }]) {
    assert.throws(() => new UsersController(options), InvalidHttpControllerError);
  }
});
