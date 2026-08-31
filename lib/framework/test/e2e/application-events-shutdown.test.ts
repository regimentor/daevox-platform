class TestAppState {
  readonly marker = undefined;
}
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

// oxlint-disable typescript/no-extraneous-class -- DTO classes intentionally provide nominal identity.

import { Application } from '../../src/Application.ts';
import { EventListenerBase } from '../../src/EventListenerBase.ts';
import { HttpControllerBase } from '../../src/HttpControllerBase.ts';
import { WebSocketControllerBase } from '../../src/WebSocketControllerBase.ts';
import { EventDroppedError, EventSenderClosedError } from '../../src/errors.ts';
import EchoJob from '../fixtures/jobs/echo-job.ts';

function deferred() {
  let resolve: any;
  const promise = new Promise<any>((resolvePromise: any) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function destroyedRequest(address: any, path: any) {
  const responseReceived = deferred();
  const closed = deferred();
  const request = http.get({ ...address, path, agent: false }, (response: any) => {
    responseReceived.resolve(response);
    response.once('close', closed.resolve);
  });
  request.on('error', () => closed.resolve());
  return { request, responseReceived: responseReceived.promise, closed: closed.promise };
}

function openWebSocket(url: any) {
  return new Promise<any>((resolve: any, reject: any) => {
    const socket = new WebSocket(url, 'daevox.v1');
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
}

function closeWebSocket(socket: any) {
  return new Promise<any>((resolve: any) => {
    socket.addEventListener('close', resolve, { once: true });
  });
}

test('close ждёт settlement HTTP-handler после уничтожения response и разрешает ему push', async (t: any) => {
  const handlerStarted = deferred();
  const releaseHandler = deferred();
  const eventHandled = deferred();
  class Work {}
  class Listener extends EventListenerBase {
    static name = 'after-response';
    static events = [{ name: 'work', data: Work, handler: 'work' }] as const;
    work() {
      eventHandled.resolve();
    }
  }
  class Controller extends HttpControllerBase {
    static prefix = '/race';
    static routes = [{ method: 'GET', path: '/', handler: 'run' }] as const;
    async run() {
      handlerStarted.resolve();
      await releaseHandler.promise;
      this.events.push({ listener: 'after-response', event: 'work' }, new Work());
      return { status: 200 };
    }
  }
  const errors: any[] = [];
  const application = new Application({
    appState: TestAppState,
    http: {
      shutdownTimeout: 100,
      onError: (_appState: any, error: any) => errors.push(error),
    },
  });
  t.after(async () => {
    releaseHandler.resolve();
    await application.close();
  });
  application.registerEventListener(Listener);
  application.registerHttpController(Controller);
  const address = await application.listen({ port: 0 });
  const request = destroyedRequest(address, '/race');

  await handlerStarted.promise;
  request.request.destroy();
  await request.closed;
  const closing = application.close();
  const earlyResult = await Promise.race([
    closing.then(() => 'closed'),
    new Promise<any>((resolve: any) => setTimeout(resolve, 20, 'waiting')),
  ]);
  assert.equal(earlyResult, 'waiting');
  releaseHandler.resolve();

  await closing;
  await eventHandled.promise;
  assert.deepEqual(errors, []);
});

test('push из HTTP-handler после forced transport cutoff получает EventSenderClosedError', async (t: any) => {
  const handlerStarted = deferred();
  const releasePush = deferred();
  const pushResult = deferred();
  class Work {}
  class Listener extends EventListenerBase {
    static name = 'cutoff';
    static events = [{ name: 'work', data: Work, handler: 'work' }] as const;
    work() {}
  }
  class Controller extends HttpControllerBase {
    static prefix = '/cutoff';
    static routes = [{ method: 'GET', path: '/', handler: 'run' }] as const;
    async run() {
      handlerStarted.resolve();
      await releasePush.promise;
      try {
        this.events.push({ listener: 'cutoff', event: 'work' }, new Work());
        pushResult.resolve(false);
      } catch (error) {
        pushResult.resolve(error instanceof EventSenderClosedError);
      }
      return { status: 200 };
    }
  }
  const application = new Application({ appState: TestAppState, http: { shutdownTimeout: 10 } });
  t.after(async () => {
    releasePush.resolve();
    await application.close();
  });
  application.registerEventListener(Listener);
  application.registerHttpController(Controller);
  const address = await application.listen({ port: 0 });
  const request = destroyedRequest(address, '/cutoff');

  await handlerStarted.promise;
  request.request.destroy();
  await request.closed;
  await application.close();
  releasePush.resolve();

  assert.equal(await pushResult.promise, true);
});

test('close опустошает event mailbox до закрытия JobRunner', async (t: any) => {
  const listenerStarted = deferred();
  const releaseListener = deferred();
  const listenerFinished = deferred();
  class Work {}
  class Listener extends EventListenerBase {
    static name = 'jobs-during-drain';
    static events = [{ name: 'work', data: Work, handler: 'work' }] as const;
    async work() {
      listenerStarted.resolve();
      await releaseListener.promise;
      listenerFinished.resolve(await this.jobRunner.run(EchoJob, 'job-still-open'));
    }
  }
  class Controller extends HttpControllerBase {
    static prefix = '/drain';
    static routes = [{ method: 'POST', path: '/', handler: 'run' }] as const;
    run() {
      this.events.push({ listener: 'jobs-during-drain', event: 'work' }, new Work());
      return { status: 202 };
    }
  }
  const application = new Application({ appState: TestAppState });
  t.after(async () => {
    releaseListener.resolve();
    await application.close();
  });
  application.registerEventListener(Listener);
  application.registerHttpController(Controller);
  const address = await application.listen({ port: 0 });

  await fetch(`http://${address.address}:${address.port}/drain`, { method: 'POST' });
  await listenerStarted.promise;
  const closing = application.close();
  releaseListener.resolve();

  assert.equal(await listenerFinished.promise, 'job-still-open');
  await closing;
});

test('forced event shutdown отменяет active, наблюдает pending drops и ловит late rejection', async (t: any) => {
  const activeStarted = deferred();
  const activeAborted = deferred();
  const releaseActive = deferred();
  const lateSettled = deferred();
  const observations: any[] = [];
  const unhandled: any[] = [];
  const onUnhandled = (error: any) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  class Work {
    declare id: any;

    constructor(id: any) {
      this.id = id;
    }
  }
  class Listener extends EventListenerBase {
    static name = 'forced';
    static events = [{ name: 'work', data: Work, handler: 'work' }] as const;
    async work(_appState: TestAppState, data: any, { signal }: any) {
      assert.equal(data.id, 1);
      activeStarted.resolve();
      await new Promise<any>((resolve: any) =>
        signal.addEventListener(
          'abort',
          () => {
            activeAborted.resolve(signal.reason);
            resolve();
          },
          { once: true },
        ),
      );
      await releaseActive.promise;
      lateSettled.resolve();
      throw new Error('late after cutoff');
    }
  }
  class Controller extends HttpControllerBase {
    static prefix = '/forced';
    static routes = [{ method: 'POST', path: '/', handler: 'run' }] as const;
    run() {
      for (const id of [1, 2, 3]) {
        this.events.push({ listener: 'forced', event: 'work' }, new Work(id));
      }
      return { status: 202 };
    }
  }
  const application = new Application({
    appState: TestAppState,
    events: {
      handlerTimeout: 30,
      shutdownTimeout: 10,
      onError: (error: any, context: any) => observations.push({ error, context }),
    },
  });
  t.after(async () => {
    releaseActive.resolve();
    await application.close();
  });
  application.registerEventListener(Listener);
  application.registerHttpController(Controller);
  const address = await application.listen({ port: 0 });
  await fetch(`http://${address.address}:${address.port}/forced`, { method: 'POST' });
  await activeStarted.promise;

  await application.close();
  await activeAborted.promise;
  assert.equal(observations.length, 2);
  assert.ok(observations.every(({ error }: any) => error instanceof EventDroppedError));
  assert.ok(observations.every(({ context }: any) => Object.isFrozen(context)));

  await new Promise<any>((resolve: any) => setTimeout(resolve, 40));
  assert.equal(observations.length, 2);

  releaseActive.resolve();
  await lateSettled.promise;
  await new Promise<any>((resolve: any) => setImmediate(resolve));
  assert.equal(observations.length, 2);
  assert.deepEqual(unhandled, []);
});

test('close ждёт WebSocket message-handler после закрытия сессии и разрешает ему push', async (t: any) => {
  const handlerStarted = deferred();
  const releaseHandler = deferred();
  const eventHandled = deferred();
  class Work {}
  class Listener extends EventListenerBase {
    static name = 'after-session';
    static events = [{ name: 'work', data: Work, handler: 'work' }] as const;
    work() {
      eventHandled.resolve();
    }
  }
  class Controller extends WebSocketControllerBase {
    static name = 'race';
    static events = [{ name: 'run', handler: 'run' }] as const;
    async run() {
      handlerStarted.resolve();
      await releaseHandler.promise;
      this.events.push({ listener: 'after-session', event: 'work' }, new Work());
    }
  }
  const application = new Application({
    appState: TestAppState,
    websocket: { shutdownTimeout: 100 },
  });
  let socket: any;
  t.after(async () => {
    releaseHandler.resolve();
    socket?.close();
    await application.close();
  });
  application.registerEventListener(Listener);
  application.registerWebSocketController(Controller);
  const address = await application.listen({ port: 0 });
  socket = await openWebSocket(`ws://${address.address}:${address.port}/websocket`);
  socket.send(JSON.stringify({ controller: 'race', event: 'run', body: {} }));
  await handlerStarted.promise;
  const socketClosed = closeWebSocket(socket);
  socket.close();
  await socketClosed;

  const closing = application.close();
  const earlyResult = await Promise.race([
    closing.then(() => 'closed'),
    new Promise<any>((resolve: any) => setTimeout(resolve, 20, 'waiting')),
  ]);
  assert.equal(earlyResult, 'waiting');
  releaseHandler.resolve();

  await closing;
  await eventHandled.promise;
});

test('websocket.shutdownTimeout ограничивает зависший onDisconnect', async (t: any) => {
  const disconnectStarted = deferred();
  let disconnectSignal: any;
  const application = new Application({
    appState: TestAppState,
    websocket: {
      shutdownTimeout: 10,
      async onDisconnect(_appState: any, ctx: any) {
        disconnectSignal = ctx.signal;
        disconnectStarted.resolve();
        await new Promise<any>(() => {});
      },
    },
  });
  let socket: any;
  t.after(async () => {
    socket?.close();
    await application.close();
  });
  const address = await application.listen({ port: 0 });
  socket = await openWebSocket(`ws://${address.address}:${address.port}/websocket`);

  const closing = application.close();
  await disconnectStarted.promise;
  await closing;
  assert.equal(disconnectSignal.aborted, true);
});

test('websocket.shutdownTimeout отменяет pending onConnect и освобождает handshake socket', async (t: any) => {
  const connectStarted = deferred();
  const releaseConnect = deferred();
  let connectSignal: any;
  const application = new Application({
    appState: TestAppState,
    websocket: {
      shutdownTimeout: 10,
      async onConnect(_appState: any, ctx: any) {
        connectSignal = ctx.signal;
        connectStarted.resolve();
        await releaseConnect.promise;
      },
    },
  });
  t.after(async () => {
    releaseConnect.resolve();
    await application.close();
  });
  const address = await application.listen({ port: 0 });
  const socket = new WebSocket(`ws://${address.address}:${address.port}/websocket`, 'daevox.v1');
  socket.addEventListener('error', () => {}, { once: true });
  await connectStarted.promise;

  await application.close();
  assert.equal(connectSignal.aborted, true);
  releaseConnect.resolve();
});
