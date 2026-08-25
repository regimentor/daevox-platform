import assert from 'node:assert/strict';
import nodeHttp from 'node:http';
import test from 'node:test';

import { Application } from '../../lib/framework/Application.js';
import { HttpControllerBase } from '../../lib/framework/HttpControllerBase.js';
import { JobRunner } from '../../lib/framework/JobRunner.js';
import { WebSocketControllerBase } from '../../lib/framework/WebSocketControllerBase.js';
import {
  ApplicationStateError,
  JobAbortedError,
  JobTimedOutError,
  WorkerTerminatedError,
} from '../../lib/framework/errors.js';
import EchoJob from '../fixtures/jobs/echo-job.js';
import RaceJob from '../fixtures/jobs/race-job.js';

const ITERATIONS = 3;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function barrier() {
  const state = new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT);
  return { state, view: new Int32Array(state) };
}

function release(view, index) {
  Atomics.store(view, index, 1);
  Atomics.notify(view, index);
}

async function reached(view, index, label) {
  if (Atomics.load(view, index) !== 0) return;
  const result = await Atomics.waitAsync(view, index, 0, 1_000).value;
  if (result === 'timed-out') throw new Error(`barrier timed out: ${label}`);
  assert.notEqual(Atomics.load(view, index), 0, label);
}

function observed(promise) {
  const settlements = [];
  const settled = promise.then(
    (value) => {
      settlements.push({ status: 'fulfilled', value });
      return settlements[0];
    },
    (reason) => {
      settlements.push({ status: 'rejected', reason });
      return settlements[0];
    },
  );
  return { settled, settlements };
}

function describeOrder(scenario, order, iteration) {
  return `${scenario}, order=${order}, iteration=${iteration}`;
}

async function drainTurns() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function waitForClose(emitter) {
  return new Promise((resolve) => emitter.once('close', resolve));
}

function requestErrorHandled(request) {
  request.on('error', () => {});
  return request;
}

function openWebSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, 'daevox.v1');
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
}

function closeWebSocket(socket) {
  return new Promise((resolve) => {
    socket.addEventListener('close', resolve, { once: true });
  });
}

async function assertSingleSettlement(observation, expected, context) {
  const outcome = await observation.settled;
  if (typeof expected === 'function') {
    assert.equal(outcome.status, 'rejected', context);
    assert.ok(outcome.reason instanceof expected, context);
  } else {
    assert.deepEqual(outcome, { status: 'fulfilled', value: expected }, context);
  }
  await drainTurns();
  assert.equal(observation.settlements.length, 1, context);
}

async function preparedRun(runner, options = {}, outcome = 'result') {
  const control = barrier();
  const promise = runner.run(
    RaceJob,
    { outcome, state: control.state, value: 'race-result' },
    options,
  );
  const observation = observed(promise);
  await reached(control.view, 0, 'job started');
  release(control.view, 1);
  await reached(control.view, 2, 'result prepared');
  return { ...control, observation };
}

async function runJobRace(scenario, order, iteration) {
  const context = describeOrder(scenario, order, iteration);
  const runner = new JobRunner({
    poolSize: 1,
    queueSize: 1,
    terminationGracePeriod: 5,
    shutdownTimeout: 100,
  });
  try {
    if (scenario === 'result/cancel') {
      const controller = new AbortController();
      const run = await preparedRun(runner, { signal: controller.signal });
      if (order === 'first') {
        release(run.view, 3);
        await assertSingleSettlement(run.observation, { value: 'race-result' }, context);
        controller.abort();
      } else {
        controller.abort();
        await assertSingleSettlement(run.observation, JobAbortedError, context);
        release(run.view, 3);
      }
    } else if (scenario === 'result/timeout') {
      const timeout = order === 'first' ? 1_000 : 100;
      const run = await preparedRun(runner, { timeout });
      if (order === 'first') {
        release(run.view, 3);
        await assertSingleSettlement(run.observation, { value: 'race-result' }, context);
      } else {
        await assertSingleSettlement(run.observation, JobTimedOutError, context);
        release(run.view, 3);
      }
    } else if (scenario === 'cancel/timeout') {
      const controller = new AbortController();
      const timeout = order === 'first' ? 1_000 : 100;
      const run = await preparedRun(runner, { signal: controller.signal, timeout });
      if (order === 'first') controller.abort();
      await assertSingleSettlement(
        run.observation,
        order === 'first' ? JobAbortedError : JobTimedOutError,
        context,
      );
      if (order === 'second') controller.abort();
      release(run.view, 3);
    } else {
      const controller = new AbortController();
      const competesWithCancel = scenario === 'crash/cancel';
      const options = competesWithCancel
        ? { signal: controller.signal }
        : { signal: controller.signal, timeout: order === 'first' ? 1_000 : 100 };
      const run = await preparedRun(runner, options, 'crash');
      if (order === 'first') {
        release(run.view, 3);
        await assertSingleSettlement(run.observation, WorkerTerminatedError, context);
        if (competesWithCancel) controller.abort();
      } else {
        if (competesWithCancel) controller.abort();
        await assertSingleSettlement(
          run.observation,
          competesWithCancel ? JobAbortedError : JobTimedOutError,
          context,
        );
        release(run.view, 3);
      }
    }

    assert.equal(
      await runner.run(EchoJob, context),
      context,
      `${context}: pool slot was not reused`,
    );
  } finally {
    await runner.close();
  }
}

