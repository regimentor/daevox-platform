import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import test from 'node:test';

import { Application } from '../../lib/framework/Application.js';
import { createAuthentication } from '../../lib/framework/Authentication.js';
import { WebSocketControllerBase } from '../../lib/framework/WebSocketControllerBase.js';
import { WebSocketProtocolError } from '../../lib/framework/errors.js';
import { WebSocketTransport } from '../../lib/framework/WebSocketTransport.js';

function opened(url, protocol = 'daevox.v1') {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocol);
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
}

function rejected(url, protocol) {
  return new Promise((resolve) => {
    const socket = protocol === undefined ? new WebSocket(url) : new WebSocket(url, protocol);
    socket.addEventListener('open', () => resolve(false), { once: true });
    socket.addEventListener('error', () => resolve(true), { once: true });
  });
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket message timeout')), 1_000);
    socket.addEventListener(
      'message',
      (event) => {
        clearTimeout(timer);
        resolve(event.data);
      },
      { once: true },
    );
  });
}

function closed(socket) {
  return new Promise((resolve) => {
    socket.addEventListener(
      'close',
      (event) => resolve({ code: event.code, reason: event.reason }),
      { once: true },
    );
  });
}

function nextMessages(socket, count) {
  return new Promise((resolve) => {
    const messages = [];
    const listener = (event) => {
      messages.push(event.data);
      if (messages.length === count) {
        socket.removeEventListener('message', listener);
        resolve(messages);
      }
    };
    socket.addEventListener('message', listener);
  });
}

function rawRequest(address, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(address.port, address.address, () => socket.write(request));
    socket.once('data', (data) => resolve({ data, socket }));
    socket.once('error', reject);
  });
}

function rawHandshake(address, { path = '/websocket', headers = {} } = {}) {
  const additionalHeaders = Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join('');
  return rawRequest(
    address,
    `GET ${path} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: daevox.v1\r\n${additionalHeaders}\r\n`,
  );
}

async function rawWebSocket(address) {
  const { data, socket } = await rawRequest(
    address,
    `GET /websocket HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: daevox.v1\r\n\r\n`,
  );
  assert.match(data.toString(), /^HTTP\/1\.1 101 Switching Protocols/);
  return socket;
}

function maskedTextFrame(payload) {
  const mask = Buffer.from([1, 2, 3, 4]);
  const bytes = Buffer.from(payload);
  const header = Buffer.alloc(bytes.byteLength < 126 ? 2 : 4);
  header[0] = 0x81;
  if (bytes.byteLength < 126) header[1] = 0x80 | bytes.byteLength;
  else {
    header[1] = 0xfe;
    header.writeUInt16BE(bytes.byteLength, 2);
  }
  for (let index = 0; index < bytes.byteLength; index += 1) bytes[index] ^= mask[index % 4];
  return Buffer.concat([header, mask, bytes]);
}

function maskedControlFrame(opcode, payload) {
  const mask = Buffer.from([1, 2, 3, 4]);
  const bytes = Buffer.from(payload);
  const header = Buffer.from([0x80 | opcode, 0x80 | bytes.byteLength]);
  for (let index = 0; index < bytes.byteLength; index += 1) bytes[index] ^= mask[index % 4];
  return Buffer.concat([header, mask, bytes]);
}

function maskedFragment(opcode, payload, final) {
  const mask = Buffer.from([1, 2, 3, 4]);
  const bytes = Buffer.from(payload);
  const header = Buffer.from([(final ? 0x80 : 0) | opcode, 0x80 | bytes.byteLength]);
  for (let index = 0; index < bytes.byteLength; index += 1) bytes[index] ^= mask[index % 4];
  return Buffer.concat([header, mask, bytes]);
}

function nextData(socket) {
  return new Promise((resolve, reject) => {
    socket.once('data', resolve);
    socket.once('error', reject);
  });
}

function notificationsController() {
  return class NotificationsController extends WebSocketControllerBase {
    static name = 'notifications';
    static events = [{ name: 'subscribe', handler: 'subscribe' }];
    subscribe() {
      return { subscribed: true };
    }
  };
}

test('неожиданная ошибка HTTP Upgrade возвращает 500 и передаётся в onError', async () => {
  const upgradeError = new Error('headers unavailable');
  let reported;
  const errorReported = new Promise((resolve) => {
    reported = resolve;
  });
  const server = new EventEmitter();
  const responses = [];
  const socket = {
    writable: true,
    end: (response) => responses.push(response),
  };
  const transport = new WebSocketTransport({
    controllers: undefined,
    jobRunner: undefined,
    onError(error, ctx) {
      reported({ error, ctx });
    },
    options: { path: '/websocket' },
    sessionStore: undefined,
  });
  const request = { url: '/websocket' };
  Object.defineProperty(request, 'headers', {
    get() {
      throw upgradeError;
    },
  });
  transport.attach(server);

  server.emit('upgrade', request, socket, Buffer.alloc(0));

  assert.deepEqual(await errorReported, { error: upgradeError, ctx: undefined });
  assert.deepEqual(responses, ['HTTP/1.1 500 Internal Server Error\r\n\r\n']);
});

