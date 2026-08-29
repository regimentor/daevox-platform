import { once } from 'node:events';

// oxlint-disable typescript/no-extraneous-class -- DTO classes intentionally provide nominal identity.
import { Application } from 'daevox-node-framework/lib/framework/Application.js';
import { EventListenerBase } from 'daevox-node-framework/lib/framework/EventListenerBase.js';
import { HttpControllerBase } from 'daevox-node-framework/lib/framework/HttpControllerBase.js';
import { WebSocketControllerBase } from 'daevox-node-framework/lib/framework/WebSocketControllerBase.js';
import { HttpError } from 'daevox-node-framework/lib/framework/errors.js';
import SumJob from './sum-job.js';

const applicationEvents = [];
const applicationEventErrors = [];
const eventFlow = {
  accepted: [],
  errors: [],
  fast: [],
  independent: false,
  slowCompleted: [],
  slowInvoked: [],
};
let acceptedOrder = 0;
let releaseFirstSlow;
const firstSlowGate = new Promise((resolve) => {
  releaseFirstSlow = resolve;
});
let resolveFastFirst;
const fastFirst = new Promise((resolve) => {
  resolveFastFirst = resolve;
});
let resolveSlowFirst;
const slowFirst = new Promise((resolve) => {
  resolveSlowFirst = resolve;
});
let resolveApplicationEvents;
const applicationEventsSettled = new Promise((resolve) => {
  resolveApplicationEvents = resolve;
});

function settleApplicationEvents() {
  if (applicationEvents.length === 3 && applicationEventErrors.length === 1) {
    resolveApplicationEvents();
  }
}

class TransportEvent {
  constructor(source) {
    this.source = source;
  }
}

class TransportEventListener extends EventListenerBase {
  static name = 'transport-audit';
  static events = [{ name: 'handled', data: TransportEvent, handler: 'handled' }];

  handled(data) {
    applicationEvents.push(data.source);
    settleApplicationEvents();
    if (data.source === 'websocket') throw new Error('isolated listener failure');
  }
}

class BatchEvent {
  constructor(order, poison) {
    this.order = order;
    this.poison = poison;
  }
}

class FastBatchListener extends EventListenerBase {
  static name = 'batch-fast';
  static events = [{ name: 'handled', data: BatchEvent, handler: 'handled' }];

  handled(data) {
    eventFlow.fast.push(data.order);
    if (data.order === 0) resolveFastFirst();
  }
}

class SlowBatchListener extends EventListenerBase {
  static name = 'batch-slow';
  static events = [{ name: 'handled', data: BatchEvent, handler: 'handled' }];

  async handled(data) {
    eventFlow.slowInvoked.push(data.order);
    if (data.order === 0) {
      resolveSlowFirst();
      await firstSlowGate;
    } else {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    if (data.poison) throw new Error('batch poison');
    eventFlow.slowCompleted.push(data.order);
  }
}

function pushBatchEvent(sender, poison) {
  const order = acceptedOrder++;
  const event = new BatchEvent(order, poison === true);
  sender.push({ listener: 'batch-slow', event: 'handled' }, event);
  sender.push({ listener: 'batch-fast', event: 'handled' }, event);
  return order;
}

function markHttpController(ctx, next) {
  ctx.state.controller = true;
  return next();
}

function markHttpRoute(ctx, next) {
  ctx.state.route = ctx.route.path;
  return next();
}

class CalculationsHttpController extends HttpControllerBase {
  static prefix = '/calculations';
  static middleware = [markHttpController];
  static routes = [
    { method: 'POST', path: '/sum', handler: 'sum', middleware: [markHttpRoute] },
    { method: 'POST', path: '/event', handler: 'event' },
  ];

  event(ctx) {
    return {
      status: 202,
      body: { acceptedOrder: pushBatchEvent(this.events, ctx.body?.poison) },
    };
  }

  async sum(ctx) {
    const values = ctx.body?.values;
    if (!Array.isArray(values) || values.some((value) => !Number.isFinite(value))) {
      throw new HttpError(422, {
        body: { error: 'values must be finite numbers' },
      });
    }

    const result = await this.jobRunner.run(SumJob, { values }, { signal: ctx.signal });
    this.events.push(
      { listener: 'transport-audit', event: 'handled' },
      new TransportEvent(`http:${result.sum}`),
    );
    return { status: 200, body: { ...result, state: ctx.state } };
  }
}

function markWebSocketController(ctx, next) {
  ctx.state.controller = true;
  return next();
}

function markWebSocketEvent(ctx, next) {
  ctx.state.event = ctx.event;
  return next();
}

class EventsWebSocketController extends WebSocketControllerBase {
  static name = 'events';
  static middleware = [markWebSocketController];
  static events = [
    { name: 'echo', handler: 'echo', middleware: [markWebSocketEvent] },
    { name: 'publish', handler: 'publish' },
    { name: 'short-circuit', handler: 'echo' },
    { name: 'fail', handler: 'echo' },
  ];

  echo(ctx) {
    this.events.push(
      { listener: 'transport-audit', event: 'handled' },
      new TransportEvent('websocket'),
    );
    return { message: ctx.body.message, state: ctx.state };
  }

