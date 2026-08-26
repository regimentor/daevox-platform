import assert from 'node:assert/strict';
import test from 'node:test';

import { MiddlewareExecutionError } from '../../lib/framework/errors.js';
import { composeMiddleware, snapshotDeclaredMiddleware } from '../../lib/framework/middleware.js';

class MiddlewareMetadataError extends Error {}

const createMetadataError = (message) => new MiddlewareMetadataError(message);
const firstMiddleware = () => {};
const secondMiddleware = () => {};

test('объявленное middleware отсутствует как пустой неизменяемый снимок', () => {
  const snapshot = snapshotDeclaredMiddleware({}, createMetadataError);

  assert.deepEqual(snapshot, []);
  assert.equal(Object.isFrozen(snapshot), true);
});

test('объявленное middleware копируется в неизменяемый снимок', () => {
  const middleware = [firstMiddleware, secondMiddleware];

  const snapshot = snapshotDeclaredMiddleware({ middleware }, createMetadataError);
  middleware[0] = () => {};

  assert.deepEqual(snapshot, [firstMiddleware, secondMiddleware]);
  assert.equal(Object.isFrozen(snapshot), true);
});

test('объявленное middleware отклоняет accessor и явный undefined', () => {
  const accessor = {};
  Object.defineProperty(accessor, 'middleware', {
    get() {
      throw new Error('accessor must not run');
    },
  });

  for (const owner of [accessor, { middleware: undefined }]) {
    assert.throws(
      () => snapshotDeclaredMiddleware(owner, createMetadataError),
      /middleware must be an array when declared/,
    );
  }
});

test('объявленное middleware отклоняет sparse-массив', () => {
  const middleware = Array(3);
  middleware[0] = firstMiddleware;
  middleware[2] = secondMiddleware;

  assert.throws(
    () => snapshotDeclaredMiddleware({ middleware }, createMetadataError),
    /middleware must be a dense array without additional fields/,
  );
});

test('объявленное middleware отклоняет дополнительные строковые и symbol-поля', () => {
  const stringField = [() => {}];
  stringField.extra = true;
  const symbolField = [() => {}];
  symbolField[Symbol('extra')] = true;

  for (const middleware of [stringField, symbolField]) {
    assert.throws(
      () => snapshotDeclaredMiddleware({ middleware }, createMetadataError),
      /middleware must be a dense array without additional fields/,
    );
  }
});

test('цепочка middleware выполняется в прямом порядке и разворачивается после next', async () => {
  const calls = [];
  const first = async (_ctx, next) => {
    calls.push('first:before');
    const result = await next();
    calls.push('first:after');
    return result;
  };
  const second = async (_ctx, next) => {
    calls.push('second:before');
    const result = await next();
    calls.push('second:after');
    return result;
  };
  const terminal = async () => {
    calls.push('terminal');
    return 'result';
  };

  const execute = composeMiddleware([first, second], terminal);

  assert.equal(await execute(Object.freeze({})), 'result');
  assert.deepEqual(calls, [
    'first:before',
    'second:before',
    'terminal',
    'second:after',
    'first:after',
  ]);
});

test('повторный вызов одного next отклоняется публичным MiddlewareExecutionError', async () => {
  const execute = composeMiddleware(
    [
      async (_ctx, next) => {
        await next();
        return next();
      },
    ],
    () => 'result',
  );

  await assert.rejects(execute(Object.freeze({})), MiddlewareExecutionError);
});

test('синхронное middleware завершает цепочку без terminal handler', async () => {
  let terminalCalled = false;
  const execute = composeMiddleware([() => ({ status: 401 })], () => {
    terminalCalled = true;
  });

  assert.deepEqual(await execute(Object.freeze({})), { status: 401 });
  assert.equal(terminalCalled, false);
});

test('middleware изменяет или заменяет результат на обратном пути', async () => {
  const terminalResult = { count: 1 };
  const execute = composeMiddleware(
    [
      async (_ctx, next) => {
        const result = await next();
        return { original: result, replaced: true };
      },
      async (_ctx, next) => {
        const result = await next();
        result.count += 1;
        return result;
      },
    ],
    () => terminalResult,
  );

  assert.deepEqual(await execute(Object.freeze({})), {
    original: terminalResult,
    replaced: true,
  });
  assert.deepEqual(terminalResult, { count: 2 });
});

test('цепочка без окончательного перехвата передаёт исходные ошибки transport', async () => {
  const syncError = new Error('sync');
  const rejection = new Error('rejection');
  const afterNext = new Error('after next');

  for (const [middleware, expected] of [
    [
      () => {
        throw syncError;
      },
      syncError,
    ],
    [() => Promise.reject(rejection), rejection],
    [
      async (_ctx, next) => {
        await next();
        throw afterNext;
      },
      afterNext,
    ],
  ]) {
    const execute = composeMiddleware([middleware], () => 'result');
    await assert.rejects(execute(Object.freeze({})), (error) => error === expected);
  }
});