test('WebSocket handshake проверяет Origin и Authentication до onConnect и 101', async () => {
  const attempts = [];
  const connections = [];
  const errors = [];
  const allowedOrigins = ['https://app.example.com'];
  const authentication = createAuthentication({
    strategies: {
      session: {
        authenticate(input) {
          attempts.push(input);
          if (input.query.get('mode') === 'error') throw new Error('credential details');
          const credential = input.headers.get('authorization');
          if (credential === null) return { status: 'abstain' };
          if (credential !== 'Session valid') {
            return {
              status: 'rejected',
              code: 'INVALID_CREDENTIALS',
              challenge: 'Session realm="daevox"',
            };
          }
          return {
            status: 'authenticated',
            session: {
              authSessionId: 'auth-session-42',
              principal: { id: 'user-42' },
            },
          };
        },
      },
    },
    scenarios: { browser: { use: ['session'], required: true } },
  });
  const app = new Application({
    authentication,
    websocket: {
      authentication: 'browser',
      allowedOrigins,
      onConnect: (ctx) => connections.push(ctx),
      onError: (error, ctx) => errors.push({ error, ctx }),
    },
  });
  allowedOrigins[0] = 'https://evil.example.com';
  const address = await app.listen({ port: 0 });
  const sockets = [];

  try {
    let handshake = await rawHandshake(address, {
      headers: { Origin: 'https://evil.example.com' },
    });
    sockets.push(handshake.socket);
    assert.match(handshake.data.toString(), /^HTTP\/1\.1 403 Forbidden\r\n/);
    assert.match(handshake.data.toString(), /\{"error":\{"code":"ORIGIN_NOT_ALLOWED"\}\}/);
    assert.equal(attempts.length, 0);
    assert.equal(connections.length, 0);

    handshake = await rawHandshake(address, {
      headers: { Origin: 'https://app.example.com' },
    });
    sockets.push(handshake.socket);
    assert.match(handshake.data.toString(), /^HTTP\/1\.1 401 Unauthorized\r\n/);
    assert.match(handshake.data.toString(), /\{"error":\{"code":"AUTHENTICATION_REQUIRED"\}\}/);
    assert.equal(connections.length, 0);

    handshake = await rawHandshake(address, {
      headers: {
        Origin: 'https://app.example.com',
        Authorization: 'Session invalid',
      },
    });
    sockets.push(handshake.socket);
    assert.match(handshake.data.toString(), /^HTTP\/1\.1 401 Unauthorized\r\n/);
    assert.match(handshake.data.toString(), /www-authenticate: Session realm="daevox"\r\n/i);
    assert.match(handshake.data.toString(), /\{"error":\{"code":"INVALID_CREDENTIALS"\}\}/);
    assert.equal(connections.length, 0);

    handshake = await rawHandshake(address, {
      path: '/websocket?mode=error',
      headers: { Origin: 'https://app.example.com' },
    });
    sockets.push(handshake.socket);
    assert.match(handshake.data.toString(), /^HTTP\/1\.1 500 Internal Server Error\r\n/);
    assert.match(handshake.data.toString(), /\{"error":\{"code":"INTERNAL_SERVER_ERROR"\}\}/);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].error.cause.message, 'credential details');
    assert.deepEqual(Object.keys(errors[0].ctx).toSorted(), [
      'path',
      'phase',
      'scenario',
      'signal',
    ]);
    assert.ok(Object.isFrozen(errors[0].ctx));
    assert.equal(connections.length, 0);

    handshake = await rawHandshake(address, {
      headers: {
        Origin: 'https://app.example.com',
        Authorization: 'Session valid',
      },
    });
    sockets.push(handshake.socket);
    assert.match(handshake.data.toString(), /^HTTP\/1\.1 101 Switching Protocols\r\n/);
    assert.equal(connections.length, 1);
    assert.deepEqual(Object.keys(connections[0]).toSorted(), [
      'authSession',
      'clientId',
      'origin',
      'path',
      'sessionId',
      'signal',
    ]);
    assert.equal(connections[0].origin, 'https://app.example.com');
    assert.equal(connections[0].authSession.authSessionId, 'auth-session-42');
    assert.ok(Object.isFrozen(connections[0]));
    assert.ok(Object.isFrozen(connections[0].authSession));
    assert.notEqual(connections[0].clientId, connections[0].sessionId);

    assert.equal(attempts.at(-1).transport, 'websocket');
    assert.equal(attempts.at(-1).method, 'GET');
    assert.equal(attempts.at(-1).path, '/websocket');
    assert.equal(attempts.at(-1).origin, 'https://app.example.com');
    assert.equal('socket' in attempts.at(-1), false);
    assert.equal('clientId' in attempts.at(-1), false);
    assert.equal('sessionId' in attempts.at(-1), false);
  } finally {
    for (const socket of sockets) socket.destroy();
    await app.close();
  }
});

