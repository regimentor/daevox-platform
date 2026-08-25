import { once } from 'node:events';
import { Application } from 'daevox-node-framework/lib/framework/Application.js';
import { HttpControllerBase } from 'daevox-node-framework/lib/framework/HttpControllerBase.js';
import { WebSocketControllerBase } from 'daevox-node-framework/lib/framework/WebSocketControllerBase.js';
import { HttpError } from 'daevox-node-framework/lib/framework/errors.js';
import SumJob from './sum-job.js';

class CalculationsHttpController extends HttpControllerBase {
  static prefix = '/calculations';
  static routes = [{ method: 'POST', path: '/sum', handler: 'sum', authentication: false }];

  async sum(ctx) {
    const values = ctx.body?.values;
    if (!Array.isArray(values) || values.some((value) => !Number.isFinite(value))) {
      throw new HttpError(422, {
        body: { error: 'values must be finite numbers' },
      });
    }

    const result = await this.jobRunner.run(SumJob, { values }, { signal: ctx.signal });
    return { status: 200, body: result };
  }
}

class EventsWebSocketController extends WebSocketControllerBase {
  static name = 'events';
  static events = [{ name: 'echo', handler: 'echo' }];

  echo(ctx) {
    return { message: ctx.body.message };
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
  websocket: { authentication: false },
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

  const websocketMessagePromise = receiveMessage(webSocket);
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

  const closePromise = once(webSocket, 'close', {
    signal: AbortSignal.timeout(2_000),
  });
  webSocket.close(1000);
  await closePromise;

  process.stdout.write(
    JSON.stringify({
      http,
      httpError,
      websocketError: websocketErrorMessage.body.error,
      websocket: websocketMessage.body,
    }),
  );
} finally {
  if (webSocket && webSocket.readyState !== WebSocket.CLOSED) webSocket.close();
  await application.close();
}
