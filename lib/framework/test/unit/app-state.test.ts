import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { Application } from '../../src/Application.ts';
import { HttpControllerBase } from '../../src/HttpControllerBase.ts';

function request(address: any) {
  return new Promise<string>((resolve, reject) => {
    http
      .get({ host: address.address, port: address.port, path: '/' }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks).toString()));
      })
      .on('error', reject);
  });
}

test('Application передаёт один AppState первым аргументом HTTP execution path', async () => {
  let constructions = 0;
  const seen: object[] = [];

  class State {
    readonly marker = undefined;

    constructor() {
      constructions += 1;
    }
  }

  const middleware = (state: object, context: object, next: () => Promise<unknown>) => {
    assert.ok(context);
    seen.push(state);
    return next() as Promise<any>;
  };

  class Controller extends HttpControllerBase {
    static prefix = '/';
    static routes = [{ method: 'GET', path: '/', handler: 'get' }] as const;

    get(state: object, _context: object) {
      seen.push(state);
      return { status: 200, body: { ok: true } };
    }
  }

  const application = new Application({ appState: State, http: { middleware: [middleware] } });
  application.registerHttpController(Controller);
  const address = await application.listen({ host: '127.0.0.1', port: 0 });

  try {
    assert.equal(await request(address), '{"ok":true}');
    assert.equal(constructions, 1);
    assert.equal(seen.length, 2);
    assert.equal(seen[0], seen[1]);
  } finally {
    await application.close();
  }
});

test('Application выполняет AppState lifecycle hooks в порядке запуска и закрытия', async () => {
  const calls: string[] = [];

  class State {
    async beforeAppStart() {
      calls.push('before');
    }

    async onAppStart() {
      calls.push('start');
    }

    async onAppClose() {
      calls.push('close');
    }
  }

  const application = new Application({ appState: State });
  const address = await application.listen({ host: '127.0.0.1', port: 0 });

  assert.ok(address.port > 0);
  assert.deepEqual(calls, ['before', 'start']);

  await application.close();
  assert.deepEqual(calls, ['before', 'start', 'close']);
});

test('Application продолжает shutdown после ошибки onAppClose и возвращает её', async () => {
  const calls: string[] = [];
  const closeError = new Error('close failed');

  class State {
    onAppClose() {
      calls.push('close');
      throw closeError;
    }
  }

  const application = new Application({ appState: State });
  await assert.rejects(application.close(), closeError);
  assert.deepEqual(calls, ['close']);
  await assert.rejects(application.listen({ host: '127.0.0.1', port: 0 }));
});
