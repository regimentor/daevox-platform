import assert from 'node:assert/strict';
import test from 'node:test';
import { Application, EventListenerBase, ScheduledTaskBase } from '../../src/index.ts';
import type { ScheduledTaskContext } from '../../src/index.ts';
import EchoJob from '../fixtures/jobs/echo-job.ts';
import RaceJob from '../fixtures/jobs/race-job.ts';

function timerCount() {
  return process.getActiveResourcesInfo().filter((type) => type === 'Timeout').length;
}

test('ScheduledTask uses real Worker, events and WebSocket capabilities with shared AppState', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const delivered = Promise.withResolvers<number>();
  let clientId = '';
  class State {
    value = 42;
  }
  class Result {
    value = 42;
  }
  class Listener extends EventListenerBase {
    static name = 'results';
    static events = [{ name: 'ready', data: Result, handler: 'ready' }] as const;
    ready(state: State, result: Result) {
      delivered.resolve(state.value + result.value);
    }
  }
  class Tick extends ScheduledTaskBase {
    static cron = '* * * * * *';
    async run(state: State, { signal }: ScheduledTaskContext) {
      const body = await this.jobRunner.run(EchoJob, { value: state.value }, { signal });
      this.events.push({ listener: 'results', event: 'ready' }, new Result());
      this.websocket.send({ clientId }, { controller: 'results', event: 'ready', body });
    }
  }
  const app = new Application({
    appState: State,
    websocket: {
      onConnect(_state, context) {
        clientId = context.clientId;
      },
    },
  })
    .registerEventListener(Listener)
    .registerScheduledTask(Tick);
  t.after(() => app.close());
  const address = await app.listen({ port: 0 });
  const socket = new WebSocket(
    `ws://127.0.0.1:${address.port}/websocket?clientId=scheduled`,
    'daevox.v1',
  );
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const message = new Promise((resolve) =>
    socket.addEventListener('message', (event) => resolve(JSON.parse(String(event.data))), {
      once: true,
    }),
  );
  t.mock.timers.tick(1000);
  assert.deepEqual(await message, { controller: 'results', event: 'ready', body: { value: 42 } });
  assert.equal(await delivered.promise, 84);
});

test('scheduled shutdown grace retains Job Runner and EventSender until cleanup settles', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const release = Promise.withResolvers<void>();
  const delivered: number[] = [];
  class State {
    value = 7;
  }
  class Result {
    value = 0;
  }
  class Listener extends EventListenerBase {
    static name = 'cleanup';
    static events = [{ name: 'done', data: Result, handler: 'done' }] as const;
    done(_state: State, result: Result) {
      delivered.push(result.value);
    }
  }
  class Cleanup extends ScheduledTaskBase {
    static cron = '* * * * * *';
    async run(state: State, { signal }: ScheduledTaskContext) {
      await release.promise;
      assert.equal(signal.aborted, true);
      const value = await this.jobRunner.run(EchoJob, state.value);
      const result = new Result();
      result.value = value;
      this.events.push({ listener: 'cleanup', event: 'done' }, result);
    }
  }
  const app = new Application({ appState: State })
    .registerEventListener(Listener)
    .registerScheduledTask(Cleanup);
  t.after(() => {
    release.resolve();
    return app.close();
  });
  await app.listen({ port: 0 });
  t.mock.timers.tick(1000);
  const closing = app.close();
  await new Promise((resolve) => setImmediate(resolve));
  release.resolve();
  await closing;
  assert.deepEqual(delivered, [7]);
});

test('a Worker job not awaited by run does not extend ScheduledTask activity', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const buffer = new SharedArrayBuffer(16);
  const state = new Int32Array(buffer);
  const results: Promise<unknown>[] = [];
  class State {
    value = 7;
  }
  class Tick extends ScheduledTaskBase {
    static cron = '* * * * * *';
    async run() {
      results.push(this.jobRunner.run(RaceJob, { state: buffer, value: 7 }));
    }
  }
  const app = new Application({ appState: State, jobs: { poolSize: 1 } }).registerScheduledTask(
    Tick,
  );
  t.after(() => app.close());
  await app.listen({ port: 0 });
  t.mock.timers.tick(1000);
  await Promise.resolve();
  t.mock.timers.tick(1000);
  assert.equal(results.length, 2);
  Atomics.store(state, 1, 1);
  Atomics.notify(state, 1);
  Atomics.store(state, 3, 1);
  Atomics.notify(state, 3);
  assert.deepEqual(await Promise.all(results), [{ value: 7 }, { value: 7 }]);
});

test(
  'ScheduledTask grace starts after HTTP settlement rather than at close entry',
  { timeout: 5000 },
  async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let failures = 0;
    const taskGate = Promise.withResolvers<void>();
    const { HttpControllerBase } = await import('../../src/index.ts');
    class State {
      value = 1;
    }
    class Controller extends HttpControllerBase {
      static prefix = '/work';
      static routes = [{ method: 'GET', path: '/', handler: 'work' }] as const;
      async work() {
        started.resolve();
        await release.promise;
        return { status: 200, body: 'done' };
      }
    }
    class Tick extends ScheduledTaskBase {
      static cron = '* * * * * *';
      run(): Promise<void> {
        return taskGate.promise;
      }
    }
    const app = new Application({
      appState: State,
      scheduledTasks: {
        shutdownTimeout: 50,
        onError() {
          failures++;
        },
      },
    })
      .registerHttpController(Controller)
      .registerScheduledTask(Tick);
    const address = await app.listen({ port: 0 });
    t.after(() => {
      release.resolve();
      taskGate.resolve();
      return app.close();
    });
    const http = await import('node:http');
    const response = Promise.withResolvers<string>();
    const disconnected = Promise.withResolvers<void>();
    const request = http.get(
      { host: '127.0.0.1', port: address.port, path: '/work/', agent: false },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk) => chunks.push(chunk));
        incoming.on('end', () => response.resolve(Buffer.concat(chunks).toString()));
      },
    );
    request.on('error', response.reject);
    request.on('close', disconnected.resolve);
    await started.promise;
    t.mock.timers.tick(1000);
    let closed = false;
    const closing = app.close().then(() => {
      closed = true;
    });
    t.mock.timers.tick(200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(failures, 0);
    release.resolve();
    assert.equal(await response.promise, 'done');
    await disconnected.promise;
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(49);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(failures, 0);
    t.mock.timers.tick(1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, true);
    await closing;
    assert.equal(failures, 1);
  },
);

test('native scheduled timers do not retain the process after repeated Application close', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const result = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL('../fixtures/scheduled-lifecycle.ts', import.meta.url))],
    { timeout: 5000 },
  );
  assert.equal(result.stdout.trim(), 'closed 20 Applications');
});

test('runtime registration from a firing task leaves no native timers after close', async (t) => {
  const baseline = timerCount();
  const started = Promise.withResolvers<void>();
  class State {
    value = 1;
  }
  class Added extends ScheduledTaskBase {
    static cron = '0 0 0 1 1 *';
    async run() {}
  }
  class Tick extends ScheduledTaskBase {
    static cron = '* * * * * *';
    async run() {
      app.registerRuntimeScheduledTask(Added);
      started.resolve();
    }
  }
  const app = new Application({ appState: State }).registerScheduledTask(Tick);
  t.after(() => app.close());
  await app.listen({ port: 0 });
  await started.promise;
  await app.close();
  assert.equal(timerCount(), baseline);
});
