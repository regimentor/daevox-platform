import assert from 'node:assert/strict';
import test from 'node:test';
import { Application, ApplicationStateError, ScheduledTaskBase } from '../../src/index.ts';

class State {
  count = 0;
}

test('ScheduledTask registration is fluent and does not construct or run the task', async () => {
  class Tick extends ScheduledTaskBase {
    static cron = '* * * * * *';
    constructor(options: any) {
      super(options);
      throw new Error('must not construct');
    }
    async run(state: State) {
      state.count++;
    }
  }
  const app = new Application({ appState: State });
  assert.equal(app.registerScheduledTask(Tick), app);
  await app.close();
});

test('registration rejects malformed declarations atomically and duplicate constructors', async () => {
  const app = new Application({ appState: State });
  class Tick extends ScheduledTaskBase {
    static cron = '* * * * * *';
    async run() {}
  }
  for (const invalid of [
    null,
    {},
    () => {},
    ScheduledTaskBase,
    class extends Tick {},
    class extends ScheduledTaskBase {
      static cron = '* * * * * *';
      run = async () => {};
    },
    class extends ScheduledTaskBase {
      static cron = '* * * * * *';
      static async run() {}
    },
    class extends ScheduledTaskBase {
      async run() {}
    },
  ]) {
    assert.throws(() => app.registerScheduledTask(invalid as any), TypeError);
  }
  assert.equal(app.registerScheduledTask(Tick), app);
  assert.throws(() => app.registerScheduledTask(Tick), TypeError);
  await app.close();
  assert.throws(
    () =>
      app.registerScheduledTask(
        class extends ScheduledTaskBase {
          static cron = '* * * * * *';
          async run() {}
        },
      ),
    ApplicationStateError,
  );
});

test('registration validates six-field numeric cron and rejects impossible calendars atomically', async () => {
  const app = new Application({ appState: State });
  class Tick extends ScheduledTaskBase {
    static cron = '';
    async run() {}
  }
  for (const cron of [
    '',
    '* * * * *',
    '@daily',
    '0 0 9 * JAN *',
    '60 * * * * *',
    '* 60 * * * *',
    '* * 24 * * *',
    '* * * 0 * *',
    '* * * * 13 *',
    '* * * * * 8',
    '0 0 9 31 2 *',
    '0 0 9 30 2 *',
    '*/0 * * * * *',
    '5-1 * * * * *',
    '1,,2 * * * * *',
    '1/2/3 * * * * *',
    '1.5 * * * * *',
    'L * * * * *',
  ]) {
    Tick.cron = cron;
    assert.throws(() => app.registerScheduledTask(Tick), TypeError, cron);
  }
  for (const cron of ['0 0 9 29 2 *', '0 0 9 31 2 1', '0,30 */5 9-17 * * 0,7', '5/10 * * * * *']) {
    class Valid extends ScheduledTaskBase {
      static cron = cron;
      async run() {}
    }
    assert.equal(app.registerScheduledTask(Valid), app);
  }
  await app.close();
});

test('startup runs at future cron instants with fresh instances and shared AppState', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date('2026-01-01T00:00:00Z') });
  const seen: { state: State; task: ScheduledTaskBase }[] = [];
  class Tick extends ScheduledTaskBase {
    static cron = '* * * * * *';
    async run(state: State) {
      state.count++;
      seen.push({ state, task: this });
    }
  }
  const app = new Application({ appState: State }).registerScheduledTask(Tick);
  t.after(() => app.close());
  await app.listen({ port: 0 });
  assert.equal(seen.length, 0);
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(seen.length, 1);
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(seen.length, 2);
  assert.equal(seen[0].state, seen[1].state);
  assert.equal(seen[0].state.count, 2);
  assert.notEqual(seen[0].task, seen[1].task);
});

