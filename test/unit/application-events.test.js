import assert from 'node:assert/strict';
import test from 'node:test';

// oxlint-disable typescript/no-extraneous-class -- DTO classes intentionally provide nominal identity.

import { Application } from '../../lib/framework/Application.js';
import { EventListenerBase } from '../../lib/framework/EventListenerBase.js';
import { HttpControllerBase } from '../../lib/framework/HttpControllerBase.js';
import { WebSocketControllerBase } from '../../lib/framework/WebSocketControllerBase.js';
import {
  ApplicationStateError,
  EventDroppedError,
  EventHandlerTimeoutError,
  EventQueueFullError,
  InvalidEventPushError,
} from '../../lib/framework/errors.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function openWebSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, 'daevox.v1');
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
}

function nextWebSocketMessage(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket message timeout')), 1_000);
    socket.addEventListener(
      'message',
      (event) => {
        clearTimeout(timer);
        resolve(JSON.parse(event.data));
      },
      { once: true },
    );
  });
}

test('mailbox сохраняет FIFO одного listener и не блокирует другой listener', async (t) => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const secondFinished = deferred();
  const parallelFinished = deferred();
  const order = [];

  class Work {
    constructor(id) {
      this.id = id;
    }
  }
  class SerialListener extends EventListenerBase {
    static name = 'serial';
    static events = [{ name: 'work', data: Work, handler: 'work' }];
    async work(data) {
      order.push(`start:${data.id}`);
      if (data.id === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      order.push(`finish:${data.id}`);
      if (data.id === 2) secondFinished.resolve();
    }
  }
  class ParallelListener extends EventListenerBase {
    static name = 'parallel';
    static events = [{ name: 'work', data: Work, handler: 'work' }];
    work(data) {
      order.push(`parallel:${data.id}`);
      parallelFinished.resolve();
    }
  }
  class TriggerController extends HttpControllerBase {
    static prefix = '/trigger';
    static routes = [{ method: 'POST', path: '/', handler: 'trigger' }];
    trigger() {
      this.events.push({ listener: 'serial', event: 'work' }, new Work(1));
      this.events.push({ listener: 'serial', event: 'work' }, new Work(2));
      this.events.push({ listener: 'parallel', event: 'work' }, new Work(3));
      return { status: 202 };
    }
  }

  const application = new Application();
  t.after(async () => {
    releaseFirst.resolve();
    await application.close();
  });
  application.registerEventListener(SerialListener);
  application.registerEventListener(ParallelListener);
  application.registerHttpController(TriggerController);
  const address = await application.listen({ port: 0 });

  const response = await fetch(`http://${address.address}:${address.port}/trigger`, {
    method: 'POST',
  });
  assert.equal(response.status, 202);
  await firstStarted.promise;
  await parallelFinished.promise;
  assert.deepEqual(order, ['start:1', 'parallel:3']);

  releaseFirst.resolve();
  await secondFinished.promise;
  assert.deepEqual(order, ['start:1', 'parallel:3', 'finish:1', 'start:2', 'finish:2']);
});

test('mailbox запускает не более одного handler за один setImmediate', async (t) => {
  const finished = deferred();
  const order = [];
  class Work {
    constructor(id) {
      this.id = id;
    }
  }
  class FairListener extends EventListenerBase {
    static name = 'fair';
    static events = [{ name: 'work', data: Work, handler: 'work' }];
    work(data) {
      order.push(data.id);
      if (data.id === 2) finished.resolve();
    }
  }
  class TriggerController extends HttpControllerBase {
    static prefix = '/fair';
    static routes = [{ method: 'POST', path: '/', handler: 'trigger' }];
    trigger() {
      this.events.push({ listener: 'fair', event: 'work' }, new Work(1));
      this.events.push({ listener: 'fair', event: 'work' }, new Work(2));
      setImmediate(() => order.push('outside-turn'));
      return { status: 202 };
    }
  }
  const application = new Application();
  t.after(() => application.close());
  application.registerEventListener(FairListener);
  application.registerHttpController(TriggerController);
  const address = await application.listen({ port: 0 });

  await fetch(`http://${address.address}:${address.port}/fair`, { method: 'POST' });
  await finished.promise;
  assert.deepEqual(order, [1, 'outside-turn', 2]);
});

