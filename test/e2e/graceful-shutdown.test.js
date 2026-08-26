import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { Application } from '../../lib/framework/Application.js';
import { HttpControllerBase } from '../../lib/framework/HttpControllerBase.js';
import { WebSocketControllerBase } from '../../lib/framework/WebSocketControllerBase.js';
import {
  JobRunnerClosedError,
  JobTimedOutError,
  WorkerTerminatedError,
} from '../../lib/framework/errors.js';
import ShutdownJob from '../fixtures/jobs/shutdown-job.js';

const HTTP_SHUTDOWN_TIMEOUT = 250;
const JOB_POOL_SIZE = 2;
const JOB_TIMEOUT = 30;
const TERMINATION_GRACE_PERIOD = 30;
const JOB_SHUTDOWN_TIMEOUT = 50;
const WATCHDOG_TIMEOUT = 3_000;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function withWatchdog(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), WATCHDOG_TIMEOUT);
    }),
  ]).finally(() => clearTimeout(timer));
}

function jobErrorKind(error) {
  if (error instanceof JobTimedOutError) return 'JobTimedOutError';
  if (error instanceof WorkerTerminatedError) return 'WorkerTerminatedError';
  if (error instanceof JobRunnerClosedError) return 'JobRunnerClosedError';
  return error.constructor.name;
}

function request(address, path) {
  return new Promise((resolve, reject) => {
    const clientRequest = http.request(
      {
        agent: false,
        host: address.address,
        path,
        port: address.port,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ body: Buffer.concat(chunks).toString(), status: response.statusCode }),
        );
      },
    );
    clientRequest.on('error', reject);
    clientRequest.end();
  });
}

function openedWebSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, 'daevox.v1');
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
}

function rejectedWebSocket(url) {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, 'daevox.v1');
    let wasOpened = false;
    socket.addEventListener(
      'open',
      () => {
        wasOpened = true;
        socket.close();
      },
      { once: true },
    );
    socket.addEventListener('error', () => {}, { once: true });
    socket.addEventListener('close', () => resolve(!wasOpened), { once: true });
  });
}

function closedWebSocket(socket) {
  return new Promise((resolve) => {
    socket.addEventListener(
      'close',
      (event) => resolve({ code: event.code, reason: event.reason }),
      { once: true },
    );
  });
}

async function waitForJobStart(state, label) {
  const view = new Int32Array(state);
  if (Atomics.load(view, 0) === 1) return;
  await withWatchdog(Atomics.waitAsync(view, 0, 0).value, label);
  assert.equal(Atomics.load(view, 0), 1, `${label} did not start`);
}