test('optional WebSocket abstain не добавляет AuthSession в lifecycle', async () => {
  const attempts = [];
  const connections = [];
  const disconnections = [];
  const authentication = createAuthentication({
    strategies: {
      anonymous: {
        authenticate(input) {
          attempts.push(input);
          return { status: 'abstain' };
        },
      },
    },
    scenarios: { optional: { use: ['anonymous'], required: false } },
  });
  const app = new Application({
    authentication,
    websocket: {
      authentication: 'optional',
      onConnect: (ctx) => connections.push(ctx),
      onDisconnect: (ctx) => disconnections.push(ctx),
    },
  });
  const address = await app.listen({ port: 0 });
  const socket = await opened(`ws://${address.address}:${address.port}/websocket?source=test`);

  try {
    assert.equal(connections.length, 1);
    assert.equal(Object.hasOwn(connections[0], 'authSession'), false);
    assert.equal(Object.hasOwn(connections[0], 'origin'), false);
    assert.deepEqual(Object.keys(connections[0]).toSorted(), [
      'clientId',
      'path',
      'sessionId',
      'signal',
    ]);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].query.get('source'), 'test');
    assert.equal(Object.hasOwn(attempts[0], 'origin'), false);

    const close = closed(socket);
    socket.close(1000, 'Done');
    await close;
  } finally {
    socket.close();
    await app.close();
  }

  assert.equal(disconnections.length, 1);
  assert.equal(Object.hasOwn(disconnections[0], 'authSession'), false);
});

test('expiresAt закрывает WebSocket membership и передаёт AuthSession в disconnect', async () => {
  const connections = [];
  const disconnections = [];
  let resolveDisconnected;
  const disconnected = new Promise((resolve) => {
    resolveDisconnected = resolve;
  });
  const authentication = createAuthentication({
    strategies: {
      expiring: {
        authenticate: () => ({
          status: 'authenticated',
          session: {
            authSessionId: 'expiring-session',
            principal: { id: 'user-42' },
            expiresAt: Date.now() + 100,
          },
        }),
      },
    },
    scenarios: { required: { use: ['expiring'], required: true } },
  });
  const app = new Application({
    authentication,
    websocket: {
      authentication: 'required',
      onConnect: (ctx) => connections.push(ctx),
      onDisconnect(ctx) {
        disconnections.push(ctx);
        resolveDisconnected();
      },
    },
  });
  const address = await app.listen({ port: 0 });
  const socket = await opened(`ws://${address.address}:${address.port}/websocket`);

  try {
    const close = await closed(socket);
    await disconnected;
    assert.deepEqual(close, { code: 4001, reason: 'Authentication expired' });
    assert.equal(connections.length, 1);
    assert.equal(disconnections.length, 1);
    assert.equal(connections[0].authSession, disconnections[0].authSession);
    assert.equal(disconnections[0].authSession.authSessionId, 'expiring-session');
    assert.equal(disconnections[0].signal.aborted, true);
    assert.ok(Object.isFrozen(disconnections[0]));
    assert.deepEqual(Object.keys(disconnections[0]).toSorted(), [
      'authSession',
      'clientId',
      'code',
      'reason',
      'sessionId',
      'signal',
    ]);
  } finally {
    socket.close();
    await app.close();
  }

  assert.equal(disconnections.length, 1);
});

test('AuthSession, истёкшая в onConnect, не получает 101 и membership', async () => {
  let connectCalls = 0;
  let disconnectCalls = 0;
  const authentication = createAuthentication({
    strategies: {
      expiring: {
        authenticate: () => ({
          status: 'authenticated',
          session: {
            authSessionId: 'expires-in-connect',
            principal: {},
            expiresAt: Date.now() + 50,
          },
        }),
      },
    },
    scenarios: { required: { use: ['expiring'], required: true } },
  });
  const app = new Application({
    authentication,
    websocket: {
      authentication: 'required',
      async onConnect() {
        connectCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 80));
      },
      onDisconnect() {
        disconnectCalls += 1;
      },
    },
  });
  const address = await app.listen({ port: 0 });

  try {
    const handshake = await rawHandshake(address);
    handshake.socket.destroy();
    assert.match(handshake.data.toString(), /^HTTP\/1\.1 401 Unauthorized\r\n/);
    assert.match(handshake.data.toString(), /\{"error":\{"code":"AUTHENTICATION_EXPIRED"\}\}/);
    assert.equal(connectCalls, 1);
    assert.equal(disconnectCalls, 0);
  } finally {
    await app.close();
  }
});