test('calendar uses snapshot metadata and coalesces delay into one execution', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date('2026-01-01T00:00:00Z') });
  let count = 0;
  class Tick extends ScheduledTaskBase {
    static cron = '10,20 * * * * *';
    async run() {
      count++;
    }
  }
  const app = new Application({ appState: State }).registerScheduledTask(Tick);
  t.after(() => app.close());
  Tick.cron = '* * * * * *';
  await app.listen({ port: 0 });
  t.mock.timers.tick(9000);
  assert.equal(count, 0);
  t.mock.timers.tick(1000);
  assert.equal(count, 1);
  await Promise.resolve();
  t.mock.timers.tick(180000);
  assert.equal(count, 2);
  await Promise.resolve();
  t.mock.timers.tick(10000);
  assert.equal(count, 3);
});

test('runtime registration opens after startup and closes synchronously at shutdown', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let count = 0;
  class Tick extends ScheduledTaskBase {
    static cron = '* * * * * *';
    async run() {
      count++;
    }
  }
  const app = new Application({ appState: State });
  t.after(() => app.close());
  assert.throws(() => app.registerRuntimeScheduledTask(Tick), ApplicationStateError);
  await app.listen({ port: 0 });
  assert.throws(() => app.registerScheduledTask(Tick), ApplicationStateError);
  assert.equal(app.registerRuntimeScheduledTask(Tick), app);
  assert.equal(count, 0);
  assert.throws(() => app.registerRuntimeScheduledTask(Tick), TypeError);
  t.mock.timers.tick(1000);
  assert.equal(count, 1);
  const closing = app.close();
  assert.throws(() => app.registerRuntimeScheduledTask(Tick), ApplicationStateError);
  await closing;
  t.mock.timers.tick(1000);
  assert.equal(count, 1);
});

test('busy tasks skip without constructing or queuing while other classes keep running', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const gate = Promise.withResolvers<void>();
  let slow = 0;
  let fast = 0;
  class Slow extends ScheduledTaskBase {
    static cron = '* * * * * *';
    constructor(options: any) {
      super(options);
      slow++;
    }
    run() {
      return gate.promise;
    }
  }
  class Fast extends ScheduledTaskBase {
    static cron = '* * * * * *';
    async run() {
      fast++;
    }
  }
  const app = new Application({ appState: State })
    .registerScheduledTask(Slow)
    .registerScheduledTask(Fast);
  t.after(() => app.close());
  await app.listen({ port: 0 });
  t.mock.timers.tick(1000);
  await Promise.resolve();
  t.mock.timers.tick(1000);
  assert.deepEqual([slow, fast], [1, 2]);
  gate.resolve();
  await Promise.resolve();
  assert.equal(slow, 1);
  t.mock.timers.tick(1000);
  assert.deepEqual([slow, fast], [2, 3]);
});

test('execution errors preserve identity and phase and never stop subsequent firings', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const failure = new Error('execution failure');
  const observed: any[] = [];
  class BrokenConstructor extends ScheduledTaskBase {
    static cron = '* * * * * *';
    constructor(options: any) {
      super(options);
      throw failure;
    }
    async run() {}
  }
  class BrokenRun extends ScheduledTaskBase {
    static cron = '* * * * * *';
    run(): Promise<void> {
      throw failure;
    }
  }
  class RejectedRun extends ScheduledTaskBase {
    static cron = '* * * * * *';
    async run() {
      throw failure;
    }
  }
  class InvalidRun extends ScheduledTaskBase {
    static cron = '* * * * * *';
    run(): any {
      return 42;
    }
  }
  const app = new Application({
    appState: State,
    scheduledTasks: {
      onError(error: unknown, context: any) {
        observed.push([error, context.taskClass, context.taskName, context.phase]);
      },
    },
  });
  for (const task of [BrokenConstructor, BrokenRun, RejectedRun, InvalidRun])
    app.registerScheduledTask(task);
  t.after(() => app.close());
  await app.listen({ port: 0 });
  for (let i = 0; i < 2; i++) {
    t.mock.timers.tick(1000);
    await Promise.resolve();
    assert.equal(observed.length, (i + 1) * 4);
  }
  for (const Task of [BrokenConstructor, BrokenRun, RejectedRun]) {
    assert.deepEqual(
      observed.find((item) => item[1] === Task),
      [failure, Task, Task.name, Task === BrokenConstructor ? 'constructor' : 'run'],
    );
  }
  assert.ok(observed.find((item) => item[1] === InvalidRun)[0] instanceof TypeError);
});