async function runCloseRace(scenario, order, iteration) {
  const context = describeOrder(`close/${scenario}`, order, iteration);
  const runner = new JobRunner({
    poolSize: 1,
    terminationGracePeriod: 5,
    shutdownTimeout: 100,
  });
  const controller = new AbortController();
  const options =
    scenario === 'timeout'
      ? { signal: controller.signal, timeout: 100 }
      : { signal: controller.signal };
  const run = await preparedRun(runner, options, scenario === 'crash' ? 'crash' : 'result');
  let closing;

  if (order === 'close-first') closing = runner.close();
  if (scenario === 'result' || scenario === 'crash') release(run.view, 3);
  else if (scenario === 'cancel') controller.abort();

  const expected = {
    result: { value: 'race-result' },
    cancel: JobAbortedError,
    timeout: JobTimedOutError,
    crash: WorkerTerminatedError,
  }[scenario];
  await assertSingleSettlement(run.observation, expected, context);

  if (order === 'event-first') {
    if (scenario === 'cancel' || scenario === 'timeout') release(run.view, 3);
    assert.equal(await runner.run(EchoJob, context), context, `${context}: pool was not reusable`);
    closing = runner.close();
  }
  assert.equal(runner.close(), closing, `${context}: close was not idempotent`);
  await closing;
}

test(
  'JobRunner детерминированно разрешает попарные гонки терминальных событий',
  { timeout: 20_000 },
  async () => {
    const lateFailures = [];
    const onUnhandledRejection = (error) => lateFailures.push(error);
    const onUncaughtException = (error) => lateFailures.push(error);
    process.on('unhandledRejection', onUnhandledRejection);
    process.on('uncaughtException', onUncaughtException);
    try {
      for (const scenario of [
        'result/cancel',
        'result/timeout',
        'cancel/timeout',
        'crash/cancel',
        'crash/timeout',
      ]) {
        for (const order of ['first', 'second']) {
          for (let iteration = 1; iteration <= ITERATIONS; iteration += 1) {
            await runJobRace(scenario, order, iteration);
          }
        }
      }
      await drainTurns();
      assert.deepEqual(lateFailures, []);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      process.off('uncaughtException', onUncaughtException);
    }
  },
);

async function cancelWhileReadingBody(iteration) {
  let handlerCalls = 0;
  class BodyController extends HttpControllerBase {
    static prefix = '/body';
    static routes = [{ method: 'POST', path: '/', handler: 'read', authentication: false }];
    read() {
      handlerCalls += 1;
      return { status: 200 };
    }
  }
  const application = new Application({ websocket: { authentication: false } });
  application.registerHttpController(BodyController);
  const address = await application.listen({ port: 0 });
  try {
    const request = requestErrorHandled(
      nodeHttp.request({
        ...address,
        method: 'POST',
        path: '/body',
        headers: {
          'content-length': 64,
          'content-type': 'application/json',
          expect: '100-continue',
        },
      }),
    );
    const continued = new Promise((resolve) => request.once('continue', resolve));
    const closed = waitForClose(request);
    request.flushHeaders();
    await continued;
    request.write('{"iteration":');
    request.destroy();
    await closed;
    await application.close();
    assert.equal(handlerCalls, 0, `body-read cancellation, iteration=${iteration}`);
  } finally {
    await application.close();
  }
}

