import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';

import { createAuthentication } from '../../lib/framework/Authentication.js';
import {
  bearerToken,
  cookieSession,
  oneTimeWebSocketTicket,
} from '../../lib/framework/authenticationStrategies.js';
import {
  AuthenticationStrategyError,
  InvalidAuthenticationOptionsError,
  InvalidAuthenticationResultError,
} from '../../lib/framework/errors.js';

function httpInput(headers = {}) {
  return {
    transport: 'http',
    method: 'GET',
    path: '/resource',
    headers: new Headers(headers),
    query: new URLSearchParams(),
    signal: new AbortController().signal,
  };
}

function webSocketInput(query = '', overrides = {}) {
  const input = {
    transport: 'websocket',
    method: 'GET',
    path: '/websocket',
    headers: new Headers(),
    query: new URLSearchParams(query),
    origin: 'https://app.example.com',
    signal: new AbortController().signal,
    ...overrides,
  };
  if (Object.hasOwn(overrides, 'origin') && overrides.origin === undefined) delete input.origin;
  return input;
}

function authentication(strategy) {
  return createAuthentication({
    strategies: { preset: strategy },
    scenarios: { default: { use: ['preset'], required: false } },
  });
}

function session(overrides = {}) {
  return {
    authSessionId: 'session-1',
    principal: { id: 'user-1' },
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

test('cookieSession извлекает точное opaque cookie value и подтверждает AuthSession', async () => {
  const calls = [];
  const module = authentication(
    cookieSession({
      cookie: { name: '__Host-session' },
      resolve(value, metadata) {
        calls.push({ value, metadata });
        return session();
      },
    }),
  );

  const result = await module.authenticate(
    'default',
    httpInput({ cookie: 'theme=dark; __Host-session=opaque%2Fvalue; locale=ru' }),
  );

  assert.equal(result.status, 'authenticated');
  assert.equal(result.session.authSessionId, 'session-1');
  assert.equal(calls[0].value, 'opaque%2Fvalue');
  assert.deepEqual(calls[0].metadata, {
    transport: 'http',
    signal: calls[0].metadata.signal,
  });
  assert(Object.isFrozen(calls[0].metadata));
});

test('cookieSession различает отсутствие, malformed, null и просроченную session', async () => {
  let calls = 0;
  let callbackResult = null;
  const module = authentication(
    cookieSession({
      cookie: { name: 'session' },
      resolve() {
        calls += 1;
        return callbackResult;
      },
    }),
  );

  assert.deepEqual(await module.authenticate('default', httpInput()), { status: 'abstain' });
  assert.deepEqual(await module.authenticate('default', httpInput({ cookie: 'other=value' })), {
    status: 'abstain',
  });
  assert.equal(calls, 0);

  for (const cookie of [
    'session=',
    'session="quoted"',
    'session=contains\\slash',
    'session=first; session=second',
  ]) {
    assert.deepEqual(await module.authenticate('default', httpInput({ cookie })), {
      status: 'rejected',
      code: 'INVALID_SESSION',
    });
  }
  assert.equal(calls, 0);

  assert.deepEqual(await module.authenticate('default', httpInput({ cookie: 'session=unknown' })), {
    status: 'rejected',
    code: 'INVALID_SESSION',
  });
  callbackResult = session({ expiresAt: Date.now() - 1 });
  assert.deepEqual(await module.authenticate('default', httpInput({ cookie: 'session=expired' })), {
    status: 'rejected',
    code: 'INVALID_SESSION',
  });
});

test('bearerToken строго извлекает token68 и безопасно классифицирует credential', async () => {
  const calls = [];
  let callbackResult = session();
  const module = authentication(
    bearerToken({
      verify(token, metadata) {
        calls.push({ token, metadata });
        return callbackResult;
      },
    }),
  );

  assert.deepEqual(await module.authenticate('default', httpInput()), { status: 'abstain' });
  assert.deepEqual(
    await module.authenticate('default', httpInput({ authorization: 'Basic YTpi' })),
    { status: 'abstain' },
  );

  for (const authorization of [
    'Bearer',
    'Bearer\ttoken',
    'Bearer, second',
    'Bearer token, second',
    'Bearer bad=mid',
  ]) {
    assert.deepEqual(await module.authenticate('default', httpInput({ authorization })), {
      status: 'rejected',
      code: 'INVALID_TOKEN',
      challenge: 'Bearer',
    });
  }
  assert.equal(calls.length, 0);

  const result = await module.authenticate(
    'default',
    httpInput({ authorization: 'bEaReR   opaque+/==' }),
  );
  assert.equal(result.status, 'authenticated');
  assert.equal(calls[0].token, 'opaque+/==');
  assert.deepEqual(calls[0].metadata, {
    transport: 'http',
    signal: calls[0].metadata.signal,
  });
  assert(Object.isFrozen(calls[0].metadata));

  callbackResult = null;
  assert.deepEqual(
    await module.authenticate('default', httpInput({ authorization: 'Bearer unknown' })),
    { status: 'rejected', code: 'INVALID_TOKEN', challenge: 'Bearer' },
  );
  callbackResult = session({ expiresAt: Date.now() - 1 });
  assert.deepEqual(
    await module.authenticate('default', httpInput({ authorization: 'Bearer expired' })),
    { status: 'rejected', code: 'INVALID_TOKEN', challenge: 'Bearer' },
  );
});

test('oneTimeWebSocketTicket использует только handshake query и делегирует consume один раз', async () => {
  const calls = [];
  let callbackResult = session();
  const module = authentication(
    oneTimeWebSocketTicket({
      consume(ticket, metadata) {
        calls.push({ ticket, metadata });
        return callbackResult;
      },
    }),
  );

  assert.deepEqual(
    await module.authenticate('default', httpInput({ authorization: 'Bearer ticket' })),
    { status: 'abstain' },
  );
  assert.deepEqual(await module.authenticate('default', webSocketInput()), { status: 'abstain' });
  for (const query of ['ticket=', 'ticket=first&ticket=second']) {
    assert.deepEqual(await module.authenticate('default', webSocketInput(query)), {
      status: 'rejected',
      code: 'INVALID_TICKET',
    });
  }
  assert.equal(calls.length, 0);

  const result = await module.authenticate('default', webSocketInput('ticket=opaque%2Fvalue'));
  assert.equal(result.status, 'authenticated');
  assert.equal(calls[0].ticket, 'opaque/value');
  assert.deepEqual(calls[0].metadata, {
    origin: 'https://app.example.com',
    signal: calls[0].metadata.signal,
  });
  assert(Object.isFrozen(calls[0].metadata));

  callbackResult = null;
  assert.deepEqual(
    await module.authenticate('default', webSocketInput('ticket=replayed', { origin: undefined })),
    { status: 'rejected', code: 'INVALID_TICKET' },
  );
  assert.deepEqual(Reflect.ownKeys(calls[1].metadata).toSorted(), ['signal']);
  callbackResult = session({ expiresAt: Date.now() - 1 });
  assert.deepEqual(await module.authenticate('default', webSocketInput('ticket=expired')), {
    status: 'rejected',
    code: 'INVALID_TICKET',
  });
  assert.equal(calls.length, 3);
});

test('preset callback errors не сохраняют raw credentials в error cause или inspection', async () => {
  const secret = 'raw-secret-value';
  const attempts = [
    {
      strategy: cookieSession({
        cookie: { name: 'session' },
        resolve: async () => {
          throw new Error(`store rejected ${secret}`);
        },
      }),
      input: httpInput({ cookie: `session=${secret}` }),
    },
    {
      strategy: bearerToken({
        verify: async () => {
          throw new Error(`provider rejected ${secret}`);
        },
      }),
      input: httpInput({ authorization: `Bearer ${secret}` }),
    },
    {
      strategy: oneTimeWebSocketTicket({
        consume: async () => {
          throw new Error(`consume rejected ${secret}`);
        },
      }),
      input: webSocketInput(`ticket=${secret}`),
    },
  ];

  for (const attempt of attempts) {
    const module = authentication(attempt.strategy);
    await assert.rejects(module.authenticate('default', attempt.input), (error) => {
      assert(error instanceof AuthenticationStrategyError);
      assert(error.cause instanceof Error);
      assert(!error.message.includes(secret));
      assert(!error.cause.message.includes(secret));
      assert(!inspect(error, { depth: 5 }).includes(secret));
      return true;
    });
  }
});

test('preset передаёт невалидный callback outcome ядру как invalid result, а не credential rejection', async () => {
  const invalidSession = session({ expiresAt: 0 });
  const attempts = [
    {
      strategy: cookieSession({ cookie: { name: 'session' }, resolve: () => invalidSession }),
      input: httpInput({ cookie: 'session=value' }),
    },
    {
      strategy: bearerToken({ verify: () => invalidSession }),
      input: httpInput({ authorization: 'Bearer value' }),
    },
    {
      strategy: oneTimeWebSocketTicket({ consume: () => invalidSession }),
      input: webSocketInput('ticket=value'),
    },
  ];

  for (const attempt of attempts) {
    const module = authentication(attempt.strategy);
    await assert.rejects(module.authenticate('default', attempt.input), (error) => {
      assert(error instanceof AuthenticationStrategyError);
      assert(error.cause instanceof InvalidAuthenticationResultError);
      return true;
    });
  }
});

test('factories синхронно проверяют exact-key options и не сохраняют изменяемую конфигурацию', async () => {
  const symbol = Symbol('extra');
  const accessor = {};
  Object.defineProperty(accessor, 'verify', { get: () => () => session(), enumerable: true });
  for (const create of [
    () => cookieSession(),
    () => cookieSession({ cookie: { name: '' }, resolve: () => session() }),
    () => cookieSession({ cookie: { name: 'bad=name' }, resolve: () => session() }),
    () => cookieSession({ cookie: { name: 'session', extra: true }, resolve: () => session() }),
    () => bearerToken({ verify: () => session(), extra: true }),
    () => bearerToken(accessor),
    () => oneTimeWebSocketTicket({ consume: true }),
    () => oneTimeWebSocketTicket(Object.assign({ consume: () => session() }, { [symbol]: true })),
  ]) {
    assert.throws(create, InvalidAuthenticationOptionsError);
  }

  let originalCalls = 0;
  const options = {
    cookie: { name: 'session' },
    resolve: () => {
      originalCalls += 1;
      return session();
    },
  };
  const strategy = cookieSession(options);
  options.cookie.name = 'changed';
  options.resolve = () => {
    throw new Error('mutated callback');
  };

  const result = await authentication(strategy).authenticate(
    'default',
    httpInput({ cookie: 'session=value' }),
  );
  assert.equal(result.status, 'authenticated');
  assert.equal(originalCalls, 1);
  assert.deepEqual(Reflect.ownKeys(strategy), ['authenticate']);
  assert(Object.isFrozen(strategy));

  let bearerCalls = 0;
  const bearerOptions = {
    verify: () => {
      bearerCalls += 1;
      return session();
    },
  };
  const bearer = bearerToken(bearerOptions);
  bearerOptions.verify = () => null;
  assert.equal(
    (
      await authentication(bearer).authenticate(
        'default',
        httpInput({ authorization: 'Bearer value' }),
      )
    ).status,
    'authenticated',
  );
  assert.equal(bearerCalls, 1);

  let ticketCalls = 0;
  const ticketOptions = {
    consume: () => {
      ticketCalls += 1;
      return session();
    },
  };
  const ticket = oneTimeWebSocketTicket(ticketOptions);
  ticketOptions.consume = () => null;
  assert.equal(
    (await authentication(ticket).authenticate('default', webSocketInput('ticket=value'))).status,
    'authenticated',
  );
  assert.equal(ticketCalls, 1);
});
