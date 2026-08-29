import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import test from 'node:test';

import { Application } from '../../lib/framework/Application.ts';
import { WebSocketControllerBase } from '../../lib/framework/WebSocketControllerBase.ts';
import { HttpControllerBase } from '../../lib/framework/HttpControllerBase.ts';
import {
  HttpError,
  MiddlewareExecutionError,
  WebSocketEventError,
  WebSocketProtocolError,
} from '../../lib/framework/errors.ts';
import { WebSocketTransport } from '../../lib/framework/WebSocketTransport.ts';

function opened(url: any, protocol: any = 'daevox.v1') {
  return new Promise<any>((resolve: any, reject: any) => {
    const socket = new WebSocket(url, protocol);
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
}

function rejected(url: any, protocol: any = undefined) {
  return new Promise<any>((resolve: any) => {
    const socket = protocol === undefined ? new WebSocket(url) : new WebSocket(url, protocol);
    socket.addEventListener('open', () => resolve(false), { once: true });
    socket.addEventListener('error', () => resolve(true), { once: true });
  });
}

function nextMessage(socket: any) {
  return new Promise<any>((resolve: any, reject: any) => {
    const timer = setTimeout(() => reject(new Error('WebSocket message timeout')), 1_000);
    socket.addEventListener(
      'message',
      (event: any) => {
        clearTimeout(timer);
        resolve(event.data);
      },
      { once: true },
    );
  });
}

function closed(socket: any) {
  return new Promise<any>((resolve: any) => {
    socket.addEventListener(
      'close',
      (event: any) => resolve({ code: event.code, reason: event.reason }),
      { once: true },
    );
  });
}

function nextMessages(socket: any, count: any) {
  return new Promise<any>((resolve: any) => {
    const messages: any[] = [];
    const listener = (event: any) => {
      messages.push(event.data);
      if (messages.length === count) {
        socket.removeEventListener('message', listener);
        resolve(messages);
      }
    };
    socket.addEventListener('message', listener);
  });
}

function rawRequest(address: any, request: any) {
  return new Promise<any>((resolve: any, reject: any) => {
    const socket = net.connect(address.port, address.address, () => socket.write(request));
    socket.once('data', (data: any) => resolve({ data, socket }));
    socket.once('error', reject);
  });
}

async function rawWebSocket(address: any) {
  const { data, socket } = await rawRequest(
    address,
    `GET /websocket HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: daevox.v1\r\n\r\n`,
  );
  assert.match(data.toString(), /^HTTP\/1\.1 101 Switching Protocols/);
  return socket;
}

function maskedTextFrame(payload: any) {
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

function maskedControlFrame(opcode: any, payload: any) {
  const mask = Buffer.from([1, 2, 3, 4]);
  const bytes = Buffer.from(payload);
  const header = Buffer.from([0x80 | opcode, 0x80 | bytes.byteLength]);
  for (let index = 0; index < bytes.byteLength; index += 1) bytes[index] ^= mask[index % 4];
  return Buffer.concat([header, mask, bytes]);
}

function maskedFragment(opcode: any, payload: any, final: any) {
  const mask = Buffer.from([1, 2, 3, 4]);
  const bytes = Buffer.from(payload);
  const header = Buffer.from([(final ? 0x80 : 0) | opcode, 0x80 | bytes.byteLength]);
  for (let index = 0; index < bytes.byteLength; index += 1) bytes[index] ^= mask[index % 4];
  return Buffer.concat([header, mask, bytes]);
}

function nextData(socket: any) {
  return new Promise<any>((resolve: any, reject: any) => {
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
  let reported: any;
  const errorReported = new Promise<any>((resolve: any) => {
    reported = resolve;
  });
  const server = new EventEmitter();
  const responses: any[] = [];
  const socket = {
    writable: true,
    end: (response: any) => responses.push(response),
  };
  const transport = new WebSocketTransport({
    controllers: undefined,
    jobRunner: undefined,
    onError(error: any, ctx: any) {
      reported({ error, ctx });
    },
    options: { path: '/websocket' },
    sessionStore: undefined,
  } as any);
  const request = { url: '/websocket' };
  Object.defineProperty(request, 'headers', {
    get() {
      throw upgradeError;
    },
  });
  transport.attach(server as any);

  server.emit('upgrade', request, socket, Buffer.alloc(0));

  assert.deepEqual(await errorReported, { error: upgradeError, ctx: undefined });
  assert.deepEqual(responses, ['HTTP/1.1 500 Internal Server Error\r\n\r\n']);
});

test('daevox.v1 принимает handshake только на едином endpoint с subprotocol', async () => {
  const connections: any[] = [];
  const app = new Application({
    websocket: {
      onConnect: (ctx: any) => {
        connections.push(ctx);
      },
    },
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
    assert.equal(connections[0].query.get('source'), 'test');
    assert.ok(connections[0].headers instanceof Headers);
    assert.ok(connections[0].signal instanceof AbortSignal);
    socket.close();
  } finally {
    await app.close();
  }
});

test('onConnect может назначить clientId, который сохраняется в message и disconnect contexts', async () => {
  let messageContext: any;
  let disconnectContext: any;
  let resolveDisconnected: any;
  const disconnected = new Promise<any>((resolve: any) => {
    resolveDisconnected = resolve;
  });
  const app = new Application({
    websocket: {
      onConnect: () => 'stable-client',
      onDisconnect: (ctx: any) => {
        disconnectContext = ctx;
        resolveDisconnected();
      },
    },
  });
  class ContextController extends WebSocketControllerBase {
    static name = 'context';
    static events = [{ name: 'read', handler: 'read' }];
    read(ctx: any) {
      messageContext = ctx;
      return { clientId: ctx.clientId };
    }
  }
  app.registerWebSocketController(ContextController);
  const address = await app.listen({ port: 0 });
  const socket = await opened(`ws://${address.address}:${address.port}/websocket`);

  try {
    const message = nextMessage(socket);
    socket.send(JSON.stringify({ controller: 'context', event: 'read', body: {} }));
    assert.deepEqual(JSON.parse(await message).body, { clientId: 'stable-client' });
    socket.close();
    await disconnected;
    assert.equal(messageContext.clientId, 'stable-client');
    assert.equal(disconnectContext.clientId, 'stable-client');
  } finally {
    await app.close();
  }
});

test('HTTP-контроллер отправляет server push через this.websocket', async () => {
  const app = new Application({
    websocket: { onConnect: () => 'push-client' },
  });
  app.registerWebSocketController(notificationsController());
  class PushController extends HttpControllerBase {
    static prefix = '/push';
    static routes = [{ method: 'GET', path: '/', handler: 'send' }];
    send() {
      return {
        status: 200,
        body: this.websocket.send(
          { clientId: 'push-client' },
          { controller: 'notifications', event: 'published', body: { id: 42 } },
        ),
      };
    }
  }
  app.registerHttpController(PushController);
  const address = await app.listen({ port: 0 });
  const socket = await opened(`ws://${address.address}:${address.port}/websocket`);

  try {
    const message = nextMessage(socket);
    const response = await fetch(`http://${address.address}:${address.port}/push/`);
    assert.deepEqual(await response.json(), { sent: 1, skipped: 0 });
    assert.deepEqual(JSON.parse(await message), {
      controller: 'notifications',
      event: 'published',
      body: { id: 42 },
    });
  } finally {
    socket.close();
    await app.close();
  }
});

test('daevox.v1 маршрутизирует envelope и формирует реактивный ответ', async () => {
  const instances: any[] = [];
  const contexts: any[] = [];
  class NotificationsController extends WebSocketControllerBase {
    static name = 'notifications';
    static events = [{ name: 'subscribe', handler: 'subscribe' }];
    constructor(options: any) {
      super(options);
      instances.push(this);
    }
    subscribe(ctx: any) {
      contexts.push(ctx);
      return { subscribed: ctx.body.topic };
    }
  }
  const app = new Application();
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
      'controller',
      'event',
      'sessionId',
      'signal',
      'state',
    ]);
    assert.equal(contexts[0].body.topic, 'news');
    assert.equal(contexts[0].clientId, contexts[1].clientId);
    assert.equal(contexts[0].sessionId, contexts[1].sessionId);
    assert.ok(contexts[0].signal instanceof AbortSignal);
    assert.equal(contexts[0].controller, 'notifications');
    assert.equal(contexts[0].event, 'subscribe');
    assert.equal(Object.getPrototypeOf(contexts[0].state), null);
  } finally {
    socket.close();
    await app.close();
  }
});

test('WebSocket middleware short-circuit не создаёт контроллер и сохраняет очередь', async () => {
  let instances = 0;
  class ShortCircuitController extends WebSocketControllerBase {
    static name = 'short-circuit';
    static events = [
      { name: 'silent', handler: 'handle' },
      { name: 'reply', handler: 'handle' },
    ];
    constructor(options: any) {
      super(options);
      instances += 1;
    }
    handle(ctx: any) {
      return { event: ctx.event };
    }
  }
  const app = new Application({
    websocket: {
      middleware: [(ctx: any, next: any) => (ctx.event === 'silent' ? undefined : next())],
    },
  });
  app.registerWebSocketController(ShortCircuitController);
  const address = await app.listen({ port: 0 });
  const socket = await opened(`ws://${address.address}:${address.port}/websocket`);

  try {
    const response = nextMessage(socket);
    socket.send(JSON.stringify({ controller: 'short-circuit', event: 'silent', body: {} }));
    socket.send(JSON.stringify({ controller: 'short-circuit', event: 'reply', body: {} }));
    assert.deepEqual(JSON.parse(await response).body, { event: 'reply' });
    assert.equal(instances, 1);
  } finally {
    socket.close();
    await app.close();
  }
});

test('ошибки WebSocket middleware изолированы и сохраняют WebSocket-сессию', async () => {
  const errors: any[] = [];
  class ErrorController extends WebSocketControllerBase {
    static name = 'middleware-errors';
    static events = [
      { name: 'expected', handler: 'handle' },
      { name: 'unexpected', handler: 'handle' },
      { name: 'duplicate-next', handler: 'handle' },
      { name: 'healthy', handler: 'handle' },
    ];
    handle(ctx: any) {
      return { event: ctx.event };
    }
  }
  const app = new Application({
    websocket: {
      middleware: [
        async (ctx: any, next: any) => {
          if (ctx.event === 'expected') throw new WebSocketEventError('ACCESS_DENIED');
          if (ctx.event === 'unexpected') throw new Error('middleware secret');
          if (ctx.event === 'duplicate-next') {
            await next();
            return next();
          }
          return next();
        },
      ],
      onError(error: any, ctx: any) {
        errors.push({ error, ctx });
      },
    },
  });
  app.registerWebSocketController(ErrorController);
  const address = await app.listen({ port: 0 });
  const url = `ws://${address.address}:${address.port}/websocket`;
  const firstSession = await opened(url);
  const secondSession = await opened(url);

  try {
    for (const [event, code] of [
      ['expected', 'ACCESS_DENIED'],
      ['unexpected', 'HANDLER_ERROR'],
      ['duplicate-next', 'HANDLER_ERROR'],
    ]) {
      const response = nextMessage(firstSession);
      firstSession.send(JSON.stringify({ controller: 'middleware-errors', event, body: {} }));
      assert.equal(JSON.parse(await response).body.error.code, code);
      assert.equal(firstSession.readyState, WebSocket.OPEN);
    }

    const responses = [nextMessage(firstSession), nextMessage(secondSession)];
    firstSession.send(
      JSON.stringify({ controller: 'middleware-errors', event: 'healthy', body: {} }),
    );
    secondSession.send(
      JSON.stringify({ controller: 'middleware-errors', event: 'healthy', body: {} }),
    );
    assert.deepEqual(
      (await Promise.all(responses)).map((response: any) => JSON.parse(response).body),
      [{ event: 'healthy' }, { event: 'healthy' }],
    );
    assert.equal(errors.length, 2);
    assert.equal(errors[0].error.message, 'middleware secret');
    assert.ok(errors[1].error instanceof MiddlewareExecutionError);
    assert.ok(errors.every(({ ctx }: any) => Object.getPrototypeOf(ctx.state) === null));
  } finally {
    firstSession.close();
    secondSession.close();
    await app.close();
  }
});

test('WebSocket state изолирован между сессиями', async () => {
  class StateController extends WebSocketControllerBase {
    static name = 'session-state';
    static events = [{ name: 'increment', handler: 'increment' }];
    increment(ctx: any) {
      return { count: ctx.state.count };
    }
  }
  const app = new Application({
    websocket: {
      middleware: [
        (ctx: any, next: any) => {
          ctx.state.count = (ctx.state.count ?? 0) + 1;
          return next();
        },
      ],
    },
  });
  app.registerWebSocketController(StateController);
  const address = await app.listen({ port: 0 });
  const url = `ws://${address.address}:${address.port}/websocket`;
  const firstSession = await opened(url);
  const secondSession = await opened(url);

  const send = async (socket: any) => {
    const response = nextMessage(socket);
    socket.send(JSON.stringify({ controller: 'session-state', event: 'increment', body: {} }));
    return JSON.parse(await response).body.count;
  };
  try {
    assert.deepEqual(await Promise.all([send(firstSession), send(secondSession)]), [1, 1]);
    assert.equal(await send(firstSession), 2);
  } finally {
    firstSession.close();
    secondSession.close();
    await app.close();
  }
});

test('WebSocket middleware используют снимки и не выполняются до маршрутизации', async () => {
  let calls = 0;
  const applicationMiddleware = [
    (_ctx: any, next: any) => {
      calls += 1;
      return next();
    },
  ];
  const controllerMiddleware = [(_ctx: any, next: any) => next()];
  const eventMiddleware = [(_ctx: any, next: any) => next()];
  class SnapshotMiddlewareController extends WebSocketControllerBase {
    static name = 'snapshot-middleware';
    static middleware = controllerMiddleware;
    static events = [{ name: 'run', handler: 'run', middleware: eventMiddleware }];
    run() {
      return { ok: true };
    }
  }
  const app = new Application({ websocket: { middleware: applicationMiddleware } });
  app.registerWebSocketController(SnapshotMiddlewareController);
  applicationMiddleware.push(() => ({ changed: true }));
  controllerMiddleware.push(() => ({ changed: true }));
  eventMiddleware.push(() => ({ changed: true }));
  SnapshotMiddlewareController.events[0].middleware = [() => ({ changed: true })];
  const address = await app.listen({ port: 0 });
  const socket = await opened(`ws://${address.address}:${address.port}/websocket`);

  try {
    for (const [message, code] of [
      [
        { controller: 'snapshot-middleware', event: 'run', body: {}, extra: true },
        'INVALID_MESSAGE',
      ],
      [{ controller: 'missing', event: 'run', body: {} }, 'UNKNOWN_CONTROLLER'],
      [{ controller: 'snapshot-middleware', event: 'missing', body: {} }, 'UNKNOWN_EVENT'],
    ]) {
      const response = nextMessage(socket);
      socket.send(JSON.stringify(message));
      assert.equal(JSON.parse(await response).body.error.code, code);
    }
    assert.equal(calls, 0);

    const response = nextMessage(socket);
    socket.send(JSON.stringify({ controller: 'snapshot-middleware', event: 'run', body: {} }));
    assert.deepEqual(JSON.parse(await response).body, { ok: true });
    assert.equal(calls, 1);
  } finally {
    socket.close();
    await app.close();
  }
});

test('WebSocket middleware выполняются на трёх уровнях с состоянием WebSocket-сессии', async () => {
  const calls: any[] = [];
  const messageContexts: any[] = [];
  let connectContext: any;
  let disconnectContext: any;
  let disconnected: any;
  const disconnectCalled = new Promise<any>((resolve: any) => {
    disconnected = resolve;
  });
  const middleware = (name: any) =>
    async function (this: any, ctx: any, next: any) {
      assert.equal(this, undefined);
      messageContexts.push(ctx);
      calls.push(`${name}:before`);
      ctx.state[name] = (ctx.state[name] ?? 0) + 1;
      const result = await next();
      calls.push(`${name}:after`);
      return result;
    };

  class MiddlewareController extends WebSocketControllerBase {
    static name = 'middleware';
    static middleware = [middleware('controller')];
    static events = [
      {
        name: 'run',
        handler: 'run',
        middleware: [middleware('event')],
      },
    ];
    run(ctx: any) {
      messageContexts.push(ctx);
      calls.push('handler');
      return { state: ctx.state, controller: ctx.controller, event: ctx.event };
    }
  }

  const app = new Application({
    websocket: {
      middleware: [middleware('application')],
      onConnect(ctx: any) {
        connectContext = ctx;
        ctx.state.connected = true;
      },
      onDisconnect(ctx: any) {
        disconnectContext = ctx;
        disconnected();
      },
    },
  });
  app.registerWebSocketController(MiddlewareController);
  const address = await app.listen({ port: 0 });
  const socket = await opened(`ws://${address.address}:${address.port}/websocket`);

  try {
    for (const count of [1, 2]) {
      const response = nextMessage(socket);
      socket.send(JSON.stringify({ controller: 'middleware', event: 'run', body: {} }));
      assert.deepEqual(JSON.parse(await response).body, {
        state: { connected: true, application: count, controller: count, event: count },
        controller: 'middleware',
        event: 'run',
      });
    }
    assert.deepEqual(calls, [
      'application:before',
      'controller:before',
      'event:before',
      'handler',
      'event:after',
      'controller:after',
      'application:after',
      'application:before',
      'controller:before',
      'event:before',
      'handler',
      'event:after',
      'controller:after',
      'application:after',
    ]);
    assert.ok(
      messageContexts.every(
        (ctx: any) => ctx === messageContexts[0] || ctx.state === connectContext.state,
      ),
    );
    assert.ok(messageContexts.every((ctx: any) => Object.isFrozen(ctx)));
    assert.equal(Object.getPrototypeOf(connectContext.state), null);
    assert.equal(messageContexts[0].state, connectContext.state);
  } finally {
    socket.close();
    await disconnectCalled;
    await app.close();
  }
  assert.equal(disconnectContext.state, connectContext.state);
  assert.equal(disconnectContext.signal.aborted, true);
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
  const app = new Application();
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
  const errors: any[] = [];
  const app = new Application({
    websocket: { onError: (error: any, ctx: any) => errors.push({ error, ctx }) },
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
  const errors: any[] = [];
  const app = new Application({
    websocket: { onError: (error: any, ctx: any) => errors.push({ error, ctx }) },
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
  const errors: any[] = [];
  const app = new Application({
    websocket: { onError: (error: any, ctx: any) => errors.push({ error, ctx }) },
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
  const errors: any[] = [];
  const app = new Application({
    websocket: { onError: (error: any) => errors.push(error) },
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
  const app = new Application();
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
  const app = new Application();
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
  const app = new Application();
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
  const app = new Application();
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
  const app = new Application();
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
  const errors: any[] = [];
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
    websocket: { onError: (error: any, ctx: any) => errors.push({ error, ctx }) },
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
  const errors: any[] = [];
  const app = new Application({
    websocket: {
      maxPayload: 50,
      onError: (error: any, ctx: any) => errors.push({ error, ctx }),
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
  const started: any[] = [];
  let releaseFirst: any;
  const firstBlocked = new Promise<any>((resolve: any) => {
    releaseFirst = resolve;
  });
  class QueueController extends WebSocketControllerBase {
    static name = 'queue';
    static events = [{ name: 'run', handler: 'run' }];
    async run(ctx: any) {
      started.push(`${ctx.sessionId}:${ctx.body.value}`);
      if (ctx.body.value === 'first') await firstBlocked;
      return { value: ctx.body.value };
    }
  }
  const app = new Application();
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
      started.some((entry: any) => entry.endsWith(':second')),
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
  const app = new Application();
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
  const disconnects: any[] = [];
  let disconnected: any;
  const disconnectCalled = new Promise<any>((resolve: any) => {
    disconnected = resolve;
  });
  const app = new Application({
    websocket: {
      onDisconnect(ctx: any) {
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
  let releaseDisconnect: any;
  const disconnectPending = new Promise<any>((resolve: any) => {
    releaseDisconnect = resolve;
  });
  const app = new Application({
    websocket: { onDisconnect: () => disconnectPending },
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
    new Promise<any>((resolve: any) => setTimeout(() => resolve('waiting'), 50)),
  ]);
  assert.equal(stateBeforeRelease, 'waiting');
  assert.equal(applicationClosed, false);
  releaseDisconnect();
  await closing;
  assert.equal(applicationClosed, true);
});

test('Application.close принудительно завершает WebSocket peer без ответного close', async () => {
  const app = new Application({ websocket: { shutdownTimeout: 10 } });
  const address = await app.listen({ port: 0 });
  const socket = net.connect({
    allowHalfOpen: true,
    host: address.address,
    port: address.port,
  });
  const upgraded = new Promise<any>((resolve: any, reject: any) => {
    socket.once('connect', () =>
      socket.write(
        'GET /websocket HTTP/1.1\r\n' +
          'Host: localhost\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          'Sec-WebSocket-Protocol: daevox.v1\r\n\r\n',
      ),
    );
    socket.once('data', (data: any) => {
      assert.match(data.toString(), /^HTTP\/1\.1 101 Switching Protocols/);
      resolve();
    });
    socket.once('error', reject);
  });

  await upgraded;
  const closing = app.close();
  const result = await Promise.race([
    closing.then(() => 'closed'),
    new Promise<any>((resolve: any) => setTimeout(resolve, 100, 'timeout')),
  ]);
  socket.destroy();
  await closing;

  assert.equal(result, 'closed');
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

  let app = new Application({ websocket: { maxPayload: 80 } });
  app.registerWebSocketController(LargeController);
  let address = await app.listen({ port: 0 });
  let socket = await opened(`ws://${address.address}:${address.port}/websocket`);
  let message = nextMessage(socket);
  socket.send(input);
  assert.equal(JSON.parse(await message).body.error.code, 'INVALID_RESPONSE');
  socket.close();
  await app.close();

  app = new Application({ websocket: { maxPayload: 70 } });
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
    echo(ctx: any) {
      return { value: ctx.body.value };
    }
  }
  const app = new Application();
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
  const errors: any[] = [];
  let app = new Application({
    websocket: {
      onConnect() {
        throw connectError;
      },
      onError: (error: any, ctx: any) => errors.push({ error, ctx }),
    },
  });
  app.registerWebSocketController(notificationsController());
  let address = await app.listen({ port: 0 });
  assert.equal(
    await rejected(`ws://${address.address}:${address.port}/websocket`, 'daevox.v1'),
    true,
  );
  assert.ok(errors.length >= 1);
  assert.ok(errors.every(({ error }: any) => error === connectError));
  assert.ok(errors.every(({ ctx }: any) => typeof ctx.clientId === 'string'));
  await app.close();

  let errorReported: any;
  const reported = new Promise<any>((resolve: any) => {
    errorReported = resolve;
  });
  app = new Application({
    websocket: {
      onDisconnect() {
        throw disconnectError;
      },
      onError(error: any, ctx: any) {
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

test('некорректный результат onConnect отклоняет handshake с 500 и передаётся в onError', async () => {
  const errors: any[] = [];
  const app = new Application({
    websocket: {
      onConnect: () => '',
      onError: (error: any) => errors.push(error),
    },
  });
  const address = await app.listen({ port: 0 });

  try {
    assert.equal(
      await rejected(`ws://${address.address}:${address.port}/websocket`, 'daevox.v1'),
      true,
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /non-empty string/);
  } finally {
    await app.close();
  }
});

test('HttpError из onConnect ожидаемо отклоняет WebSocket handshake', async () => {
  const errors: any[] = [];
  let disconnects = 0;
  const app = new Application({
    websocket: {
      onConnect() {
        throw new HttpError(401, {
          headers: new Headers({ 'www-authenticate': 'Bearer' }),
          body: { error: 'Unauthorized' },
        });
      },
      onDisconnect() {
        disconnects += 1;
      },
      onError(error: any) {
        errors.push(error);
      },
    },
  });
  const address = await app.listen({ port: 0 });
  const { data, socket } = await rawRequest(
    address,
    `GET /websocket HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: daevox.v1\r\n\r\n`,
  );

  try {
    const response = data.toString();
    assert.match(response, /^HTTP\/1\.1 401 Unauthorized/);
    assert.match(response.toLowerCase(), /www-authenticate: bearer/);
    assert.match(response, /\{"error":"Unauthorized"\}$/);
    assert.deepEqual(errors, []);
    assert.equal(disconnects, 0);
  } finally {
    socket.destroy();
    await app.close();
  }
  assert.equal(disconnects, 0);
});

test('HttpError из onConnect сохраняет строковое и бинарное тело handshake-ответа', async () => {
  const app = new Application({
    websocket: {
      onConnect(ctx: any) {
        const binary = ctx.query.has('binary');
        throw new HttpError(403, { body: binary ? new Uint8Array([0, 1, 2]) : 'Forbidden' });
      },
    },
  });
  const address = await app.listen({ port: 0 });
  const request = (path: any) =>
    rawRequest(
      address,
      `GET ${path} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: daevox.v1\r\n\r\n`,
    );

  try {
    let response = await request('/websocket');
    assert.match(response.data.toString(), /^HTTP\/1\.1 403 Forbidden/);
    assert.match(response.data.toString().toLowerCase(), /content-type: text\/plain/);
    assert.ok(response.data.subarray(-9).equals(Buffer.from('Forbidden')));
    response.socket.destroy();

    response = await request('/websocket?binary');
    assert.match(response.data.toString(), /^HTTP\/1\.1 403 Forbidden/);
    assert.match(response.data.toString().toLowerCase(), /content-type: application\/octet-stream/);
    assert.ok(response.data.subarray(-3).equals(Buffer.from([0, 1, 2])));
    response.socket.destroy();
  } finally {
    await app.close();
  }
});

test('отклонённый Promise websocket.onError безопасно передаётся в console.error', async (t: any) => {
  const reportingError = new Error('reporting failed');
  let consoleCalled: any;
  const called = new Promise<any>((resolve: any) => {
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
    websocket: { onError: () => Promise.reject(reportingError) },
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

test('синхронная ошибка websocket.onError безопасно передаётся в console.error', async (t: any) => {
  const reportingError = new Error('reporting failed synchronously');
  let consoleCalled: any;
  const called = new Promise<any>((resolve: any) => {
    consoleCalled = resolve;
  });
  const consoleError = t.mock.method(console, 'error', () => consoleCalled());
  const app = new Application({
    websocket: {
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
