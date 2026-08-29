import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InvalidWebSocketSendError,
  WebSocketClientNotFoundError,
  WebSocketProtocolError,
} from '../../src/errors.ts';
import { WebSocketSender } from '../../src/WebSocketSender.ts';
import { WebSocketSessionStore } from '../../src/WebSocketSessionStore.ts';

const message = {
  controller: 'notifications',
  event: 'published',
  body: { id: 42 },
};

function senderWithSessions() {
  const delivered: any[] = [];
  const sessionStore = new WebSocketSessionStore();
  sessionStore.add(
    'client-1',
    {
      send(encoded: any) {
        delivered.push(JSON.parse(encoded));
        return true;
      },
    },
    'open',
  );
  sessionStore.add('client-1', { send: () => false }, 'closed');
  return { delivered, sender: new WebSocketSender(sessionStore, 1_024) };
}

test('WebSocketSender отправляет всем сессиям и учитывает закрытое соединение', () => {
  const { delivered, sender } = senderWithSessions();

  assert.deepEqual(sender.send({ clientId: 'client-1' }, message), { sent: 1, skipped: 1 });
  assert.deepEqual(delivered, [message]);
});

test('WebSocketSender отправляет выбранным сессиям и считает отсутствующие', () => {
  const { delivered, sender } = senderWithSessions();

  assert.deepEqual(
    sender.send({ clientId: 'client-1', sessionIds: ['open', 'missing', 'missing'] }, message),
    { sent: 1, skipped: 1 },
  );
  assert.deepEqual(delivered, [message]);
});

test('WebSocketSender отклоняет несуществующего клиента', () => {
  const sender = new WebSocketSender(new WebSocketSessionStore(), 1_024);

  assert.throws(() => sender.send({ clientId: 'missing' }, message), WebSocketClientNotFoundError);
});

test('WebSocketSender строго проверяет target', () => {
  const { sender } = senderWithSessions();
  const invalidTargets = [
    null,
    'client-1',
    [],
    {},
    { clientId: 42 },
    { clientId: '' },
    { clientId: 'client-1', extra: true },
    { clientId: 'client-1', sessionIds: 'open' },
    { clientId: 'client-1', sessionIds: [42] },
    { clientId: 'client-1', sessionIds: [''] },
  ];

  for (const target of invalidTargets) {
    assert.throws(() => sender.send(target as any, message), InvalidWebSocketSendError);
  }
});

test('WebSocketSender строго проверяет envelope сообщения', () => {
  const { sender } = senderWithSessions();
  const invalidMessages = [
    null,
    'message',
    [],
    {},
    { controller: 'notifications', event: 'published' },
    { controller: 'notifications', body: {} },
    { event: 'published', body: {} },
    { ...message, extra: true },
  ];

  for (const invalidMessage of invalidMessages) {
    assert.throws(
      () => sender.send({ clientId: 'client-1' }, invalidMessage as any),
      InvalidWebSocketSendError,
    );
  }
});

test('WebSocketSender преобразует ошибку протокола в ошибку публичного API', () => {
  const { sender } = senderWithSessions();

  assert.throws(
    () => sender.send({ clientId: 'client-1' }, { ...message, controller: 'invalid name' }),
    (error: any) =>
      error instanceof InvalidWebSocketSendError && error.cause instanceof WebSocketProtocolError,
  );
});

test('WebSocketSender не скрывает неожиданную ошибку кодирования', () => {
  const { sender } = senderWithSessions();
  const failure = new Error('unexpected getter failure');
  const brokenMessage = new Proxy(message, {
    get(target: any, property: any, receiver: any) {
      if (property === 'controller') throw failure;
      return Reflect.get(target, property, receiver);
    },
  });

  assert.throws(() => sender.send({ clientId: 'client-1' }, brokenMessage), failure);
});
