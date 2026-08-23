import assert from 'node:assert/strict';
import test from 'node:test';

import { HttpControllerBase } from '../lib/framework/HttpControllerBase.js';
import { InvalidHttpControllerError } from '../lib/framework/errors.js';

test('HttpControllerBase нельзя создать напрямую', () => {
  assert.throws(() => new HttpControllerBase(), InvalidHttpControllerError);
});

test('прямого наследника HttpControllerBase можно создать', () => {
  class UsersController extends HttpControllerBase {}

  assert.ok(new UsersController() instanceof HttpControllerBase);
});