function createHarness(iteration) {
  const quickHttpStarted = deferred();
  const releaseQuickHttp = deferred();
  const slowHttpStarted = deferred();
  const slowHttpAborted = deferred();
  const timedJobSubmitted = deferred();
  const timedJobSettled = deferred();
  const shutdownJobSubmitted = deferred();
  const shutdownJobSettled = deferred();
  const queuedJobSubmitted = deferred();
  const queuedJobSettled = deferred();
  const webSocketHandlerStarted = deferred();
  const webSocketHandlerSettled = deferred();
  const disconnected = deferred();
  const events = [];
  const disconnects = [];
  const timedJobState = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const shutdownJobState = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const queuedJobState = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const warmJobStates = Array.from(
    { length: JOB_POOL_SIZE },
    () => new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
  );

  class ShutdownHttpController extends HttpControllerBase {
    static prefix = '/shutdown';
    static routes = [
      { method: 'GET', path: '/quick', handler: 'quick' },
      { method: 'GET', path: '/slow', handler: 'slow' },
      { method: 'GET', path: '/job-timed', handler: 'timed' },
      { method: 'GET', path: '/job-running', handler: 'running' },
      { method: 'GET', path: '/job-queued', handler: 'queued' },
      { method: 'GET', path: '/job-warm', handler: 'warm' },
    ];

    async quick() {
      events.push('http-quick-started');
      quickHttpStarted.resolve();
      await releaseQuickHttp.promise;
      events.push('http-quick-completed');
      return { status: 200, body: { iteration, quick: true } };
    }

    async slow(ctx) {
      events.push('http-slow-started');
      slowHttpStarted.resolve();
      await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
      events.push('http-slow-aborted');
      slowHttpAborted.resolve();
      return { status: 200, body: { late: true } };
    }

    async timed() {
      events.push('job-timed-submitted');
      timedJobSubmitted.resolve();
      try {
        await this.jobRunner.run(
          ShutdownJob,
          { mode: 'hang', state: timedJobState },
          { timeout: JOB_TIMEOUT },
        );
      } catch (error) {
        const kind = jobErrorKind(error);
        events.push(`job-timed-${kind}`);
        timedJobSettled.resolve(kind);
        return { status: 503, body: { error: kind } };
      }
      throw new Error('timed job unexpectedly completed');
    }

    async running() {
      events.push('job-running-submitted');
      shutdownJobSubmitted.resolve();
      try {
        await this.jobRunner.run(ShutdownJob, { mode: 'hang', state: shutdownJobState });
      } catch (error) {
        const kind = jobErrorKind(error);
        events.push(`job-running-${kind}`);
        let nextRunError;
        try {
          this.jobRunner.run(ShutdownJob, { mode: 'complete', state: queuedJobState });
        } catch (runError) {
          nextRunError = jobErrorKind(runError);
        }
        events.push(`job-after-boundary-${nextRunError}`);
        shutdownJobSettled.resolve({ error: kind, nextRunError });
        return { status: 503, body: { error: kind } };
      }
      throw new Error('shutdown job unexpectedly completed');
    }

    async queued() {
      events.push('job-queued-submitted');
      const result = this.jobRunner.run(ShutdownJob, {
        mode: 'complete',
        state: queuedJobState,
      });
      queuedJobSubmitted.resolve();
      const value = await result;
      events.push('job-queued-completed');
      queuedJobSettled.resolve(value);
      return { status: 200, body: value };
    }

    async warm() {
      const results = await Promise.all(
        warmJobStates.map((state) => this.jobRunner.run(ShutdownJob, { mode: 'complete', state })),
      );
      return { status: 200, body: results };
    }
  }

  class ShutdownWebSocketController extends WebSocketControllerBase {
    static name = 'shutdown';
    static events = [{ name: 'wait', handler: 'wait' }];

    async wait(ctx) {
      events.push('websocket-handler-started');
      webSocketHandlerStarted.resolve();
      await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
      events.push('websocket-handler-aborted');
      webSocketHandlerSettled.resolve(ctx.signal.aborted);
    }
  }

  const application = new Application({
    http: { shutdownTimeout: HTTP_SHUTDOWN_TIMEOUT },
    jobs: {
      poolSize: JOB_POOL_SIZE,
      queueSize: 1,
      shutdownTimeout: JOB_SHUTDOWN_TIMEOUT,
      terminationGracePeriod: TERMINATION_GRACE_PERIOD,
    },
    websocket: {
      onDisconnect(ctx) {
        events.push('websocket-disconnected');
        disconnects.push(ctx);
        disconnected.resolve();
      },
    },
  });
  application.registerHttpController(ShutdownHttpController);
  application.registerWebSocketController(ShutdownWebSocketController);

  return {
    application,
    barriers: {
      disconnected,
      queuedJobSettled,
      queuedJobSubmitted,
      quickHttpStarted,
      releaseQuickHttp,
      shutdownJobSettled,
      shutdownJobSubmitted,
      slowHttpAborted,
      slowHttpStarted,
      timedJobSettled,
      timedJobSubmitted,
      webSocketHandlerSettled,
      webSocketHandlerStarted,
    },
    disconnects,
    events,
    states: { queuedJobState, shutdownJobState, timedJobState },
  };
}

