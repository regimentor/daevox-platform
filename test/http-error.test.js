import assert from 'node:assert/strict';
import test from 'node:test';

import { HttpError } from '../lib/framework/errors.js';

test('HttpError хранит валидный публичный HTTP-ответ и cause', () => {
  const cause = new Error('source');
  const headers = new Headers({ 'x-error-code': 'INVALID' });
  const error = new HttpError(422, { headers, body: { error: 'Invalid' } }, { cause });

  assert.equal(error.status, 422);
  assert.equal(error.headers, headers);
  assert.deepEqual(error.body, { error: 'Invalid' });
  assert.equal(error.cause, cause);
  assert.ok(error instanceof Error);
});

test('HttpError синхронно отклоняет неверный контракт', () => {
  for (const create of [
    () => new HttpError(399),
    () => new HttpError(600),
    () => new HttpError(422, null),
    () => new HttpError(422, { unknown: true }),
    () => new HttpError(422, { headers: {} }),
    () => new HttpError(422, { headers: new Headers({ connection: 'close' }) }),
    () => new HttpError(422, { body: 1n }),
  ]) {
    assert.throws(create, TypeError);
  }
});
