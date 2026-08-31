import assert from 'node:assert/strict';
import test from 'node:test';

import { createWebSocketApplication } from './application.ts';

function nextMessage(socket: WebSocket): Promise<unknown> {
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
    socket.addEventListener('error', reject, { once: true });
  });
}

test('WebSocket example отправляет server push из HTTP-контроллера', async () => {
  const application = createWebSocketApplication();
  const address = await application.listen({ port: 0 });
  const socket = new WebSocket(
    `ws://${address.address}:${address.port}/websocket?token=demo`,
    'daevox.v1',
  );
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('WebSocket connection failed')), {
      once: true,
    });
  });

  try {
    const message = nextMessage(socket);
    const response = await fetch(`http://${address.address}:${address.port}/broadcast`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { sent: 1, skipped: 0 });
    assert.deepEqual(await message, {
      controller: 'notifications',
      event: 'updated',
      body: { message: 'Server push from HTTP' },
    });
  } finally {
    socket.close();
    await application.close();
  }
});