test('throwing, rejecting and pending observers cannot interrupt schedules or shutdown', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const logs: unknown[] = [];
  t.mock.method(console, 'error', (error: unknown) => logs.push(error));
  const failure = new Error('observer');
  let runs = 0;
  class Tick extends ScheduledTaskBase {
    static cron = '* * * * * *';
    async run() {
      runs++;
      throw 17;
    }
  }
  const app = new Application({
    appState: State,
    scheduledTasks: {
      onError() {
        if (runs === 1) throw failure;
        if (runs === 2) return Promise.reject(failure);
        return new Promise(() => {});
      },
    },
  }).registerScheduledTask(Tick);
  t.after(() => app.close());
  await app.listen({ port: 0 });
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(1000);
    await Promise.resolve();
    await Promise.resolve();
  }
  await app.close();
  assert.equal(runs, 3);
  assert.deepEqual(logs, [failure, failure]);
});

test('close aborts synchronously and awaits cooperative scheduled work before AppState closes', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const gate = Promise.withResolvers<void>();
  const events: string[] = [];
  let signal!: AbortSignal;
  class ClosingState {
    onAppClose() {
      events.push('closed');
    }
  }
  class Tick extends ScheduledTaskBase {
    static cron = '* * * * * *';
    async run(_state: ClosingState, context: { signal: AbortSignal }) {
      signal = context.signal;
      await gate.promise;
      events.push('settled');
    }
  }
  const app = new Application({ appState: ClosingState }).registerScheduledTask(Tick);
  t.after(() => {
    gate.resolve();
    return app.close();
  });
  await app.listen({ port: 0 });
  t.mock.timers.tick(1000);
  const closing = app.close();
  assert.equal(app.close(), closing);
  assert.equal(signal.aborted, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, []);
  gate.resolve();
  await closing;
  assert.deepEqual(events, ['settled', 'closed']);
});

test('shutdown budget is shared and late rejections are suppressed after one timeout per task', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const gate = Promise.withResolvers<void>();
  const failures: any[] = [];
  const classes = [0, 1].map(
    () =>
      class Tick extends ScheduledTaskBase {
        static cron = '* * * * * *';
        run() {
          return gate.promise;
        }
      },
  );
  const app = new Application({
    appState: State,
    scheduledTasks: {
      shutdownTimeout: 50,
      onError(error, context) {
        failures.push([error, context]);
      },
    },
  });
  classes.forEach((Task) => app.registerScheduledTask(Task));
  await app.listen({ port: 0 });
  t.mock.timers.tick(1000);
  let closed = false;
  const closing = app.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(49);
  await Promise.resolve();
  assert.equal(closed, false);
  t.mock.timers.tick(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, true);
  await closing;
  assert.equal(failures.length, 2);
  for (let i = 0; i < 2; i++) {
    assert.equal(failures[i][0].constructor.name, 'ScheduledTaskShutdownTimeoutError');
    assert.deepEqual(failures[i][1], {
      taskClass: classes[i],
      taskName: 'Tick',
      phase: 'shutdown',
    });
  }
  gate.reject(new Error('late'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failures.length, 2);
});

test('scheduled options require a positive safe integer budget and callable observer', async () => {
  for (const scheduledTasks of [
    null,
    [],
    1,
    { extra: true },
    { [Symbol()]: 1 },
    ...[0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, null, '50'].map(
      (shutdownTimeout) => ({ shutdownTimeout }),
    ),
    { onError: 3 },
  ]) {
    assert.throws(
      () => new Application({ appState: State, scheduledTasks: scheduledTasks as any }),
      TypeError,
    );
  }
  for (const scheduledTasks of [
    undefined,
    {},
    { shutdownTimeout: 1 },
    { shutdownTimeout: Number.MAX_SAFE_INTEGER },
  ]) {
    await new Application({ appState: State, scheduledTasks }).close();
  }
});

