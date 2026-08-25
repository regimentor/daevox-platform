import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  InvalidWebSocketPushError,
  WebSocketPushPayloadTooLargeError,
} from '../../lib/framework/errors.js';
import { createWebSocketRequestSender } from '../../lib/framework/webSocketRequestSender.js';
import { WebSocketConnection } from '../../lib/framework/WebSocketTransport.js';

class BackpressuredSocket extends EventEmitter {
  writable = true;
  closes = [];
  writes = [];

  write(data) {
    this.writes.push(Buffer.from(data));
    return false;
  }

  end(data) {
    this.closes.push(Buffer.from(data));
    this.writable = false;
  }
}

test('WebSocket sender отклоняет invalid envelope до membership lookup', () => {
  let membershipLookups = 0;
  const sender = createWebSocketRequestSender(
    'auth-session-1',
    {
      connectionsForAuthSession() {
        membershipLookups += 1;
        return Object.freeze([{ send: () => true }]);
      },
    },
    1024,
  );

  const inheritedEnvelope = Object.assign(new Date(), {
    controller: 'notifications',
    event: 'changed',
    body: {},
  });
  const cyclicBody = {};
  cyclicBody.self = cyclicBody;
  const envelopes = [
    null,
    [],
    { controller: 'notifications', event: 'changed' },
    {
      controller: 'notifications',
      event: 'changed',
      body: { resourceId: 'resource-1' },
      authSessionId: 'another-session',
    },
    { controller: 'notifications!', event: 'changed', body: {} },
    { controller: 'notifications', event: 'changed', body: [] },
    { controller: 'notifications', event: 'changed', body: { error: {} } },
    { controller: 'notifications', event: 'changed', body: cyclicBody },
    inheritedEnvelope,
  ];

  for (const envelope of envelopes) {
    assert.throws(() => sender.send(envelope), InvalidWebSocketPushError);
  }
  assert.equal(membershipLookups, 0);
});

test('WebSocket sender отклоняет oversized envelope до membership lookup', () => {
  let membershipLookups = 0;
  const sender = createWebSocketRequestSender(
    'auth-session-1',
    {
      connectionsForAuthSession() {
        membershipLookups += 1;
        return Object.freeze([{ send: () => true }]);
      },
    },
    64,
  );

  assert.throws(
    () =>
      sender.send({
        controller: 'notifications',
        event: 'changed',
        body: { value: 'x'.repeat(64) },
      }),
    WebSocketPushPayloadTooLargeError,
  );
  assert.equal(membershipLookups, 0);
});

test('WebSocket sender ставит один serialized envelope в snapshot текущей AuthSession', () => {
  const sent = [];
  const lookups = [];
  const connections = [
    { send: (text) => (sent.push({ connection: 'first', text }), true) },
    { send: (text) => (sent.push({ connection: 'closing', text }), false) },
    { send: (text) => (sent.push({ connection: 'second', text }), true) },
  ];
  const sender = createWebSocketRequestSender(
    'auth-session-1',
    {
      connectionsForAuthSession(authSessionId) {
        lookups.push(authSessionId);
        return Object.freeze([...connections]);
      },
    },
    1024,
  );
  const envelope = {
    controller: 'notifications',
    event: 'changed',
    body: { resourceId: 'resource-1' },
  };

  const result = sender.send(envelope);

  assert.deepEqual(lookups, ['auth-session-1']);
  assert.deepEqual(result, { matched: 3, queued: 2, dropped: 1 });
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(
    sent.map(({ text }) => text),
    Array(3).fill(
      '{"controller":"notifications","event":"changed","body":{"resourceId":"resource-1"}}',
    ),
  );
});

test('WebSocket sender считает queue overflow как dropped enqueue', () => {
  const socket = new BackpressuredSocket();
  const slowConnection = new WebSocketConnection(socket, {
    maxPayload: 1024,
    maxWriteQueueBytes: 3,
    onClose() {},
    onMessage() {},
    onProtocolError() {},
  });
  slowConnection.send('a');
  const sender = createWebSocketRequestSender(
    'auth-session-1',
    {
      connectionsForAuthSession: () => Object.freeze([{ send: () => true }, slowConnection]),
    },
    1024,
  );

  const result = sender.send({ controller: 'events', event: 'changed', body: {} });

  assert.deepEqual(result, { matched: 2, queued: 1, dropped: 1 });
  assert.equal(socket.closes.length, 1);
  assert.equal(socket.closes[0].readUInt16BE(2), 1013);
  assert.equal(socket.closes[0].subarray(4).toString(), 'Write queue overflow');
});

test('WebSocket sender безопасно завершает snapshot при concurrent close', () => {
  let closing = false;
  const second = { send: () => !closing };
  const sender = createWebSocketRequestSender(
    'auth-session-1',
    {
      connectionsForAuthSession: () =>
        Object.freeze([
          {
            send() {
              closing = true;
              return true;
            },
          },
          second,
        ]),
    },
    1024,
  );

  assert.deepEqual(sender.send({ controller: 'events', event: 'changed', body: {} }), {
    matched: 2,
    queued: 1,
    dropped: 1,
  });
});
