import assert from 'node:assert/strict';
import test from 'node:test';

import { WebSocketEventError } from '../../lib/framework/errors.ts';

test('WebSocketEventError хранит публичный прикладной код', () => {
  const error = new WebSocketEventError('PERMISSION_DENIED');

  assert.equal(error.code, 'PERMISSION_DENIED');
  assert.ok(error instanceof Error);
});

test('WebSocketEventError синхронно отклоняет неверные и зарезервированные коды', () => {
  for (const code of [
    undefined,
    '',
    'permission_denied',
    '1_PERMISSION',
    'PERMISSION-DENIED',
    'INVALID_MESSAGE',
    'UNKNOWN_CONTROLLER',
    'UNKNOWN_EVENT',
    'HANDLER_ERROR',
    'INVALID_RESPONSE',
  ]) {
    assert.throws(() => new WebSocketEventError(code), TypeError);
  }
});
