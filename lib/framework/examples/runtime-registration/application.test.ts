import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeRegistrationApplication, runtimeEvents } from './application.ts';

function openWebSocket(url: string) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, 'daevox.v1');
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', () => reject(new Error('WebSocket connection failed')), {
      once: true,
    });
  });
}

function nextMessage(socket: WebSocket) {
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket message timeout')), 1_000);
    socket.addEventListener(
      'message',
      (event: MessageEvent<string>) => {
        clearTimeout(timer);
        resolve(JSON.parse(event.data));
      },
      { once: true },
    );
  });
}

test('runtime registration example publishes HTTP, WebSocket and event resources', async () => {
  const application = createRuntimeRegistrationApplication();
  const address = await application.listen({ port: 0 });

  try {
    const registerResponse = await fetch(
      `http://${address.address}:${address.port}/runtime/register`,
      { method: 'POST' },
    );
    assert.equal(registerResponse.status, 201);
    assert.deepEqual(await registerResponse.json(), { registered: true });

    const socket = await openWebSocket(`ws://${address.address}:${address.port}/websocket`);
    const httpResponse = await fetch(`http://${address.address}:${address.port}/runtime/status`);
    assert.equal(httpResponse.status, 200);
    assert.deepEqual(await httpResponse.json(), { resource: 'http', registered: 'runtime' });

    socket.send(JSON.stringify({ controller: 'runtime', event: 'ping', body: {} }));
    assert.deepEqual(await nextMessage(socket), {
      controller: 'runtime',
      event: 'ping',
      body: { resource: 'websocket', registered: 'runtime' },
    });

    const eventResponse = await fetch(`http://${address.address}:${address.port}/runtime/event`, {
      method: 'POST',
    });
    assert.equal(eventResponse.status, 202);
    for (let attempt = 0; attempt < 20 && runtimeEvents.length === 0; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(runtimeEvents.pop(), 'event delivered after runtime registration');
    socket.close();
  } finally {
    await application.close();
  }
});
