import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSnapshot } from '@daevox/telegram-contract';
import type { Action } from '@daevox/telegram-contract';
import { TelegramConnection, CommandError } from '../src/domain/telegram/connection.ts';
import { ControlledTelegram, parameters, turn } from './support/controlled-telegram.ts';

async function setup(initial?: object) {
  const clients: ControlledTelegram[] = [];
  const service = new TelegramConnection({
    parameters,
    createClient: () => {
      const mock = new ControlledTelegram(clients.length ? undefined : initial);
      clients.push(mock);
      return mock.client();
    },
  });
  await service.start();
  const command = (action: Action, password?: string) => {
    const { instanceId, controlVersion } = service.snapshot();
    return service.accept(action, {
      expected: { instanceId, controlVersion },
      ...(password ? { password } : {}),
    });
  };
  return { service, clients, mock: clients[0]!, command };
}
const qr = (token = 'dGVzdA') => ({
  '@type': 'authorizationStateWaitOtherDeviceConfirmation',
  link: `tg://login?token=${token}`,
});
const auth = (name: string) => ({ '@type': `authorizationState${name}` });

test('QR admission, rotation, password error, rate limit and Ready are observable snapshots', async (t) => {
  const { service, mock, command } = await setup();
  t.after(() => service.close());
  const old = service.snapshot();
  command('connect');
  assert.equal(mock.count('requestQrCodeAuthentication'), 0);
  assert.throws(() => service.accept('connect', { expected: old }), CommandError);
  await turn();
  mock.result('requestQrCodeAuthentication');
  await turn();
  assert.equal(service.snapshot().operation?.status, 'pending');
  mock.auth(qr());
  await turn();
  assert.equal(service.snapshot().operation?.status, 'completed');
  const version = service.snapshot().controlVersion;
  mock.auth(qr('cm90YXRlZA'));
  await turn();
  assert.equal(service.snapshot().controlVersion, version);
  assert.deepEqual(service.snapshot().authorization, {
    kind: 'qr',
    link: 'tg://login?token=cm90YXRlZA',
  });
  mock.network('connectionStateWaitingForNetwork');
  await turn();
  assert.deepEqual(service.snapshot().authorization, { kind: 'qr', link: null });
  mock.network('connectionStateReady');
  await turn();
  assert.deepEqual(service.snapshot().authorization, { kind: 'qr', link: null });
  mock.auth(auth('WaitPassword'));
  await turn();
  command('submit_password', 'private-password');
  await turn();
  assert.ok(!JSON.stringify(service.snapshot()).includes('private-password'));
  mock.result('checkAuthenticationPassword', {
    '@type': 'error',
    code: 400,
    message: 'PASSWORD_HASH_INVALID',
  });
  await turn();
  assert.equal(service.snapshot().error?.code, 'invalid_password');
  command('submit_password', 'private-password');
  await turn();
  mock.result('checkAuthenticationPassword', {
    '@type': 'error',
    code: 429,
    message: 'Too Many Requests: retry after 1',
  });
  await turn();
  assert.equal(service.snapshot().error?.code, 'rate_limited');
  assert.deepEqual(service.snapshot().allowedActions, []);
  mock.auth(auth('Ready'));
  await turn();
  assert.equal(service.snapshot().error, null);
  assert.equal(service.snapshot().authorization.kind, 'connected');
  mock.network('connectionStateWaitingForNetwork');
  await turn();
  assert.equal(service.snapshot().authorization.kind, 'connected');
  assert.equal(isSnapshot(service.snapshot()), true);
});

test('QR login without 2FA and logout waits for Closed and resource release before replacement', async (t) => {
  const { service, mock, command, clients } = await setup();
  t.after(() => service.close());
  command('connect');
  await turn();
  mock.auth(qr());
  await turn();
  mock.auth(auth('Ready'));
  await turn();
  command('disconnect');
  await turn();
  mock.result('logOut');
  await turn();
  assert.equal(service.snapshot().operation?.status, 'pending');
  assert.equal(service.snapshot().authorization.kind, 'connected');
  mock.auth(auth('LoggingOut'));
  await turn();
  let release!: () => void;
  mock.destroyGate = new Promise((resolve) => {
    release = resolve;
  });
  mock.auth(auth('Closed'));
  await turn();
  assert.equal(clients.length, 1);
  assert.equal(service.snapshot().operation?.status, 'pending');
  release();
  await turn();
  await turn();
  assert.equal(clients.length, 2);
  assert.equal(mock.destroyed, true);
  assert.equal(service.snapshot().authorization.kind, 'not_connected');
  mock.auth(qr('b2xk'));
  await turn();
  assert.equal(service.snapshot().authorization.kind, 'not_connected');
  command('connect');
  await turn();
  assert.equal(clients[1]!.count('requestQrCodeAuthentication'), 1);
});