async function cancelDuringHandler(iteration) {
  const started = deferred();
  const aborted = deferred();
  const releaseHandler = deferred();
  class HandlerController extends HttpControllerBase {
    static prefix = '/handler';
    static routes = [{ method: 'GET', path: '/', handler: 'run', authentication: false }];
    async run(ctx) {
      started.resolve();
      ctx.signal.addEventListener('abort', aborted.resolve, { once: true });
      await releaseHandler.promise;
      return { status: 200, body: { late: true } };
    }
  }
  const errors = [];
  const application = new Application({
    http: { onError: (error) => errors.push(error) },
    websocket: { authentication: false },
  });
  application.registerHttpController(HandlerController);
  const address = await application.listen({ port: 0 });
  try {
    const request = requestErrorHandled(nodeHttp.get({ ...address, path: '/handler' }));
    const closed = waitForClose(request);
    await started.promise;
    request.destroy();
    await aborted.promise;
    releaseHandler.resolve();
    await closed;
    await application.close();
    assert.deepEqual(errors, [], `handler cancellation, iteration=${iteration}`);
  } finally {
    releaseHandler.resolve();
    await application.close();
  }
}

async function cancelWhileWaitingForJob(iteration) {
  const control = barrier();
  const jobRejected = deferred();
  const replacementCompleted = deferred();
  class JobController extends HttpControllerBase {
    static prefix = '/job';
    static routes = [{ method: 'GET', path: '/', handler: 'run', authentication: false }];
    async run(ctx) {
      try {
        await this.jobRunner.run(
          RaceJob,
          { state: control.state, value: 'late' },
          { signal: ctx.signal },
        );
      } catch (error) {
        jobRejected.resolve(error);
      }
      const replacement = await this.jobRunner.run(EchoJob, 'replacement');
      replacementCompleted.resolve(replacement);
      return { status: 200, body: { replacement } };
    }
  }
  const application = new Application({
    jobs: { poolSize: 1, terminationGracePeriod: 50 },
    websocket: { authentication: false },
  });
  application.registerHttpController(JobController);
  const address = await application.listen({ port: 0 });
  try {
    const request = requestErrorHandled(nodeHttp.get({ ...address, path: '/job' }));
    const closed = waitForClose(request);
    await reached(control.view, 0, 'HTTP job started');
    release(control.view, 1);
    await reached(control.view, 2, 'HTTP job result prepared');
    request.destroy();
    assert.ok(
      (await jobRejected.promise) instanceof JobAbortedError,
      `job wait cancellation, iteration=${iteration}`,
    );
    release(control.view, 3);
    assert.equal(await replacementCompleted.promise, 'replacement');
    await closed;
  } finally {
    release(control.view, 3);
    await application.close();
  }
}

async function cancelWhileWritingResponse(iteration) {
  const handlerStarted = deferred();
  const releaseHandler = deferred();
  class ResponseController extends HttpControllerBase {
    static prefix = '/response';
    static routes = [{ method: 'GET', path: '/', handler: 'run', authentication: false }];
    async run() {
      handlerStarted.resolve();
      await releaseHandler.promise;
      return { status: 200, body: 'x'.repeat(8 * 1024 * 1024) };
    }
  }
  const errors = [];
  const application = new Application({
    http: { onError: (error) => errors.push(error) },
    websocket: { authentication: false },
  });
  application.registerHttpController(ResponseController);
  const address = await application.listen({ port: 0 });
  try {
    const responseReceived = deferred();
    requestErrorHandled(
      nodeHttp.get({ ...address, path: '/response' }, (response) => {
        response.pause();
        responseReceived.resolve(response);
      }),
    );
    await handlerStarted.promise;
    releaseHandler.resolve();
    const response = await responseReceived.promise;
    const closed = waitForClose(response);
    response.destroy();
    await closed;
    await application.close();
    assert.deepEqual(errors, [], `response-write cancellation, iteration=${iteration}`);
  } finally {
    releaseHandler.resolve();
    await application.close();
  }
}

test(
  'HTTP-клиент отменяет запрос на каждой фазе без поздней записи или rejection',
  { timeout: 20_000 },
  async () => {
    for (let iteration = 1; iteration <= ITERATIONS; iteration += 1) {
      await cancelWhileReadingBody(iteration);
      await cancelDuringHandler(iteration);
      await cancelWhileWaitingForJob(iteration);
      await cancelWhileWritingResponse(iteration);
    }
  },
);

