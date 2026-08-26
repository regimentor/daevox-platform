import { once } from 'node:events';
import { Application } from 'daevox-node-framework/lib/framework/Application.js';
import { HttpControllerBase } from 'daevox-node-framework/lib/framework/HttpControllerBase.js';
import { WebSocketControllerBase } from 'daevox-node-framework/lib/framework/WebSocketControllerBase.js';
import { HttpError } from 'daevox-node-framework/lib/framework/errors.js';
import SumJob from './sum-job.js';

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
  static routes = [{ method: 'POST', path: '/sum', handler: 'sum', middleware: [markHttpRoute] }];

  async sum(ctx) {
    const values = ctx.body?.values;
    if (!Array.isArray(values) || values.some((value) => !Number.isFinite(value))) {
      throw new HttpError(422, {
        body: { error: 'values must be finite numbers' },
      });
    }

    const result = await this.jobRunner.run(SumJob, { values }, { signal: ctx.signal });
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
    { name: 'short-circuit', handler: 'echo' },
    { name: 'fail', handler: 'echo' },
  ];

  echo(ctx) {
    return { message: ctx.body.message, state: ctx.state };
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

let webSocket;

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

  const closePromise = once(webSocket, 'close', {
    signal: AbortSignal.timeout(2_000),
  });
  webSocket.close(1000);
  await closePromise;

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
    }),
  );
} finally {
  if (webSocket && webSocket.readyState !== WebSocket.CLOSED) webSocket.close();
  await application.close();
}