for (const [initial, kind] of [
  ['Ready', 'connected'],
  ['WaitPassword', 'password'],
  ['LoggingOut', 'logging_out'],
  ['WaitPhoneNumber', 'not_connected'],
  ['WaitEmailAddress', 'unsupported'],
] as const) {
  test(`startup respects restored ${initial} without replaying commands`, async (t) => {
    const { service, mock } = await setup(auth(initial));
    t.after(() => service.close());
    assert.equal(service.snapshot().authorization.kind, kind);
    assert.equal(mock.count('requestQrCodeAuthentication'), 0);
    assert.equal(mock.count('logOut'), 0);
  });
}

test('QR is restored by a current-state read and graceful close sends close, never logOut', async () => {
  const { service, mock } = await setup(qr());
  assert.equal(service.snapshot().authorization.kind, 'qr');
  await service.close();
  assert.equal(mock.count('close'), 1);
  assert.equal(mock.count('logOut'), 0);
});

test('late initial snapshot cannot roll back a newer authorization update', async (t) => {
  const mock = new ControlledTelegram();
  let resolve!: () => void;
  mock.stateGate = new Promise((done) => {
    resolve = done;
  });
  const service = new TelegramConnection({ parameters, createClient: () => mock.client() });
  t.after(() => service.close());
  const start = service.start();
  await turn();
  mock.auth(auth('Ready'));
  await turn();
  resolve();
  await start;
  assert.equal(service.snapshot().authorization.kind, 'connected');
});

test('configuration error remains readable and all command errors are safe', async () => {
  const service = new TelegramConnection({ parameters: null });
  await service.start();
  assert.equal(service.snapshot().client, 'configuration_required');
  assert.equal(isSnapshot(service.snapshot()), true);
  assert.throws(() => service.accept('connect', { expected: service.snapshot() }), { status: 503 });
  await service.close();
});

test('fatal failure releases the old client before permitting an explicit restart', async (t) => {
  const { service, mock, clients, command } = await setup();
  t.after(() => service.close());
  let release!: () => void;
  mock.destroyGate = new Promise((done) => {
    release = done;
  });
  mock.handlers!.onFatal(new Error('secret native payload'));
  await turn();
  assert.equal(service.snapshot().client, 'failed');
  assert.ok(!JSON.stringify(service.snapshot()).includes('secret'));
  assert.deepEqual(service.snapshot().allowedActions, []);
  release();
  await turn();
  await turn();
  assert.deepEqual(service.snapshot().allowedActions, ['restart']);
  command('restart');
  await turn();
  await turn();
  assert.equal(clients.length, 2);
  assert.equal(service.snapshot().authorization.kind, 'not_connected');
});

test('shutdown during a pending initial state read releases the client instead of waiting forever', async () => {
  const mock = new ControlledTelegram();
  mock.stateGate = new Promise(() => {});
  const service = new TelegramConnection({ parameters, createClient: () => mock.client() });
  void service.start();
  await turn();
  await service.close();
  assert.equal(mock.destroyed, true);
});

test('shutdown during transport startup waits until the handle can be safely released', async () => {
  const mock = new ControlledTelegram();
  let open!: () => void;
  mock.startGate = new Promise((resolve) => {
    open = resolve;
  });
  const service = new TelegramConnection({ parameters, createClient: () => mock.client() });
  void service.start();
  const closed = service.close();
  await turn();
  assert.equal(mock.destroyed, false);
  open();
  await closed;
  assert.equal(mock.destroyed, true);
  assert.equal(mock.count('setTdlibParameters'), 0);
});

test('metadata errors and late command failures do not revert Ready or expose native data', async (t) => {
  const { service, mock, command } = await setup();
  t.after(() => service.close());
  command('connect');
  await turn();
  mock.auth(auth('Ready'));
  await turn();
  mock.result('requestQrCodeAuthentication', {
    '@type': 'error',
    code: 500,
    message: 'private-native-error',
  });
  await turn();
  assert.equal(service.snapshot().authorization.kind, 'connected');
  assert.equal(service.snapshot().operation?.status, 'completed');
  assert.equal(service.snapshot().error, null);
});

test('failed account metadata leaves the session connected and remote revocation permits a new login', async (t) => {
  const { service, mock } = await setup();
  t.after(() => service.close());
  mock.metadataError = true;
  mock.auth(auth('Ready'));
  await turn();
  assert.deepEqual(service.snapshot().authorization, { kind: 'connected', account: null });
  assert.equal(service.snapshot().error, null);
  mock.auth(auth('WaitPhoneNumber'));
  await turn();
  assert.equal(service.snapshot().authorization.kind, 'not_connected');
  assert.deepEqual(service.snapshot().allowedActions, ['connect']);
  assert.equal(
    service.snapshot().error?.message,
    'Сессия Telegram завершена. Подключите аккаунт снова.',
  );
});