test('push синхронно отклоняет неверный адрес, DTO и переполненный mailbox', async (t) => {
  class Work {}
  class Other {}
  class Listener extends EventListenerBase {
    static name = 'strict';
    static events = [{ name: 'work', data: Work, handler: 'work' }];
    work() {}
  }
  class TriggerController extends HttpControllerBase {
    static prefix = '/strict';
    static routes = [{ method: 'POST', path: '/', handler: 'trigger' }];
    trigger() {
      const invalidCalls = [
        () => this.events.push(undefined, new Work()),
        () => this.events.push({ listener: 'strict' }, new Work()),
        () =>
          this.events.push(
            Object.defineProperties(
              {},
              {
                listener: { get: () => 'strict', enumerable: true },
                event: { value: 'work', enumerable: true },
              },
            ),
            new Work(),
          ),
        () => this.events.push({ listener: 'strict', event: 42 }, new Work()),
        () => this.events.push({ listener: 'missing', event: 'work' }, new Work()),
        () => this.events.push({ listener: 'strict', event: 'missing' }, new Work()),
        () => this.events.push({ listener: 'strict', event: 'work' }, new Other()),
      ];
      const invalid = invalidCalls.map((call) => {
        try {
          call();
          return false;
        } catch (error) {
          return error instanceof InvalidEventPushError;
        }
      });
      this.events.push({ listener: 'strict', event: 'work' }, new Work());
      let full = false;
      try {
        this.events.push({ listener: 'strict', event: 'work' }, new Work());
      } catch (error) {
        full = error instanceof EventQueueFullError;
      }
      return { status: 200, body: { invalid, full } };
    }
  }
  const application = new Application({ events: { queueSize: 1 } });
  t.after(() => application.close());
  application.registerEventListener(Listener);
  application.registerHttpController(TriggerController);
  const address = await application.listen({ port: 0 });

  const response = await fetch(`http://${address.address}:${address.port}/strict`, {
    method: 'POST',
  });
  assert.deepEqual(await response.json(), {
    invalid: [true, true, true, true, true, true, true],
    full: true,
  });
});

test('queueSize считает ожидающие события, но не active handler', async (t) => {
  const activeStarted = deferred();
  const releaseActive = deferred();
  class Work {}
  class Listener extends EventListenerBase {
    static name = 'capacity';
    static events = [{ name: 'work', data: Work, handler: 'work' }];
    async work() {
      activeStarted.resolve();
      await releaseActive.promise;
    }
  }
  class Controller extends HttpControllerBase {
    static prefix = '/capacity';
    static routes = [{ method: 'POST', path: '/', handler: 'push' }];
    push() {
      try {
        this.events.push({ listener: 'capacity', event: 'work' }, new Work());
        return { status: 202 };
      } catch (error) {
        if (error instanceof EventQueueFullError) return { status: 503 };
        throw error;
      }
    }
  }
  const application = new Application({ events: { queueSize: 1 } });
  t.after(async () => {
    releaseActive.resolve();
    await application.close();
  });
  application.registerEventListener(Listener);
  application.registerHttpController(Controller);
  const address = await application.listen({ port: 0 });
  const url = `http://${address.address}:${address.port}/capacity`;

  assert.equal((await fetch(url, { method: 'POST' })).status, 202);
  await activeStarted.promise;
  assert.equal((await fetch(url, { method: 'POST' })).status, 202);
  assert.equal((await fetch(url, { method: 'POST' })).status, 503);
});

