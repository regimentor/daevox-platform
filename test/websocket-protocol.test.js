import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeWebSocketMessage,
  encodeWebSocketMessage,
} from '../lib/framework/webSocketProtocol.js';
import { WebSocketProtocolError } from '../lib/framework/errors.js';

test('daevox.v1 декодирует точный JSON-envelope', () => {
  const message = decodeWebSocketMessage(
    '{"controller":"notifications","event":"subscribe","body":{"topics":["news"]}}',
  );

  assert.deepEqual(message, {
    controller: 'notifications',
    event: 'subscribe',
    body: { topics: ['news'] },
  });
});

test('неадресуемое сообщение создаёт фатальную INVALID_MESSAGE', () => {
  for (const text of [
    '{',
    'null',
    '[]',
    '{"controller":"bad.name","event":"event","body":{}}',
    '{"controller":"known","event":1,"body":{}}',
  ]) {
    assert.throws(
      () => decodeWebSocketMessage(text),
      (error) =>
        error instanceof WebSocketProtocolError &&
        error.code === 'INVALID_MESSAGE' &&
        error.fatal === true,
    );
  }
});

test('адресуемое нарушение envelope создаёт восстанавливаемую INVALID_MESSAGE', () => {
  for (const text of [
    '{"controller":"known","event":"event"}',
    '{"controller":"known","event":"event","body":null}',
    '{"controller":"known","event":"event","body":[]}',
    '{"controller":"known","event":"event","body":{},"extra":true}',
  ]) {
    assert.throws(
      () => decodeWebSocketMessage(text),
      (error) =>
        error instanceof WebSocketProtocolError &&
        error.code === 'INVALID_MESSAGE' &&
        error.fatal === false &&
        error.controller === 'known' &&
        error.event === 'event',
    );
  }
});

test('daevox.v1 сериализует JSON-совместимый ответ без преобразования адреса', () => {
  assert.equal(
    encodeWebSocketMessage('notifications', 'subscribe', {
      subscribed: true,
      count: 2,
      values: [null, 'news'],
    }),
    '{"controller":"notifications","event":"subscribe","body":{"subscribed":true,"count":2,"values":[null,"news"]}}',
  );
});

test('ответ отклоняет значения, которые JSON преобразовал бы или потерял', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const sparse = [];
  sparse[1] = 'value';
  const accessor = {};
  Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 'hidden' });
  const hidden = {};
  Object.defineProperty(hidden, 'value', { value: 'hidden' });
  const symbolKey = { value: true };
  symbolKey[Symbol('hidden')] = true;

  for (const body of [
    null,
    [],
    { value: undefined },
    { value: Number.NaN },
    { value: Number.POSITIVE_INFINITY },
    { value: 1n },
    { value() {} },
    { value: Symbol('value') },
    { value: new Date() },
    { value: sparse },
    cyclic,
    accessor,
    hidden,
    symbolKey,
    { error: { code: 'USER_ERROR' } },
    { toJSON: () => ({ changed: true }) },
  ]) {
    assert.throws(
      () => encodeWebSocketMessage('known', 'event', body),
      (error) => error instanceof WebSocketProtocolError && error.code === 'INVALID_RESPONSE',
    );
  }
});

test('лимит исходящего сообщения измеряется в UTF-8 байтах', () => {
  assert.throws(
    () => encodeWebSocketMessage('known', 'event', { value: '🙂' }, 61),
    (error) => error instanceof WebSocketProtocolError && error.code === 'INVALID_RESPONSE',
  );
  assert.equal(
    Buffer.byteLength(encodeWebSocketMessage('known', 'event', { value: '🙂' }, 62)),
    62,
  );
});