  publish(ctx) {
    return { acceptedOrder: pushBatchEvent(this.events, ctx.body?.poison) };
  }
}

async function readJson(response) {
  return { status: response.status, body: await response.json() };
}

async function receiveMessage(webSocket) {
  const [event] = await once(webSocket, 'message', {
    signal: AbortSignal.timeout(2_000),
  });
  return JSON.parse(String(event.data));
}

const application = new Application({
  events: {
    onError(error) {
      if (error.message === 'batch poison') eventFlow.errors.push(error.message);
      else {
        applicationEventErrors.push(error.message);
        settleApplicationEvents();
      }
    },
  },
  jobs: { poolSize: 1 },
  http: {
    middleware: [
      (ctx, next) => {
        const mode = ctx.headers.get('x-middleware-mode');
        if (mode === 'short-circuit') {
          return { status: 401, body: { error: 'Middleware short-circuit' } };
        }
        if (mode === 'fail') throw new Error('HTTP middleware failure');
        ctx.state.application = true;
        return next();
      },
    ],
  },
  websocket: {
    middleware: [
      (ctx, next) => {
        ctx.state.messageCount = (ctx.state.messageCount ?? 0) + 1;
        if (ctx.event === 'short-circuit') return { shortCircuit: true };
        if (ctx.event === 'fail') throw new Error('WebSocket middleware failure');
        return next();
      },
    ],
  },
});
application.registerHttpController(CalculationsHttpController);
application.registerWebSocketController(EventsWebSocketController);
application.registerEventListener(TransportEventListener);
application.registerEventListener(FastBatchListener);
application.registerEventListener(SlowBatchListener);

let webSocket;
const batchWebSockets = [];

try {
  const address = await application.listen({ port: 0 });
  const httpUrl = `http://${address.address}:${address.port}`;
  const websocketUrl = `ws://${address.address}:${address.port}/websocket`;

  webSocket = new WebSocket(websocketUrl, 'daevox.v1');
  await once(webSocket, 'open', { signal: AbortSignal.timeout(2_000) });

  webSocket.send(JSON.stringify({ controller: 'events', event: 'missing', body: {} }));
  const websocketErrorMessage = await receiveMessage(webSocket);

  let websocketMessagePromise = receiveMessage(webSocket);
  webSocket.send(JSON.stringify({ controller: 'events', event: 'short-circuit', body: {} }));
  const websocketShortCircuitMessage = await websocketMessagePromise;

  websocketMessagePromise = receiveMessage(webSocket);
  webSocket.send(JSON.stringify({ controller: 'events', event: 'fail', body: {} }));
  const websocketFailureMessage = await websocketMessagePromise;

  websocketMessagePromise = receiveMessage(webSocket);
  webSocket.send(
    JSON.stringify({
      controller: 'events',
      event: 'echo',
      body: { message: 'hello from tarball' },
    }),
  );
  const httpResponsePromise = fetch(`${httpUrl}/calculations/sum`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values: [1, 2, 3] }),
  }).then(readJson);

  const [http, websocketMessage] = await Promise.all([
    httpResponsePromise,
    websocketMessagePromise,
  ]);
  const httpError = await fetch(`${httpUrl}/calculations/sum`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values: ['invalid'] }),
  }).then(readJson);
  const httpShortCircuit = await fetch(`${httpUrl}/calculations/sum`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-middleware-mode': 'short-circuit',
    },
    body: JSON.stringify({ values: [1] }),
  }).then(readJson);
  const httpFailure = await fetch(`${httpUrl}/calculations/sum`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-middleware-mode': 'fail' },
    body: JSON.stringify({ values: [1] }),
  }).then(readJson);
  const httpRecovery = await fetch(`${httpUrl}/calculations/sum`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values: [4, 5] }),
  }).then(readJson);
  await applicationEventsSettled;

  const firstBatch = await fetch(`${httpUrl}/calculations/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ poison: true }),
  }).then(readJson);
  await Promise.all([fastFirst, slowFirst]);
  eventFlow.independent = true;
  releaseFirstSlow();

  for (let index = 0; index < 4; index += 1) {
    const socket = new WebSocket(websocketUrl, 'daevox.v1');
    batchWebSockets.push(socket);
    await once(socket, 'open', { signal: AbortSignal.timeout(2_000) });
  }
  const httpBatch = Array.from({ length: 3 }, () =>
    fetch(`${httpUrl}/calculations/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).then(readJson),
  );
  const websocketBatch = batchWebSockets.map(async (socket) => {
    const message = receiveMessage(socket);
    socket.send(JSON.stringify({ controller: 'events', event: 'publish', body: {} }));
    return message;
  });
  const batchResults = await Promise.all([...httpBatch, ...websocketBatch]);
  eventFlow.accepted = [
    firstBatch.body.acceptedOrder,
    ...batchResults.map((result) => result.body.acceptedOrder),
  ].toSorted((left, right) => left - right);

  const closePromise = once(webSocket, 'close', {
    signal: AbortSignal.timeout(2_000),
  });
  webSocket.close(1000);
  await closePromise;
  await Promise.all(
    batchWebSockets.map(async (socket) => {
      const closed = once(socket, 'close', { signal: AbortSignal.timeout(2_000) });
      socket.close(1000);
      await closed;
    }),
  );
  await application.close();

  process.stdout.write(
    JSON.stringify({
      http,
      httpError,
      httpFailure,
      httpRecovery,
      httpShortCircuit,
      websocketError: websocketErrorMessage.body.error,
      websocketFailure: websocketFailureMessage.body.error,
      websocketShortCircuit: websocketShortCircuitMessage.body,
      websocket: websocketMessage.body,
      applicationEvents: {
        handled: applicationEvents.toSorted(),
        errors: applicationEventErrors,
      },
      eventFlow,
    }),
  );
} finally {
  if (webSocket && webSocket.readyState !== WebSocket.CLOSED) webSocket.close();
  for (const socket of batchWebSockets) {
    if (socket.readyState !== WebSocket.CLOSED) socket.close();
  }
  releaseFirstSlow();
  await application.close();
}