test('registry и push копируют адрес, но передают ту же ссылку DTO', async (t) => {
  const observed = deferred();
  class Work {}
  const declaration = { name: 'work', data: Work, handler: 'work' };
  const declarations = [declaration];
  let sent;
  class Listener extends EventListenerBase {
    static name = 'snapshot';
    static events = declarations;
    work(data) {
      assert.equal(data, sent);
      throw new Error('observed');
    }
  }
  class TriggerController extends HttpControllerBase {
    static prefix = '/snapshot';
    static routes = [{ method: 'POST', path: '/', handler: 'trigger' }];
    trigger() {
      sent = new Work();
      const address = { listener: 'snapshot', event: 'work' };
      this.events.push(address, sent);
      address.listener = 'changed';
      address.event = 'changed';
      return { status: 202 };
    }
  }
  const application = new Application({
    events: {
      onError(error, context) {
        observed.resolve({ error, context });
      },
    },
  });
  t.after(() => application.close());
  application.registerEventListener(Listener);
  declaration.name = 'changed';
  declaration.data = class Changed {};
  declaration.handler = 'changed';
  declarations.length = 0;
  application.registerHttpController(TriggerController);
  const address = await application.listen({ port: 0 });

  const response = await fetch(`http://${address.address}:${address.port}/snapshot`, {
    method: 'POST',
  });
  assert.equal(response.status, 202);
  const { error, context } = await observed.promise;
  assert.equal(error.message, 'observed');
  assert.deepEqual(context, { listener: 'snapshot', event: 'work' });
  assert.equal(Object.isFrozen(context), true);
});

test('ошибки handler изолированы от HTTP и тот же listener продолжает FIFO', async (t) => {
  const finished = deferred();
  const errors = [];
  const counters = [];
  class Work {
    constructor(kind) {
      this.kind = kind;
    }
  }
  class Listener extends EventListenerBase {
    static name = 'resilient';
    static events = [{ name: 'work', data: Work, handler: 'work' }];
    count = 0;
    work(data) {
      this.count += 1;
      counters.push(this.count);
      if (data.kind === 'sync') throw new Error('sync failure');
      if (data.kind === 'async') return Promise.reject(new Error('async failure'));
      finished.resolve();
    }
  }
  class TriggerController extends HttpControllerBase {
    static prefix = '/errors';
    static routes = [{ method: 'POST', path: '/', handler: 'trigger' }];
    trigger() {
      for (const kind of ['sync', 'async', 'success']) {
        this.events.push({ listener: 'resilient', event: 'work' }, new Work(kind));
      }
      return { status: 202, body: { transport: 'independent' } };
    }
  }
  const application = new Application({
    events: { onError: (error) => errors.push(error.message) },
  });
  t.after(() => application.close());
  application.registerEventListener(Listener);
  application.registerHttpController(TriggerController);
  const address = await application.listen({ port: 0 });

  const response = await fetch(`http://${address.address}:${address.port}/errors`, {
    method: 'POST',
  });
  assert.deepEqual(await response.json(), { transport: 'independent' });
  await finished.promise;
  assert.deepEqual(errors, ['sync failure', 'async failure']);
  assert.deepEqual(counters, [1, 2, 3]);
});

test('ошибка handler без events.onError передаётся в console.error', async (t) => {
  const handlerError = new Error('unobserved listener failure');
  let errorLogged;
  const logged = new Promise((resolve) => {
    errorLogged = resolve;
  });
  const consoleError = t.mock.method(console, 'error', (error) => errorLogged(error));
  class Work {}
  class Listener extends EventListenerBase {
    static name = 'default-observer';
    static events = [{ name: 'work', data: Work, handler: 'work' }];
    work() {
      throw handlerError;
    }
  }
  class Controller extends HttpControllerBase {
    static prefix = '/default-observer';
    static routes = [{ method: 'POST', path: '/', handler: 'push' }];
    push() {
      this.events.push({ listener: 'default-observer', event: 'work' }, new Work());
      return { status: 202 };
    }
  }
  const application = new Application();
  t.after(() => application.close());
  application.registerEventListener(Listener);
  application.registerHttpController(Controller);
  const address = await application.listen({ port: 0 });

  assert.equal(
    (await fetch(`http://${address.address}:${address.port}/default-observer`, { method: 'POST' }))
      .status,
    202,
  );
  assert.equal(await logged, handlerError);
  assert.equal(consoleError.mock.callCount(), 1);
});