test(
  'закрытие WebSocket-сессии отменяет обработчик и не создаёт поздний ответ',
  { timeout: 10_000 },
  async () => {
    for (let iteration = 1; iteration <= ITERATIONS; iteration += 1) {
      const handlerStarted = deferred();
      const handlerAborted = deferred();
      const releaseHandler = deferred();
      const handlerCompleted = deferred();
      const disconnects = [];
      const errors = [];
      class RaceWebSocketController extends WebSocketControllerBase {
        static name = 'race';
        static events = [{ name: 'run', handler: 'run' }];
        async run(ctx) {
          handlerStarted.resolve();
          ctx.signal.addEventListener('abort', handlerAborted.resolve, { once: true });
          await releaseHandler.promise;
          handlerCompleted.resolve();
          return { late: true };
        }
      }
      const application = new Application({
        websocket: {
          authentication: false,
          onDisconnect: (ctx) => disconnects.push(ctx),
          onError: (error) => errors.push(error),
        },
      });
      application.registerWebSocketController(RaceWebSocketController);
      const address = await application.listen({ port: 0 });
      const socket = await openWebSocket(`ws://${address.address}:${address.port}/websocket`);
      try {
        socket.send(JSON.stringify({ controller: 'race', event: 'run', body: {} }));
        await handlerStarted.promise;
        const closed = closeWebSocket(socket);
        socket.close(4000, 'client cancellation');
        await closed;
        await handlerAborted.promise;
        releaseHandler.resolve();
        await handlerCompleted.promise;
        await application.close();
        assert.equal(disconnects.length, 1, `WebSocket iteration=${iteration}`);
        assert.equal(disconnects[0].signal.aborted, true, `WebSocket iteration=${iteration}`);
        assert.deepEqual(errors, [], `WebSocket iteration=${iteration}`);
      } finally {
        releaseHandler.resolve();
        socket.close();
        await application.close();
      }
    }
  },
);

test(
  'конкурентные Application.listen и close имеют единственный lifecycle-исход',
  { timeout: 10_000 },
  async () => {
    for (let iteration = 1; iteration <= ITERATIONS; iteration += 1) {
      const application = new Application({ websocket: { authentication: false } });
      const listening = application.listen({ port: 0 });
      const duplicateListen = application.listen({ port: 0 });
      const closing = application.close();
      await assert.rejects(duplicateListen, ApplicationStateError);
      await listening;
      assert.equal(application.close(), closing, `starting/close iteration=${iteration}`);
      await closing;

      const closedBeforeListen = new Application({ websocket: { authentication: false } });
      await closedBeforeListen.close();
      await assert.rejects(closedBeforeListen.listen({ port: 0 }), ApplicationStateError);

      const occupied = new Application({ websocket: { authentication: false } });
      const address = await occupied.listen({ port: 0 });
      const failing = new Application({ websocket: { authentication: false } });
      const failedListen = failing.listen({ port: address.port });
      const failedClose = failing.close();
      await assert.rejects(failedListen, { code: 'EADDRINUSE' });
      await failedClose;
      await assert.rejects(failing.listen({ port: 0 }), ApplicationStateError);
      await occupied.close();
    }
  },
);

test('JobRunner подтверждает очередь барьерами и освобождает слот ровно один раз', async () => {
  const runner = new JobRunner({ poolSize: 1, queueSize: 1 });
  const first = barrier();
  const second = barrier();
  try {
    const running = runner.run(RaceJob, { state: first.state, value: 'first' });
    await reached(first.view, 0, 'running job started');
    const queued = runner.run(RaceJob, { state: second.state, value: 'second' });
    assert.equal(Atomics.load(second.view, 0), 0, 'queued job started before the slot was free');

    release(first.view, 1);
    await reached(first.view, 2, 'running result prepared');
    release(first.view, 3);
    assert.deepEqual(await running, { value: 'first' });

    await reached(second.view, 0, 'queued job started after release');
    release(second.view, 1);
    await reached(second.view, 2, 'queued result prepared');
    release(second.view, 3);
    assert.deepEqual(await queued, { value: 'second' });
    assert.equal(await runner.run(EchoJob, 'third'), 'third');
  } finally {
    await runner.close();
  }
});

test(
  'JobRunner.close детерминированно конкурирует со всеми терминальными событиями',
  { timeout: 15_000 },
  async () => {
    for (const scenario of ['result', 'cancel', 'timeout', 'crash']) {
      for (const order of ['event-first', 'close-first']) {
        for (let iteration = 1; iteration <= ITERATIONS; iteration += 1) {
          await runCloseRace(scenario, order, iteration);
        }
      }
    }
  },
);