test('close during startup cannot activate schedules or reopen registration', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let count = 0;
  class StartingState {
    async onAppStart() {
      started.resolve();
      await gate.promise;
    }
  }
  class Tick extends ScheduledTaskBase {
    static cron = '* * * * * *';
    async run() {
      count++;
    }
  }
  const app = new Application({ appState: StartingState }).registerScheduledTask(Tick);
  const listening = app.listen({ port: 0 });
  await started.promise;
  assert.throws(() => app.registerRuntimeScheduledTask(Tick), ApplicationStateError);
  t.mock.timers.tick(1000);
  assert.equal(count, 0);
  const closing = app.close();
  gate.resolve();
  await listening;
  assert.throws(() => app.registerRuntimeScheduledTask(Tick), ApplicationStateError);
  await closing;
  t.mock.timers.tick(1000);
  assert.equal(count, 0);
});

test('a task can initiate close without another due task or a timer restarting', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const gate = Promise.withResolvers<void>();
  let closing!: Promise<void>;
  let closed = false;
  let otherRuns = 0;
  class First extends ScheduledTaskBase {
    static cron = '* * * * * *';
    run(_state: State, { signal }: { signal: AbortSignal }) {
      closing = app.close().then(() => {
        closed = true;
      });
      assert.equal(signal.aborted, true);
      return gate.promise;
    }
  }
  class Second extends ScheduledTaskBase {
    static cron = '* * * * * *';
    async run() {
      otherRuns++;
    }
  }
  const app = new Application({ appState: State })
    .registerScheduledTask(First)
    .registerScheduledTask(Second);
  t.after(() => {
    gate.resolve();
    return app.close();
  });
  await app.listen({ port: 0 });
  t.mock.timers.tick(1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  assert.equal(otherRuns, 0);
  gate.resolve();
  await closing;
  t.mock.timers.tick(1000);
  assert.equal(otherRuns, 0);
});

test('shutdownTimeout above the native timer limit does not overflow into immediate shutdown', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const gate = Promise.withResolvers<void>();
  let timeouts = 0;
  class Tick extends ScheduledTaskBase {
    static cron = '* * * * * *';
    run() {
      return gate.promise;
    }
  }
  const app = new Application({
    appState: State,
    scheduledTasks: {
      shutdownTimeout: 2147483657,
      onError() {
        timeouts++;
      },
    },
  }).registerScheduledTask(Tick);
  t.after(() => {
    gate.resolve();
    return app.close();
  });
  await app.listen({ port: 0 });
  t.mock.timers.tick(1000);
  const closing = app.close();
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(2147483647);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timeouts, 0);
  t.mock.timers.tick(10);
  await closing;
  assert.equal(timeouts, 1);
});

test('abort listeners observe the same close promise and completed runs are not cancelled', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let completedSignal!: AbortSignal;
  let nestedClose!: Promise<void>;
  const gate = Promise.withResolvers<void>();
  class Completed extends ScheduledTaskBase {
    static cron = '1 * * * * *';
    async run(_state: State, { signal }: { signal: AbortSignal }) {
      completedSignal = signal;
    }
  }
  class Active extends ScheduledTaskBase {
    static cron = '2 * * * * *';
    run(_state: State, { signal }: { signal: AbortSignal }) {
      signal.addEventListener('abort', () => {
        nestedClose = app.close();
        gate.resolve();
      });
      return gate.promise;
    }
  }
  const app = new Application({ appState: State })
    .registerScheduledTask(Completed)
    .registerScheduledTask(Active);
  await app.listen({ port: 0 });
  t.mock.timers.tick(1000);
  await Promise.resolve();
  t.mock.timers.tick(1000);
  const closing = app.close();
  await closing;
  assert.equal(completedSignal.aborted, false);
  assert.equal(nestedClose, closing);
});

test('default observer reports original errors and the default shutdown budget is 30000ms', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const logs: any[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => logs.push(args));
  const failure = new Error('default observer');
  class Broken extends ScheduledTaskBase {
    static cron = '* * * * * *';
    run(): Promise<void> {
      throw failure;
    }
  }
  class Hanging extends ScheduledTaskBase {
    static cron = '* * * * * *';
    run(): Promise<void> {
      return new Promise(() => {});
    }
  }
  const app = new Application({ appState: State })
    .registerScheduledTask(Broken)
    .registerScheduledTask(Hanging);
  await app.listen({ port: 0 });
  t.mock.timers.tick(1000);
  const closing = app.close();
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(29999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0], [failure, { taskClass: Broken, taskName: 'Broken', phase: 'run' }]);
  t.mock.timers.tick(1);
  await closing;
  assert.equal(logs.length, 2);
  assert.equal(logs[1][1].phase, 'shutdown');
});