test('запланированный mailbox не запускает отброшенное при forced shutdown событие', async (t) => {
  const dropped = deferred();
  const scheduledCallbacks = [];
  const originalSetImmediate = globalThis.setImmediate;
  let handlerCalled = false;
  class Work {}
  class Listener extends EventListenerBase {
    static name = 'scheduled-cutoff';
    static events = [{ name: 'work', data: Work, handler: 'work' }];
    work() {
      handlerCalled = true;
    }
  }
  class Controller extends HttpControllerBase {
    static prefix = '/scheduled-cutoff';
    static routes = [{ method: 'POST', path: '/', handler: 'push' }];
    push() {
      this.events.push({ listener: 'scheduled-cutoff', event: 'work' }, new Work());
      return { status: 202 };
    }
  }
  const application = new Application({
    events: {
      shutdownTimeout: 1,
      onError: (error) => dropped.resolve(error),
    },
  });
  t.after(async () => {
    globalThis.setImmediate = originalSetImmediate;
    await application.close();
  });
  application.registerEventListener(Listener);
  application.registerHttpController(Controller);
  const address = await application.listen({ port: 0 });
  globalThis.setImmediate = (callback, ...arguments_) => {
    scheduledCallbacks.push(() => callback(...arguments_));
  };

  const response = await fetch(`http://${address.address}:${address.port}/scheduled-cutoff`, {
    method: 'POST',
  });
  globalThis.setImmediate = originalSetImmediate;
  assert.equal(response.status, 202);
  assert.ok(scheduledCallbacks.length > 0);

  await application.close();
  assert.ok((await dropped.promise) instanceof EventDroppedError);
  for (const callback of scheduledCallbacks) callback();
  assert.equal(handlerCalled, false);
});

test('handler timeout отменяет signal, но FIFO ждёт поздний settlement без второй ошибки', async (t) => {
  const timedOut = deferred();
  const releaseLateHandler = deferred();
  const secondFinished = deferred();
  const errors = [];
  let timeoutReason;
  let secondStarted = false;
  class Work {
    constructor(id) {
      this.id = id;
    }
  }
  class Listener extends EventListenerBase {
    static name = 'timeout';
    static events = [{ name: 'work', data: Work, handler: 'work' }];
    async work(data, { signal }) {
      if (data.id === 1) {
        await new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              timeoutReason = signal.reason;
              resolve();
            },
            { once: true },
          );
        });
        await releaseLateHandler.promise;
        throw new Error('late rejection');
      }
      secondStarted = true;
      secondFinished.resolve();
    }
  }
  class TriggerController extends HttpControllerBase {
    static prefix = '/timeout';
    static routes = [{ method: 'POST', path: '/', handler: 'trigger' }];
    trigger() {
      this.events.push({ listener: 'timeout', event: 'work' }, new Work(1));
      this.events.push({ listener: 'timeout', event: 'work' }, new Work(2));
      return { status: 202 };
    }
  }
  const application = new Application({
    events: {
      handlerTimeout: 10,
      onError(error) {
        errors.push(error);
        timedOut.resolve();
      },
    },
  });
  t.after(async () => {
    releaseLateHandler.resolve();
    await application.close();
  });
  application.registerEventListener(Listener);
  application.registerHttpController(TriggerController);
  const address = await application.listen({ port: 0 });

  await fetch(`http://${address.address}:${address.port}/timeout`, { method: 'POST' });
  await timedOut.promise;
  assert.ok(timeoutReason instanceof EventHandlerTimeoutError);
  assert.equal(errors[0], timeoutReason);
  assert.equal(secondStarted, false);

  releaseLateHandler.resolve();
  await secondFinished.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1);
});

