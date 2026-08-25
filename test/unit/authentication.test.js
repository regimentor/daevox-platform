import assert from 'node:assert/strict';
import test from 'node:test';

import { createAuthentication, isAuthentication } from '../../lib/framework/Authentication.js';
import {
  AuthenticationAbortedError,
  AuthenticationStrategyError,
  InvalidAuthenticationOptionsError,
  InvalidAuthenticationResultError,
} from '../../lib/framework/errors.js';

function httpInput(overrides = {}) {
  return {
    transport: 'http',
    method: 'GET',
    path: '/resource',
    headers: new Headers({ authorization: 'Bearer token' }),
    query: new URLSearchParams('page=1'),
    signal: new AbortController().signal,
    ...overrides,
  };
}

function webSocketInput(overrides = {}) {
  return {
    transport: 'websocket',
    method: 'GET',
    path: '/websocket',
    headers: new Headers({ cookie: 'session=opaque' }),
    query: new URLSearchParams('ticket=once'),
    origin: 'https://app.example.com',
    signal: new AbortController().signal,
    ...overrides,
  };
}

function session(overrides = {}) {
  return {
    authSessionId: 'session-1',
    principal: { id: 'user-1', roles: ['member'] },
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

function authentication(strategy, scenario = { use: ['strategy'], required: true }) {
  return createAuthentication({
    strategies: { strategy },
    scenarios: { default: scenario },
  });
}

test('createAuthentication синхронно и атомарно проверяет exact-key конфигурацию', () => {
  const validStrategy = { authenticate: () => ({ status: 'abstain' }) };
  const validScenario = { use: ['strategy'], required: true };
  const symbol = Symbol('unknown');
  const accessor = {};
  Object.defineProperty(accessor, 'authenticate', { get: () => validStrategy.authenticate });

  for (const options of [
    undefined,
    null,
    [],
    {},
    { strategies: { strategy: validStrategy }, scenarios: { default: validScenario }, extra: true },
    { strategies: {}, scenarios: { default: validScenario } },
    { strategies: { strategy: validStrategy }, scenarios: {} },
    { strategies: null, scenarios: { default: validScenario } },
    {
      strategies: Object.defineProperty({}, 'strategy', {
        value: validStrategy,
        enumerable: false,
      }),
      scenarios: { default: validScenario },
    },
    { strategies: { 'bad name': validStrategy }, scenarios: { default: validScenario } },
    { strategies: { strategy: null }, scenarios: { default: validScenario } },
    { strategies: { strategy: { authenticate: true } }, scenarios: { default: validScenario } },
    { strategies: { strategy: accessor }, scenarios: { default: validScenario } },
    {
      strategies: { strategy: validStrategy },
      scenarios: { default: { use: [], required: true } },
    },
    {
      strategies: { strategy: validStrategy },
      scenarios: { default: { use: ['strategy', 'strategy'], required: true } },
    },
    {
      strategies: { strategy: validStrategy },
      scenarios: { default: { use: ['missing'], required: true } },
    },
    {
      strategies: { strategy: validStrategy },
      scenarios: { default: { use: ['strategy'], required: 'yes' } },
    },
    {
      strategies: Object.assign({ strategy: validStrategy }, { [symbol]: true }),
      scenarios: { default: validScenario },
    },
  ]) {
    assert.throws(() => createAuthentication(options), InvalidAuthenticationOptionsError);
  }
});

test('Authentication имеет неподлежащее подделке внутреннее клеймо', () => {
  const module = authentication({ authenticate: () => ({ status: 'abstain' }) });
  const imitation = Object.create(Object.getPrototypeOf(module));

  assert.equal(isAuthentication(module), true);
  assert.equal(isAuthentication(imitation), false);
  assert.equal(isAuthentication(null), false);
});

test('конфигурация копируется, а fallback продолжается только после abstain', async () => {
  const calls = [];
  const strategies = {
    first: {
      authenticate() {
        calls.push('first');
        return { status: 'abstain' };
      },
    },
    second: {
      async authenticate() {
        calls.push('second');
        return { status: 'authenticated', session: session() };
      },
    },
  };
  const use = ['first', 'second'];
  const module = createAuthentication({
    strategies,
    scenarios: { default: { use, required: true } },
  });

  use.reverse();
  strategies.first.authenticate = () => {
    throw new Error('mutated');
  };

  const result = await module.authenticate('default', httpInput());

  assert.deepEqual(calls, ['first', 'second']);
  assert.equal(result.status, 'authenticated');
  assert(Object.isFrozen(result));
  assert(Object.isFrozen(module));
});

test('rejected завершает scenario без downgrade', async () => {
  let fallbackCalls = 0;
  const module = createAuthentication({
    strategies: {
      bearer: {
        authenticate: () => ({
          status: 'rejected',
          code: 'INVALID_TOKEN',
          challenge: 'Bearer',
        }),
      },
      cookie: {
        authenticate() {
          fallbackCalls += 1;
          return { status: 'authenticated', session: session() };
        },
      },
    },
    scenarios: { default: { use: ['bearer', 'cookie'], required: true } },
  });

  const result = await module.authenticate('default', httpInput());

  assert.deepEqual(result, {
    status: 'rejected',
    code: 'INVALID_TOKEN',
    challenge: 'Bearer',
  });
  assert(Object.isFrozen(result));
  assert.equal(fallbackCalls, 0);
});

test('required и optional scenarios различают полный abstain', async () => {
  const abstain = { authenticate: () => ({ status: 'abstain' }) };
  const module = createAuthentication({
    strategies: { abstain },
    scenarios: {
      required: { use: ['abstain'], required: true },
      optional: { use: ['abstain'], required: false },
    },
  });

  assert.deepEqual(await module.authenticate('required', httpInput()), {
    status: 'rejected',
    code: 'AUTHENTICATION_REQUIRED',
  });
  assert.deepEqual(await module.authenticate('optional', httpInput()), { status: 'abstain' });
});

test('каждая strategy получает transport-only input и изолированные snapshots', async () => {
  const seen = [];
  const module = createAuthentication({
    strategies: {
      mutate: {
        authenticate(input) {
          seen.push(input);
          input.headers.delete('authorization');
          input.query.set('page', 'changed');
          return { status: 'abstain' };
        },
      },
      inspect: {
        authenticate(input) {
          seen.push(input);
          assert.equal(input.headers.get('authorization'), 'Bearer token');
          assert.equal(input.query.get('page'), '1');
          return { status: 'authenticated', session: session() };
        },
      },
    },
    scenarios: { default: { use: ['mutate', 'inspect'], required: true } },
  });
  const input = httpInput();

  await module.authenticate('default', input);

  assert.equal(input.headers.get('authorization'), 'Bearer token');
  assert.equal(input.query.get('page'), '1');
  assert.notEqual(seen[0], seen[1]);
  assert.notEqual(seen[0].headers, seen[1].headers);
  assert.notEqual(seen[0].query, seen[1].query);
  assert(Object.isFrozen(seen[0]));
  assert.deepEqual(Reflect.ownKeys(seen[0]).toSorted(), [
    'headers',
    'method',
    'path',
    'query',
    'signal',
    'transport',
  ]);
});

test('WebSocket input сохраняет только нормализованные handshake-поля', async () => {
  let seen;
  const module = authentication({
    authenticate(input) {
      seen = input;
      return { status: 'abstain' };
    },
  });

  await module.authenticate('default', webSocketInput());

  assert.deepEqual(Reflect.ownKeys(seen).toSorted(), [
    'headers',
    'method',
    'origin',
    'path',
    'query',
    'signal',
    'transport',
  ]);
  assert.equal(seen.origin, 'https://app.example.com');
});

test('AuthSession и principal глубоко копируются и замораживаются', async () => {
  const original = session({
    principal: Object.assign(Object.create(null), {
      id: 'user-1',
      nested: { roles: ['member'] },
    }),
  });
  const module = authentication({
    authenticate: () => ({ status: 'authenticated', session: original }),
  });

  const result = await module.authenticate('default', httpInput());

  assert.notEqual(result.session, original);
  assert.notEqual(result.session.principal, original.principal);
  assert.equal(Object.getPrototypeOf(result.session.principal), null);
  assert(Object.isFrozen(result.session));
  assert(Object.isFrozen(result.session.principal));
  assert(Object.isFrozen(result.session.principal.nested));
  assert(Object.isFrozen(result.session.principal.nested.roles));
  original.principal.nested.roles.push('admin');
  assert.deepEqual(result.session.principal.nested.roles, ['member']);
});

test('невалидный tagged result оборачивается без раскрытия result', async () => {
  const invalidResult = { status: 'authenticated', session: { authSessionId: 'secret' } };
  const module = authentication({ authenticate: () => invalidResult });

  await assert.rejects(module.authenticate('default', httpInput()), (error) => {
    assert(error instanceof AuthenticationStrategyError);
    assert.equal(error.strategy, 'strategy');
    assert(error.cause instanceof InvalidAuthenticationResultError);
    assert.equal(error.cause.strategy, 'strategy');
    assert(!error.message.includes('secret'));
    assert(!error.cause.message.includes('secret'));
    return true;
  });
});

test('ядро отклоняет лишние result-поля, неверный challenge и истёкшую session', async () => {
  const results = [
    null,
    { status: 'abstain', extra: true },
    { status: 'rejected', code: 'lowercase' },
    { status: 'rejected', code: 'INVALID', challenge: 'Bearer\r\nInjected: true' },
    { status: 'authenticated', session: session({ expiresAt: Date.now() - 1 }) },
    { status: 'authenticated', session: session({ principal: [] }) },
    { status: 'authenticated', session: session({ principal: new Date() }) },
    { status: 'authenticated', session: session({ principal: { invalid: undefined } }) },
    {
      status: 'authenticated',
      session: session({
        principal: Object.defineProperty({}, 'secret', {
          get: () => 'hidden',
          enumerable: true,
        }),
      }),
    },
    { status: 'unknown' },
    {
      status: 'authenticated',
      session: session({
        principal: {
          values: Object.defineProperty([], '0', {
            get: () => 'secret',
            enumerable: true,
          }),
        },
      }),
    },
  ];

  for (const result of results) {
    const module = authentication({ authenticate: () => result });
    await assert.rejects(module.authenticate('default', httpInput()), AuthenticationStrategyError);
  }
});

test('ошибка strategy сохраняется как cause и не запускает fallback', async () => {
  const cause = new RangeError('strategy failed');
  let fallbackCalls = 0;
  const module = createAuthentication({
    strategies: {
      broken: { authenticate: () => Promise.reject(cause) },
      fallback: {
        authenticate() {
          fallbackCalls += 1;
          return { status: 'abstain' };
        },
      },
    },
    scenarios: { default: { use: ['broken', 'fallback'], required: false } },
  });

  await assert.rejects(module.authenticate('default', httpInput()), (error) => {
    assert(error instanceof AuthenticationStrategyError);
    assert.equal(error.strategy, 'broken');
    assert.equal(error.cause, cause);
    return true;
  });
  assert.equal(fallbackCalls, 0);
});

test('отмена до и во время strategy даёт AuthenticationAbortedError', async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const module = authentication({
    async authenticate() {
      await pending;
      return { status: 'abstain' };
    },
  });
  const before = new AbortController();
  before.abort();

  await assert.rejects(
    module.authenticate('default', httpInput({ signal: before.signal })),
    AuthenticationAbortedError,
  );

  const during = new AbortController();
  const running = module.authenticate('default', httpInput({ signal: during.signal }));
  during.abort();
  release();
  await assert.rejects(running, AuthenticationAbortedError);
});

test('authenticate проверяет scenario и exact transport inputs до strategy', async () => {
  let calls = 0;
  const module = authentication({
    authenticate() {
      calls += 1;
      return { status: 'abstain' };
    },
  });

  await assert.rejects(
    module.authenticate('missing', httpInput()),
    InvalidAuthenticationOptionsError,
  );
  for (const input of [
    null,
    { ...httpInput(), extra: true },
    { ...httpInput(), headers: {} },
    { ...httpInput(), query: {} },
    { ...httpInput(), signal: {} },
    { ...httpInput(), method: 'get' },
    { ...webSocketInput(), method: 'POST' },
    { ...webSocketInput(), origin: undefined },
  ]) {
    await assert.rejects(module.authenticate('default', input), TypeError);
  }
  assert.equal(calls, 0);
});