async function runScenario(iteration) {
  const harness = createHarness(iteration);
  const { application, barriers, disconnects, events, states } = harness;
  const address = await application.listen({ port: 0 });
  const webSocketUrl = `ws://${address.address}:${address.port}/websocket`;
  let socket;
  let closing;

  try {
    assert.deepEqual(await withWatchdog(request(address, '/shutdown/job-warm'), 'Worker warmup'), {
      body: '[{"completed":true},{"completed":true}]',
      status: 200,
    });
    socket = await withWatchdog(openedWebSocket(webSocketUrl), 'WebSocket connection');
    const socketClosed = closedWebSocket(socket);
    socket.send(JSON.stringify({ controller: 'shutdown', event: 'wait', body: {} }));

    const quickRequest = request(address, '/shutdown/quick');
    const slowRequest = request(address, '/shutdown/slow').catch((error) => error);
    const timedJobRequest = request(address, '/shutdown/job-timed');
    const shutdownJobRequest = request(address, '/shutdown/job-running').catch((error) => error);

    await Promise.all([
      withWatchdog(barriers.quickHttpStarted.promise, 'quick HTTP handler'),
      withWatchdog(barriers.slowHttpStarted.promise, 'slow HTTP handler'),
      withWatchdog(barriers.timedJobSubmitted.promise, 'timed job submission'),
      withWatchdog(barriers.shutdownJobSubmitted.promise, 'shutdown job submission'),
      withWatchdog(barriers.webSocketHandlerStarted.promise, 'WebSocket handler'),
      waitForJobStart(states.timedJobState, 'timed job'),
      waitForJobStart(states.shutdownJobState, 'shutdown job'),
    ]);

    const queuedJobRequest = request(address, '/shutdown/job-queued');
    await withWatchdog(barriers.queuedJobSubmitted.promise, 'queued job submission');
    assert.equal(Atomics.load(new Int32Array(states.queuedJobState), 0), 0);

    const startedAt = performance.now();
    const closePromises = [application.close(), application.close(), application.close()];
    assert.equal(closePromises[1], closePromises[0]);
    assert.equal(closePromises[2], closePromises[0]);
    closing = closePromises[0];
    barriers.releaseQuickHttp.resolve();

    const rejectedHttpRequest = request(address, '/shutdown/quick').then(
      () => false,
      () => true,
    );
    const [httpRejected, upgradeRejected] = await Promise.all([
      withWatchdog(rejectedHttpRequest, 'HTTP shutdown rejection'),
      withWatchdog(rejectedWebSocket(webSocketUrl), 'WebSocket shutdown rejection'),
    ]);
    assert.equal(httpRejected, true);
    assert.equal(upgradeRejected, true);

    assert.deepEqual(await withWatchdog(quickRequest, 'quick HTTP completion'), {
      body: `{"iteration":${iteration},"quick":true}`,
      status: 200,
    });
    assert.deepEqual(await withWatchdog(timedJobRequest, 'timed job response'), {
      body: '{"error":"JobTimedOutError"}',
      status: 503,
    });
    assert.deepEqual(await withWatchdog(queuedJobRequest, 'queued job response'), {
      body: '{"completed":true}',
      status: 200,
    });

    assert.deepEqual(await withWatchdog(socketClosed, 'WebSocket shutdown close'), {
      code: 1001,
      reason: 'Server shutting down',
    });
    await Promise.all([
      withWatchdog(barriers.disconnected.promise, 'onDisconnect'),
      withWatchdog(barriers.slowHttpAborted.promise, 'slow HTTP cancellation'),
      withWatchdog(barriers.webSocketHandlerSettled.promise, 'WebSocket handler cancellation'),
    ]);

    await withWatchdog(Promise.all(closePromises), 'concurrent Application.close calls');
    const elapsed = performance.now() - startedAt;
    const upperBound =
      HTTP_SHUTDOWN_TIMEOUT + JOB_SHUTDOWN_TIMEOUT + TERMINATION_GRACE_PERIOD + 400;
    assert.ok(elapsed <= upperBound, `iteration ${iteration} close took ${elapsed} ms`);

    assert.equal(await barriers.timedJobSettled.promise, 'JobTimedOutError');
    assert.deepEqual(await barriers.queuedJobSettled.promise, { completed: true });
    assert.deepEqual(await barriers.shutdownJobSettled.promise, {
      error: 'WorkerTerminatedError',
      nextRunError: 'JobRunnerClosedError',
    });
    await Promise.all([slowRequest, shutdownJobRequest]);

    assert.equal(disconnects.length, 1);
    assert.equal(disconnects[0].code, 1001);
    assert.equal(disconnects[0].reason, 'Server shutting down');
    assert.equal(disconnects[0].signal.aborted, true);
    assert.equal(await barriers.webSocketHandlerSettled.promise, true);
    assert.ok(events.indexOf('websocket-disconnected') < events.indexOf('http-slow-aborted'));
    assert.ok(
      events.indexOf('http-slow-aborted') < events.indexOf('job-running-WorkerTerminatedError'),
    );
    assert.ok(events.indexOf('job-queued-completed') < events.indexOf('http-slow-aborted'));
  } finally {
    socket?.close();
    await (closing ?? application.close());
  }
}

test(
  'Application завершает совместную HTTP, WebSocket и Worker-нагрузку в согласованном порядке',
  { timeout: 10_000 },
  async () => {
    const iterations = Array.from({ length: 4 }, (_, index) => index + 1);
    for (let index = 0; index < iterations.length; index += 2) {
      await Promise.all(iterations.slice(index, index + 2).map(runScenario));
    }
  },
);
