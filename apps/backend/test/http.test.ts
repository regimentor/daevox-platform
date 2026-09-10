import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { isSnapshot } from '@daevox/telegram-contract';
import { AppState } from '../src/app-state.ts';
import { createApplication } from '../src/application.ts';
import { TelegramConnection } from '../src/domain/telegram/connection.ts';
import { ControlledTelegram, parameters, turn } from './support/controlled-telegram.ts';
import { testDatabase } from '@daevox/db/testing';

const origin = 'http://127.0.0.1:5173';
test('real local HTTP admission, CORS, validation and command races', async (t) => {
  const database = testDatabase();
  const mock = new ControlledTelegram();
  const telegram = new TelegramConnection({ parameters, createClient: () => mock.client() });
  class State extends AppState {
    constructor() {
      super(telegram, origin, database.url);
    }
  }
  const app = createApplication(State);
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await app.close();
    database.cleanup();
  });
  await telegram.start();
  const base = `http://127.0.0.1:${address.port}/api/telegram`;
  const get = await fetch(`${base}/state`, { headers: { Origin: origin } });
  const state = await get.json();
  assert.ok(isSnapshot(state));
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('cache-control'), 'no-store');
  assert.equal(get.headers.get('access-control-allow-origin'), origin);
  assert.equal(get.headers.get('access-control-allow-credentials'), null);
  const options = await fetch(`${base}/connect`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  assert.equal(options.status, 204);
  for (const badOrigin of [
    'https://evil.invalid',
    'null',
    'http://127.0.0.1:9999',
    'http://127.0.0.1:5173.evil.invalid',
  ]) {
    const result = await fetch(`${base}/state`, { headers: { Origin: badOrigin } });
    assert.equal(result.status, 403);
    assert.equal(result.headers.get('access-control-allow-origin'), null);
  }
  const hostileHost = await new Promise<number>((resolve) => {
    const req = request(`${base}/state`, { headers: { Host: 'evil.invalid' } }, (response) => {
      response.resume();
      resolve(response.statusCode!);
    });
    req.end();
  });
  assert.equal(hostileHost, 403);
  const post = (body: unknown, contentType = 'application/json') =>
    fetch(`${base}/connect`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': contentType },
      body: JSON.stringify(body),
    });
  const expected = { instanceId: state.instanceId, controlVersion: state.controlVersion };
  for (const body of [
    { expected, extra: true },
    { expected: { ...expected, controlVersion: '0' } },
    null,
  ]) {
    const result = await post(body);
    assert.equal(result.status, 400);
    assert.equal(result.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await post({ expected }, 'text/plain')).status, 400);
  assert.equal(
    (await post({ expected: { ...expected, instanceId: 'previous-backend' } })).status,
    409,
  );
  const results = await Promise.all([post({ expected }), post({ expected })]);
  assert.deepEqual(results.map((result) => result.status).toSorted(), [202, 409]);
  await turn();
  assert.equal(mock.count('requestQrCodeAuthentication'), 1);
  assert.equal(telegram.snapshot().operation?.status, 'pending');
  mock.result('requestQrCodeAuthentication', {
    '@type': 'error',
    code: 500,
    message: 'secret native data',
  });
  await turn();
  const failed = await (await fetch(`${base}/state`)).text();
  assert.ok(!failed.includes('secret native data'));
  assert.ok(failed.includes('telegram_error'));
});

test('HTTP remains healthy while Telegram starts and without configuration', async (t) => {
  const database = testDatabase();
  const telegram = new TelegramConnection({ parameters: null });
  class State extends AppState {
    constructor() {
      super(telegram, origin, database.url);
    }
  }
  const app = createApplication(State);
  const address = await app.listen({ port: 0 });
  t.after(async () => {
    await app.close();
    database.cleanup();
  });
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/healthcheck`)).status, 200);
  const state = await (await fetch(`${base}/api/telegram/state`)).json();
  assert.ok(isSnapshot(state));
  assert.equal(state.client, 'configuration_required');
  const response = await fetch(`${base}/api/telegram/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expected: { instanceId: state.instanceId, controlVersion: state.controlVersion },
    }),
  });
  assert.equal(response.status, 503);
  assert.equal((await fetch(`${base}/auth/login`, { method: 'POST' })).status, 404);
});
