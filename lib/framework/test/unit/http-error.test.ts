import assert from 'node:assert/strict';
import test from 'node:test';

import { HttpError, HttpRequestBodyError } from '../../src/errors.ts';

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
    () => new HttpError(422, null as any),
    () => new HttpError(422, { unknown: true } as any),
    () => new HttpError(422, { headers: {} } as any),
    () => new HttpError(422, { headers: new Headers({ connection: 'close' }) }),
    () => new HttpError(422, { body: 1n }),
  ]) {
    assert.throws(create, TypeError);
  }
});

test('HttpRequestBodyError связывает публичный code со status и cause', () => {
  const cause = new Error('parser detail');
  const malformed = new HttpRequestBodyError('MALFORMED_BODY', { cause });
  const unsupported = new HttpRequestBodyError('UNSUPPORTED_MEDIA_TYPE');

  assert.equal(malformed.status, 400);
  assert.equal(malformed.cause, cause);
  assert.equal(unsupported.status, 415);
  assert.throws(() => new HttpRequestBodyError('OTHER' as any), TypeError);
});