test('daevox.v1 принимает handshake только на едином endpoint с subprotocol', async () => {
  const connections = [];
  const app = new Application({
    websocket: { authentication: false, onConnect: (ctx) => connections.push(ctx) },
  });
  app.registerWebSocketController(notificationsController());
  const address = await app.listen({ port: 0 });
  const origin = `ws://${address.address}:${address.port}`;
  try {
    assert.equal(await rejected(`${origin}/unknown`, 'daevox.v1'), true);
    assert.equal(await rejected(`${origin}/websocket`), true);
    const socket = await opened(`${origin}/websocket?source=test`);
    assert.equal(socket.protocol, 'daevox.v1');
    assert.equal(connections.length, 1);
    assert.match(
      connections[0].clientId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.match(
      connections[0].sessionId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.notEqual(connections[0].clientId, connections[0].sessionId);
    assert.equal(connections[0].path, '/websocket');
    assert.ok(connections[0].signal instanceof AbortSignal);
    assert.deepEqual(Object.keys(connections[0]).toSorted(), [
      'clientId',
      'path',
      'sessionId',
      'signal',
    ]);
    socket.close();
  } finally {
    await app.close();
  }
});

test('daevox.v1 маршрутизирует envelope и формирует реактивный ответ', async () => {
  const instances = [];
  const contexts = [];
  class NotificationsController extends WebSocketControllerBase {
    static name = 'notifications';
    static events = [{ name: 'subscribe', handler: 'subscribe' }];
    constructor(options) {
      super(options);
      instances.push(this);
    }
    subscribe(ctx) {
      contexts.push(ctx);
      return { subscribed: ctx.body.topic };
    }
  }
  const app = new Application({ websocket: { authentication: false } });
  app.registerWebSocketController(NotificationsController);
  const address = await app.listen({ port: 0 });
  const socket = await opened(`ws://${address.address}:${address.port}/websocket`);
  try {
    let message = nextMessage(socket);
    socket.send(
      JSON.stringify({
        controller: 'notifications',
        event: 'subscribe',
        body: { topic: 'news' },
      }),
    );
    assert.deepEqual(JSON.parse(await message), {
      controller: 'notifications',
      event: 'subscribe',
      body: { subscribed: 'news' },
    });
    message = nextMessage(socket);
    socket.send(
      JSON.stringify({
        controller: 'notifications',
        event: 'subscribe',
        body: { topic: 'updates' },
      }),
    );
    await message;
    assert.equal(instances.length, 2);
    assert.notEqual(instances[0], instances[1]);
    assert.deepEqual(Object.keys(contexts[0]).toSorted(), [
      'body',
      'clientId',
      'sessionId',
      'signal',
    ]);
    assert.equal(contexts[0].body.topic, 'news');
    assert.equal(contexts[0].clientId, contexts[1].clientId);
    assert.equal(contexts[0].sessionId, contexts[1].sessionId);
    assert.ok(contexts[0].signal instanceof AbortSignal);
  } finally {
    socket.close();
    await app.close();
  }
});

test('маршрутизация использует копию метаданных на момент регистрации', async () => {
  const event = { name: 'original-event', handler: 'handle' };
  class SnapshotController extends WebSocketControllerBase {
    static name = 'original-controller';
    static events = [event];
    handle() {
      return { snapshot: true };
    }
  }
  const app = new Application({ websocket: { authentication: false } });
  app.registerWebSocketController(SnapshotController);
  SnapshotController.name = 'changed-controller';
  event.name = 'changed-event';
  event.handler = 'changedHandler';
  SnapshotController.events.length = 0;

  const address = await app.listen({ port: 0 });
  const socket = await opened(`ws://${address.address}:${address.port}/websocket`);
  try {
    const message = nextMessage(socket);
    socket.send(
      JSON.stringify({
        controller: 'original-controller',
        event: 'original-event',
        body: {},
      }),
    );
    assert.deepEqual(JSON.parse(await message).body, { snapshot: true });
  } finally {
    socket.close();
    await app.close();
  }
});

test('неизвестный WebSocket-контроллер возвращает UNKNOWN_CONTROLLER и сохраняет сессию', async () => {
  const errors = [];
  const app = new Application({
    websocket: { authentication: false, onError: (error, ctx) => errors.push({ error, ctx }) },
  });
  app.registerWebSocketController(notificationsController());
  const address = await app.listen({ port: 0 });
  const socket = await opened(`ws://${address.address}:${address.port}/websocket`);
  try {
    let message = nextMessage(socket);
    socket.send(JSON.stringify({ controller: 'missing', event: 'subscribe', body: {} }));
    assert.deepEqual(JSON.parse(await message), {
      controller: 'missing',
      event: 'subscribe',
      body: { error: { code: 'UNKNOWN_CONTROLLER' } },
    });
    assert.equal(errors.length, 1);
    assert.ok(errors[0].error instanceof WebSocketProtocolError);
    assert.equal(errors[0].error.code, 'UNKNOWN_CONTROLLER');
    assert.equal(errors[0].ctx.controller, 'missing');
    assert.equal(errors[0].ctx.event, 'subscribe');

    message = nextMessage(socket);
    socket.send(JSON.stringify({ controller: 'notifications', event: 'subscribe', body: {} }));
    await message;
    assert.equal(socket.readyState, WebSocket.OPEN);
  } finally {
    socket.close();
    await app.close();
  }
});

test('неизвестное WebSocket-событие возвращает UNKNOWN_EVENT', async () => {
  const errors = [];
  const app = new Application({
    websocket: { authentication: false, onError: (error, ctx) => errors.push({ error, ctx }) },
  });
  app.registerWebSocketController(notificationsController());
  const address = await app.listen({ port: 0 });
  const socket = await opened(`ws://${address.address}:${address.port}/websocket`);
  try {
    const message = nextMessage(socket);
    socket.send(JSON.stringify({ controller: 'notifications', event: 'missing', body: {} }));
    assert.deepEqual(JSON.parse(await message), {
      controller: 'notifications',
      event: 'missing',
      body: { error: { code: 'UNKNOWN_EVENT' } },
    });
    assert.equal(errors[0].error.code, 'UNKNOWN_EVENT');
    assert.equal(errors[0].ctx.controller, 'notifications');
    assert.equal(errors[0].ctx.event, 'missing');
  } finally {
    socket.close();
    await app.close();
  }
});

test('адресуемый неверный envelope возвращает INVALID_MESSAGE и продолжает очередь', async () => {
  const errors = [];
  const app = new Application({
    websocket: { authentication: false, onError: (error, ctx) => errors.push({ error, ctx }) },
  });
  app.registerWebSocketController(notificationsController());
  const address = await app.listen({ port: 0 });
  const socket = await opened(`ws://${address.address}:${address.port}/websocket`);
  try {
    let message = nextMessage(socket);
    socket.send(
      JSON.stringify({
        controller: 'notifications',
        event: 'subscribe',
        body: {},
        extra: true,
      }),
    );
    assert.deepEqual(JSON.parse(await message), {
      controller: 'notifications',
      event: 'subscribe',
      body: { error: { code: 'INVALID_MESSAGE' } },
    });
    assert.equal(errors[0].error.code, 'INVALID_MESSAGE');

    message = nextMessage(socket);
    socket.send(JSON.stringify({ controller: 'notifications', event: 'subscribe', body: {} }));
    await message;
    assert.equal(socket.readyState, WebSocket.OPEN);
  } finally {
    socket.close();
    await app.close();
  }
});

test('неадресуемый JSON закрывает сессию кодом 1007, binary frame — кодом 1003', async () => {
  const errors = [];
  const app = new Application({
    websocket: { authentication: false, onError: (error) => errors.push(error) },
  });
  app.registerWebSocketController(notificationsController());
  const address = await app.listen({ port: 0 });
  const url = `ws://${address.address}:${address.port}/websocket`;

  let socket = await opened(url);
  let closeEvent = closed(socket);
  socket.send('{');
  assert.deepEqual(await closeEvent, { code: 1007, reason: 'Invalid message' });
  assert.equal(errors[0].code, 'INVALID_MESSAGE');

  socket = await opened(url);
  closeEvent = closed(socket);
  socket.send(new Uint8Array([123, 125]));
  assert.deepEqual(await closeEvent, { code: 1003, reason: 'Binary messages are not supported' });
  assert.equal(errors[1].code, 'INVALID_MESSAGE');
  await app.close();
});

test('невалидный UTF-8 в text frame закрывает сессию кодом 1007 до JSON-разбора', async () => {
  let handled = false;
  class Utf8Controller extends WebSocketControllerBase {
    static name = 'c';
    static events = [{ name: 'e', handler: 'handle' }];
    handle() {
      handled = true;
    }
  }
  const app = new Application({ websocket: { authentication: false } });
  app.registerWebSocketController(Utf8Controller);
  const address = await app.listen({ port: 0 });
  const socket = await rawWebSocket(address);
  try {
    const prefix = Buffer.from('{"controller":"c","event":"e","body":{"value":"');
    const suffix = Buffer.from('"}}');
    const response = nextData(socket);
    socket.write(maskedTextFrame(Buffer.concat([prefix, Buffer.from([0xc3, 0x28]), suffix])));
    const closeFrame = await response;
    assert.equal(closeFrame[0] & 0x0f, 8);
    assert.equal(closeFrame.readUInt16BE(2), 1007);
    assert.equal(handled, false);
  } finally {
    socket.destroy();
    await app.close();
  }
});

test('fragmented WebSocket-сообщение собирается из нескольких continuation frames', async () => {
  const app = new Application({ websocket: { authentication: false } });
  app.registerWebSocketController(notificationsController());
  const address = await app.listen({ port: 0 });
  const socket = await rawWebSocket(address);

  try {
    const message = Buffer.from(
      JSON.stringify({ controller: 'notifications', event: 'subscribe', body: {} }),
    );
    const firstBoundary = Math.floor(message.byteLength / 3);
    const secondBoundary = firstBoundary * 2;
    const response = nextData(socket);
    socket.write(
      Buffer.concat([
        maskedFragment(1, message.subarray(0, firstBoundary), false),
        maskedFragment(0, message.subarray(firstBoundary, secondBoundary), false),
        maskedFragment(0, message.subarray(secondBoundary), true),
      ]),
    );

    const responseFrame = await response;
    assert.equal(responseFrame[0] & 0x0f, 1);
    assert.deepEqual(JSON.parse(responseFrame.subarray(2).toString()), {
      controller: 'notifications',
      event: 'subscribe',
      body: { subscribed: true },
    });
  } finally {
    socket.destroy();
    await app.close();
  }
});

test('WebSocket transport отвечает pong и отклоняет немаскированный client frame', async () => {
  const app = new Application({ websocket: { authentication: false } });
  const address = await app.listen({ port: 0 });

  let socket = await rawWebSocket(address);
  let response = nextData(socket);
  socket.write(maskedControlFrame(9, Buffer.from('ping')));
  assert.deepEqual(await response, Buffer.from([0x8a, 4, 0x70, 0x69, 0x6e, 0x67]));
  socket.destroy();

  socket = await rawWebSocket(address);
  response = nextData(socket);
  socket.write(Buffer.from([0x81, 1, 0x61]));
  const closeFrame = await response;
  assert.equal(closeFrame[0] & 0x0f, 8);
  assert.equal(closeFrame.readUInt16BE(2), 1002);
  socket.destroy();
  await app.close();
});

test('WebSocket transport отклоняет невозможную длину и слишком большой control frame', async () => {
  const app = new Application({ websocket: { authentication: false } });
  const address = await app.listen({ port: 0 });

  let socket = await rawWebSocket(address);
  let response = nextData(socket);
  const impossibleLength = Buffer.alloc(10);
  impossibleLength[0] = 0x81;
  impossibleLength[1] = 0xff;
  impossibleLength.writeBigUInt64BE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 2);
  socket.write(impossibleLength);
  let closeFrame = await response;
  assert.equal(closeFrame.readUInt16BE(2), 1009);
  socket.destroy();

  socket = await rawWebSocket(address);
  response = nextData(socket);
  socket.write(Buffer.from([0x89, 0xfe, 0, 126]));
  closeFrame = await response;
  assert.equal(closeFrame.readUInt16BE(2), 1002);
  socket.destroy();
  await app.close();
});

test('WebSocket transport отклоняет некорректный URL и версию handshake', async () => {
  const app = new Application({ websocket: { authentication: false } });
  const address = await app.listen({ port: 0 });

  let result = await rawRequest(
    address,
    `GET http://[invalid HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: daevox.v1\r\n\r\n`,
  );
  assert.match(result.data.toString(), /^HTTP\/1\.1 400 Bad Request/);
  result.socket.destroy();

  result = await rawRequest(
    address,
    `GET /websocket HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 12\r\nSec-WebSocket-Protocol: daevox.v1\r\n\r\n`,
  );
  assert.match(result.data.toString(), /^HTTP\/1\.1 400 Bad Request/);
  result.socket.destroy();
  await app.close();
});

test('ошибка handler скрывается как HANDLER_ERROR, неверный результат — как INVALID_RESPONSE', async () => {
  const errors = [];
  class ResultsController extends WebSocketControllerBase {
    static name = 'results';
    static events = [
      { name: 'fail', handler: 'fail' },
      { name: 'invalid', handler: 'invalid' },
      { name: 'valid', handler: 'valid' },
    ];
    fail() {
      throw new Error('secret details');
    }
    invalid() {
      return { error: { code: 'USER_ERROR' } };
    }
    valid() {
      return { ok: true };
    }
  }
  const app = new Application({
    websocket: { authentication: false, onError: (error, ctx) => errors.push({ error, ctx }) },
  });
  app.registerWebSocketController(ResultsController);
  const address = await app.listen({ port: 0 });
  const socket = await opened(`ws://${address.address}:${address.port}/websocket`);
  try {
    let message = nextMessage(socket);
    socket.send(JSON.stringify({ controller: 'results', event: 'fail', body: {} }));
    assert.deepEqual(JSON.parse(await message), {
      controller: 'results',
      event: 'fail',
      body: { error: { code: 'HANDLER_ERROR' } },
    });
    assert.equal(errors[0].error.message, 'secret details');
    assert.equal(errors[0].ctx.controller, 'results');
    assert.equal(errors[0].ctx.event, 'fail');

    message = nextMessage(socket);
    socket.send(JSON.stringify({ controller: 'results', event: 'invalid', body: {} }));
    assert.deepEqual(JSON.parse(await message), {
      controller: 'results',
      event: 'invalid',
      body: { error: { code: 'INVALID_RESPONSE' } },
    });
    assert.equal(errors[1].error.code, 'INVALID_RESPONSE');

    message = nextMessage(socket);
    socket.send(JSON.stringify({ controller: 'results', event: 'valid', body: {} }));
    await message;
    assert.equal(socket.readyState, WebSocket.OPEN);
  } finally {
    socket.close();
    await app.close();
  }
});

test('входящее сообщение больше maxPayload закрывает сессию кодом 1009 и сообщает ошибку', async () => {
  const errors = [];
  const app = new Application({
    websocket: {
      authentication: false,
      maxPayload: 50,
      onError: (error, ctx) => errors.push({ error, ctx }),
    },
  });
  app.registerWebSocketController(notificationsController());
  const address = await app.listen({ port: 0 });
  const socket = await opened(`ws://${address.address}:${address.port}/websocket`);
  try {
    const closeEvent = closed(socket);
    socket.send(
      JSON.stringify({
        controller: 'notifications',
        event: 'subscribe',
        body: { value: 'too large' },
      }),
    );
    assert.deepEqual(await closeEvent, { code: 1009, reason: 'Message too large' });
    assert.equal(errors.length, 1);
    assert.ok(errors[0].error instanceof WebSocketProtocolError);
    assert.equal(errors[0].error.code, 'INVALID_MESSAGE');
    assert.equal(typeof errors[0].ctx.clientId, 'string');
    assert.equal(typeof errors[0].ctx.sessionId, 'string');
  } finally {
    await app.close();
  }
});

test('сообщения одной сессии последовательны, а разные сессии выполняются независимо', async () => {
  const started = [];
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  class QueueController extends WebSocketControllerBase {
    static name = 'queue';
    static events = [{ name: 'run', handler: 'run' }];
    async run(ctx) {
      started.push(`${ctx.sessionId}:${ctx.body.value}`);
      if (ctx.body.value === 'first') await firstBlocked;
      return { value: ctx.body.value };
    }
  }
  const app = new Application({ websocket: { authentication: false } });
  app.registerWebSocketController(QueueController);
  const address = await app.listen({ port: 0 });
  const url = `ws://${address.address}:${address.port}/websocket`;
  const firstSession = await opened(url);
  const secondSession = await opened(url);
  try {
    const firstResponses = nextMessages(firstSession, 2);
    firstSession.send(
      JSON.stringify({ controller: 'queue', event: 'run', body: { value: 'first' } }),
    );
    firstSession.send(
      JSON.stringify({ controller: 'queue', event: 'run', body: { value: 'second' } }),
    );

    const independentResponse = nextMessage(secondSession);
    secondSession.send(
      JSON.stringify({ controller: 'queue', event: 'run', body: { value: 'independent' } }),
    );
    assert.equal(JSON.parse(await independentResponse).body.value, 'independent');
    assert.equal(
      started.some((entry) => entry.endsWith(':second')),
      false,
    );

    releaseFirst();
    const [firstResponse, secondResponse] = await firstResponses;
    assert.equal(JSON.parse(firstResponse).body.value, 'first');
    assert.equal(JSON.parse(secondResponse).body.value, 'second');
  } finally {
    firstSession.close();
    secondSession.close();
    await app.close();
  }
});

test('undefined не создаёт ответ и не мешает следующему сообщению', async () => {
  class OptionalResponseController extends WebSocketControllerBase {
    static name = 'optional';
    static events = [
      { name: 'silent', handler: 'silent' },
      { name: 'reply', handler: 'reply' },
    ];
    silent() {}
    reply() {
      return { replied: true };
    }
  }
  const app = new Application({ websocket: { authentication: false } });
  app.registerWebSocketController(OptionalResponseController);
  const address = await app.listen({ port: 0 });
  const socket = await opened(`ws://${address.address}:${address.port}/websocket`);
  try {
    const message = nextMessage(socket);
    socket.send(JSON.stringify({ controller: 'optional', event: 'silent', body: {} }));
    socket.send(JSON.stringify({ controller: 'optional', event: 'reply', body: {} }));
    assert.deepEqual(JSON.parse(await message).body, { replied: true });
  } finally {
    socket.close();
    await app.close();
  }
});

test('onDisconnect вызывается один раз с отменённым сигналом сессии', async () => {
  const disconnects = [];
  let disconnected;
  const disconnectCalled = new Promise((resolve) => {
    disconnected = resolve;
  });
  const app = new Application({
    websocket: {
      authentication: false,
      onDisconnect(ctx) {
        disconnects.push(ctx);
        disconnected();
      },
    },
  });
  app.registerWebSocketController(notificationsController());
  const address = await app.listen({ port: 0 });
  const socket = await opened(`ws://${address.address}:${address.port}/websocket`);
  try {
    socket.close(4000, 'finished');
    await disconnectCalled;
    assert.equal(disconnects.length, 1);
    assert.equal(disconnects[0].code, 4000);
    assert.equal(disconnects[0].reason, 'finished');
    assert.equal(disconnects[0].signal.aborted, true);
  } finally {
    await app.close();
  }
  assert.equal(disconnects.length, 1);
});

test('Application.close ожидает асинхронный onDisconnect принятой сессии', async () => {
  let releaseDisconnect;
  const disconnectPending = new Promise((resolve) => {
    releaseDisconnect = resolve;
  });
  const app = new Application({
    websocket: { authentication: false, onDisconnect: () => disconnectPending },
  });
  app.registerWebSocketController(notificationsController());
  const address = await app.listen({ port: 0 });
  await opened(`ws://${address.address}:${address.port}/websocket`);

  let applicationClosed = false;
  const closing = app.close().then(() => {
    applicationClosed = true;
  });
  const stateBeforeRelease = await Promise.race([
    closing.then(() => 'closed'),
    new Promise((resolve) => setTimeout(() => resolve('waiting'), 50)),
  ]);
  assert.equal(stateBeforeRelease, 'waiting');
  assert.equal(applicationClosed, false);
  releaseDisconnect();
  await closing;
  assert.equal(applicationClosed, true);
});

test('исходящий maxPayload возвращает INVALID_RESPONSE или закрывает сессию кодом 1011', async () => {
  class LargeController extends WebSocketControllerBase {
    static name = 'c';
    static events = [{ name: 'e', handler: 'large' }];
    large() {
      return { value: 'x'.repeat(100) };
    }
  }
  const input = JSON.stringify({ controller: 'c', event: 'e', body: {} });

  let app = new Application({ websocket: { authentication: false, maxPayload: 80 } });
  app.registerWebSocketController(LargeController);
  let address = await app.listen({ port: 0 });
  let socket = await opened(`ws://${address.address}:${address.port}/websocket`);
  let message = nextMessage(socket);
  socket.send(input);
  assert.equal(JSON.parse(await message).body.error.code, 'INVALID_RESPONSE');
  socket.close();
  await app.close();

  app = new Application({ websocket: { authentication: false, maxPayload: 70 } });
  app.registerWebSocketController(LargeController);
  address = await app.listen({ port: 0 });
  socket = await opened(`ws://${address.address}:${address.port}/websocket`);
  const closeEvent = closed(socket);
  socket.send(input);
  assert.deepEqual(await closeEvent, { code: 1011, reason: 'Internal error' });
  await app.close();
});

test('daevox.v1 принимает и отправляет envelopes с 16- и 64-битной длиной frame', async () => {
  class LargeFramesController extends WebSocketControllerBase {
    static name = 'frames';
    static events = [{ name: 'echo', handler: 'echo' }];
    echo(ctx) {
      return { value: ctx.body.value };
    }
  }
  const app = new Application({ websocket: { authentication: false } });
  app.registerWebSocketController(LargeFramesController);
  const address = await app.listen({ port: 0 });
  const socket = await opened(`ws://${address.address}:${address.port}/websocket`);
  try {
    for (const value of ['m'.repeat(126), 'l'.repeat(65_536)]) {
      const message = nextMessage(socket);
      socket.send(JSON.stringify({ controller: 'frames', event: 'echo', body: { value } }));
      assert.equal(JSON.parse(await message).body.value, value);
    }
  } finally {
    socket.close();
    await app.close();
  }
});

test('ошибка onConnect отклоняет handshake с 500, ошибка onDisconnect передаётся в onError', async () => {
  const connectError = new Error('connect failed');
  const disconnectError = new Error('disconnect failed');
  const errors = [];
  let app = new Application({
    websocket: {
      authentication: false,
      onConnect() {
        throw connectError;
      },
      onError: (error, ctx) => errors.push({ error, ctx }),
    },
  });
  app.registerWebSocketController(notificationsController());
  let address = await app.listen({ port: 0 });
  assert.equal(
    await rejected(`ws://${address.address}:${address.port}/websocket`, 'daevox.v1'),
    true,
  );
  assert.ok(errors.length >= 1);
  assert.ok(errors.every(({ error }) => error === connectError));
  assert.ok(errors.every(({ ctx }) => typeof ctx.clientId === 'string'));
  await app.close();

  let errorReported;
  const reported = new Promise((resolve) => {
    errorReported = resolve;
  });
  app = new Application({
    websocket: {
      authentication: false,
      onDisconnect() {
        throw disconnectError;
      },
      onError(error, ctx) {
        errors.push({ error, ctx });
        errorReported();
      },
    },
  });
  app.registerWebSocketController(notificationsController());
  address = await app.listen({ port: 0 });
  const socket = await opened(`ws://${address.address}:${address.port}/websocket`);
  socket.close();
  await reported;
  assert.equal(errors.at(-1).error, disconnectError);
  assert.equal(typeof errors.at(-1).ctx.sessionId, 'string');
  await app.close();
});

test('отклонённый Promise websocket.onError безопасно передаётся в console.error', async (t) => {
  const reportingError = new Error('reporting failed');
  let consoleCalled;
  const called = new Promise((resolve) => {
    consoleCalled = resolve;
  });
  const consoleError = t.mock.method(console, 'error', () => consoleCalled());
  class FailingController extends WebSocketControllerBase {
    static name = 'failure';
    static events = [{ name: 'fail', handler: 'fail' }];
    fail() {
      throw new Error('handler failed');
    }
  }
  const app = new Application({
    websocket: { authentication: false, onError: () => Promise.reject(reportingError) },
  });
  app.registerWebSocketController(FailingController);
  const address = await app.listen({ port: 0 });
  const socket = await opened(`ws://${address.address}:${address.port}/websocket`);
  socket.send(JSON.stringify({ controller: 'failure', event: 'fail', body: {} }));
  await called;
  assert.equal(consoleError.mock.callCount(), 1);
  assert.equal(consoleError.mock.calls[0].arguments[0], reportingError);
  socket.close();
  await app.close();
});

test('синхронная ошибка websocket.onError безопасно передаётся в console.error', async (t) => {
  const reportingError = new Error('reporting failed synchronously');
  let consoleCalled;
  const called = new Promise((resolve) => {
    consoleCalled = resolve;
  });
  const consoleError = t.mock.method(console, 'error', () => consoleCalled());
  const app = new Application({
    websocket: {
      authentication: false,
      onError() {
        throw reportingError;
      },
    },
  });
  const address = await app.listen({ port: 0 });
  const socket = await opened(`ws://${address.address}:${address.port}/websocket`);
  socket.send('{');
  await called;
  assert.equal(consoleError.mock.callCount(), 1);
  assert.equal(consoleError.mock.calls[0].arguments[0], reportingError);
  await closed(socket);
  await app.close();
});