for (const hook of ['beforeAppStart', 'onAppStart'] as const) {
  test(`failed ${hook} never activates ScheduledTask`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
    const failure = new Error('startup');
    class FailingState {
      async [hook]() {
        throw failure;
      }
    }
    let count = 0;
    class Tick extends ScheduledTaskBase {
      static cron = '* * * * * *';
      async run() {
        count++;
      }
    }
    const app = new Application({ appState: FailingState }).registerScheduledTask(Tick);
    await assert.rejects(app.listen({ port: 0 }), (error) => error === failure);
    assert.throws(() => app.registerScheduledTask(Tick), ApplicationStateError);
    assert.throws(() => app.registerRuntimeScheduledTask(Tick), ApplicationStateError);
    await app.close();
    t.mock.timers.tick(60000);
    assert.equal(count, 0);
  });
}

test('separate Applications execute the same constructor independently', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const states: State[] = [];
  class Tick extends ScheduledTaskBase {
    static cron = '* * * * * *';
    async run(state: State) {
      states.push(state);
    }
  }
  const first = new Application({ appState: State }).registerScheduledTask(Tick);
  const second = new Application({ appState: State }).registerScheduledTask(Tick);
  t.after(() => Promise.all([first.close(), second.close()]));
  await first.listen({ port: 0 });
  await second.listen({ port: 0 });
  t.mock.timers.tick(1000);
  assert.equal(states.length, 2);
  assert.notEqual(states[0], states[1]);
});

test('close during beforeAppStart never opens a runtime registration window', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  class StartingState {
    async beforeAppStart() {
      started.resolve();
      await gate.promise;
    }
  }
  class Tick extends ScheduledTaskBase {
    static cron = '* * * * * *';
    async run() {}
  }
  const app = new Application({ appState: StartingState }).registerScheduledTask(Tick);
  const listening = app.listen({ port: 0 });
  await started.promise;
  const closing = app.close();
  gate.resolve();
  await listening;
  assert.throws(
    () =>
      app.registerRuntimeScheduledTask(
        class extends ScheduledTaskBase {
          static cron = '* * * * * *';
          async run() {}
        },
      ),
    ApplicationStateError,
  );
  await closing;
});

test('run accepts genuine Promises from another realm but rejects bare thenables', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const { runInNewContext } = await import('node:vm');
  const errors: unknown[] = [];
  class CrossRealm extends ScheduledTaskBase {
    static cron = '* * * * * *';
    run(): Promise<void> {
      return runInNewContext('Promise.resolve()');
    }
  }
  const app = new Application({
    appState: State,
    scheduledTasks: {
      onError(error) {
        errors.push(error);
      },
    },
  }).registerScheduledTask(CrossRealm);
  t.after(() => app.close());
  await app.listen({ port: 0 });
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(errors.length, 0);
  class Thenable extends ScheduledTaskBase {
    static cron = '* * * * * *';
    run(): any {
      return {
        // oxlint-disable-next-line unicorn/no-thenable -- Deliberately violate the Promise contract.
        then(resolve: () => void) {
          resolve();
        },
      };
    }
  }
  app.registerRuntimeScheduledTask(Thenable);
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof TypeError);
});

test('close during construction cancels the admitted execution context', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let signal!: AbortSignal;
  class Tick extends ScheduledTaskBase {
    static cron = '* * * * * *';
    constructor(options: any) {
      super(options);
      void app.close();
    }
    async run(_state: State, context: { signal: AbortSignal }) {
      signal = context.signal;
    }
  }
  const app = new Application({ appState: State }).registerScheduledTask(Tick);
  await app.listen({ port: 0 });
  t.mock.timers.tick(1000);
  await app.close();
  assert.equal(signal.aborted, true);
});