test('ошибка observer передаётся в console.error и не задерживает mailbox', async (t) => {
  const finished = deferred();
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (error) => logged.push(error);
  t.after(() => {
    console.error = originalConsoleError;
  });
  let observations = 0;
  class Work {
    constructor(id) {
      this.id = id;
    }
  }
  class Listener extends EventListenerBase {
    static name = 'observer';
    static events = [{ name: 'work', data: Work, handler: 'work' }];
    work(data) {
      if (data.id < 3) throw new Error(`handler:${data.id}`);
      finished.resolve();
    }
  }
  class TriggerController extends HttpControllerBase {
    static prefix = '/observer';
    static routes = [{ method: 'POST', path: '/', handler: 'trigger' }];
    trigger() {
      for (const id of [1, 2, 3]) {
        this.events.push({ listener: 'observer', event: 'work' }, new Work(id));
      }
      return { status: 202 };
    }
  }
  const application = new Application({
    events: {
      onError() {
        observations += 1;
        if (observations === 1) throw new Error('sync observer');
        return Promise.reject(new Error('async observer'));
      },
    },
  });
  t.after(() => application.close());
  application.registerEventListener(Listener);
  application.registerHttpController(TriggerController);
  const address = await application.listen({ port: 0 });

  await fetch(`http://${address.address}:${address.port}/observer`, { method: 'POST' });
  await finished.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    logged.map((error) => error.message),
    ['sync observer', 'async observer'],
  );
});

test('ошибка конструктора listener делает запуск необратимо failed', async (t) => {
  const constructionError = new Error('listener construction failed');
  class Work {}
  class BrokenListener extends EventListenerBase {
    static name = 'broken';
    static events = [{ name: 'work', data: Work, handler: 'work' }];
    constructor(options) {
      super(options);
      throw constructionError;
    }
    work() {}
  }
  const application = new Application();
  t.after(() => application.close());
  application.registerEventListener(BrokenListener);

  await assert.rejects(application.listen({ port: 0 }), (error) => error === constructionError);
  await assert.rejects(application.listen({ port: 0 }), ApplicationStateError);
});

test('WebSocket-контроллер получает events, а listener error не меняет protocol result', async (t) => {
  const observed = deferred();
  class Work {
    constructor(value) {
      this.value = value;
    }
  }
  class Listener extends EventListenerBase {
    static name = 'websocket-listener';
    static events = [{ name: 'work', data: Work, handler: 'work' }];
    work(data) {
      assert.equal(data.value, 'payload');
      throw new Error('listener failed later');
    }
  }
  class TriggerController extends WebSocketControllerBase {
    static name = 'trigger';
    static events = [{ name: 'run', handler: 'run' }];
    run(ctx) {
      const result = this.events.push(
        { listener: 'websocket-listener', event: 'work' },
        new Work(ctx.body.value),
      );
      return { accepted: result === undefined };
    }
  }
  const application = new Application({
    events: { onError: (error) => observed.resolve(error) },
  });
  let socket;
  t.after(async () => {
    socket?.close();
    await application.close();
  });
  application.registerEventListener(Listener);
  application.registerWebSocketController(TriggerController);
  const address = await application.listen({ port: 0 });
  socket = await openWebSocket(`ws://${address.address}:${address.port}/websocket`);

  const message = nextWebSocketMessage(socket);
  socket.send(JSON.stringify({ controller: 'trigger', event: 'run', body: { value: 'payload' } }));
  assert.deepEqual(await message, {
    controller: 'trigger',
    event: 'run',
    body: { accepted: true },
  });
  assert.equal((await observed.promise).message, 'listener failed later');
});
