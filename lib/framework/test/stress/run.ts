class TestAppState {
  readonly marker = undefined;
}
import { spawn } from 'node:child_process';

// oxlint-disable typescript/no-extraneous-class -- DTO classes intentionally provide nominal identity.
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { availableParallelism, cpus, platform, release } from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Application } from '../../src/Application.ts';
import { EventListenerBase } from '../../src/EventListenerBase.ts';
import { HttpControllerBase } from '../../src/HttpControllerBase.ts';
import { WebSocketControllerBase } from '../../src/WebSocketControllerBase.ts';
import { EventDroppedError, EventQueueFullError } from '../../src/errors.ts';
import { classifySteps, distribution } from './analysis.ts';
import { createShutdownChaosPlan, createStressConfig, smokeStressConfig } from './config.ts';
import StressJob from './fixtures/stress-job.ts';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

function argument(name: any, fallback: any = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function numberArgument(name: any, fallback: any = undefined) {
  const value = Number(argument(name, fallback));
  if (!Number.isFinite(value)) throw new TypeError(`--${name} must be a number`);
  return value;
}

function environment() {
  const processors = cpus();
  return {
    architecture: process.arch,
    availableParallelism: availableParallelism(),
    cpuCount: processors.length,
    cpuModel: processors[0]?.model ?? 'unknown',
    node: process.version,
    platform: platform(),
    release: release(),
  };
}

function request(address: any, route: any, body: any = undefined) {
  const startedAt = performance.now();
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  return new Promise<any>((resolve: any, reject: any) => {
    const clientRequest = http.request(
      {
        ...address,
        agent: request.agent,
        headers:
          serialized === undefined
            ? undefined
            : {
                'content-length': Buffer.byteLength(serialized),
                'content-type': 'application/json',
              },
        method: serialized === undefined ? 'GET' : 'POST',
        path: route,
      },
      (response: any) => {
        const chunks: any[] = [];
        response.on('data', (chunk: any) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          try {
            resolve({
              latencyMs: performance.now() - startedAt,
              status: response.statusCode,
              value: text ? JSON.parse(text) : undefined,
            });
          } catch (error: any) {
            reject(error);
          }
        });
      },
    );
    clientRequest.setTimeout(5_000, () => clientRequest.destroy(new Error('HTTP timeout')));
    clientRequest.on('error', reject);
    clientRequest.end(serialized);
  });
}
request.agent = new http.Agent({ keepAlive: true });

function openWebSocket(url: any, protocol: any = 'daevox.v1') {
  const startedAt = performance.now();
  return new Promise<any>((resolve: any, reject: any) => {
    const socket = new WebSocket(url, protocol);
    socket.addEventListener(
      'open',
      () => resolve({ latencyMs: performance.now() - startedAt, socket }),
      { once: true },
    );
    socket.addEventListener('error', reject, { once: true });
  });
}

function closeWebSocket(socket: any) {
  if (socket.readyState >= WebSocket.CLOSING) return Promise.resolve();
  return new Promise<any>((resolve: any) => {
    socket.addEventListener('close', resolve, { once: true });
    socket.close();
  });
}

function webSocketRequest(socket: any, message: any) {
  const startedAt = performance.now();
  return new Promise<any>((resolve: any, reject: any) => {
    const onError = () => reject(new Error('WebSocket operation failed'));
    socket.addEventListener(
      'message',
      (event: any) => {
        socket.removeEventListener('error', onError);
        try {
          resolve({
            latencyMs: performance.now() - startedAt,
            value: JSON.parse(event.data),
          });
        } catch (error: any) {
          reject(error);
        }
      },
      { once: true },
    );
    socket.addEventListener('error', onError, { once: true });
    socket.send(JSON.stringify(message));
  });
}

function resourceSnapshot() {
  const memory = process.memoryUsage();
  return { heapUsedBytes: memory.heapUsed, rssBytes: memory.rss };
}

async function waitFor(predicate: any, label: any) {
  const deadline = performance.now() + 2_000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`${label} timed out`);
    await new Promise<any>((resolve: any) => setTimeout(resolve, 0));
  }
}

function stressMessage(sequence: any) {
  return { controller: 'stress', event: 'echo', body: { sequence } };
}

async function measureStep({ concurrency, connections, durationMs, limits, operation }: any) {
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  const latencies: any[] = [];
  const queueWait: any[] = [];
  const execution: any[] = [];
  const errors: any[] = [];
  const workerIds = new Set();
  const startMemory = resourceSnapshot();
  let maxHeap = startMemory.heapUsedBytes;
  let maxRss = startMemory.rssBytes;
  let successes = 0;
  let failures = 0;
  const state: any = { fatal: undefined };
  const deadline = performance.now() + durationMs;
  const sampler = setInterval(() => {
    const sample = resourceSnapshot();
    maxHeap = Math.max(maxHeap, sample.heapUsedBytes);
    maxRss = Math.max(maxRss, sample.rssBytes);
    if (maxRss > limits.maxMemoryBytes) {
      state.fatal = new Error('stress memory limit exceeded');
    }
  }, 25);
  histogram.enable();
  const measuredAt = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async (_: any, worker: any) => {
      while (performance.now() < deadline && !state.fatal) {
        const startedAt = performance.now();
        try {
          const result = await operation(worker);
          if (result?.status !== undefined && result.status >= 400) {
            throw new Error(result.value?.error ?? `HTTP ${result.status}`);
          }
          successes += 1;
          latencies.push(result?.latencyMs ?? performance.now() - startedAt);
          const value = result?.value?.body ?? result?.value;
          if (Number.isFinite(value?.queueWaitMs)) queueWait.push(value.queueWaitMs);
          if (Number.isFinite(value?.executionMs)) execution.push(value.executionMs);
          if (Number.isInteger(value?.threadId)) workerIds.add(value.threadId);
        } catch (error: any) {
          failures += 1;
          if (errors.length < 10) errors.push(error.message);
        }
      }
    }),
  );
  const measuredMs = performance.now() - measuredAt;
  histogram.disable();
  clearInterval(sampler);
  if (state.fatal) throw state.fatal;
  const endMemory = resourceSnapshot();
  maxHeap = Math.max(maxHeap, endMemory.heapUsedBytes);
  maxRss = Math.max(maxRss, endMemory.rssBytes);
  const attempts = successes + failures;
  return {
    attempts,
    connections,
    errorRate: attempts === 0 ? 0 : failures / attempts,
    errors,
    eventLoopLagMs: {
      max: histogram.max / 1_000_000,
      p50: histogram.percentile(50) / 1_000_000,
      p95: histogram.percentile(95) / 1_000_000,
      p99: histogram.percentile(99) / 1_000_000,
    },
    executionMs: distribution(execution),
    heapUsedBytes: { end: endMemory.heapUsedBytes, max: maxHeap, start: startMemory.heapUsedBytes },
    latencyMs: distribution(latencies),
    measuredMs,
    queueWaitMs: distribution(queueWait),
    rssBytes: { end: endMemory.rssBytes, max: maxRss, start: startMemory.rssBytes },
    successes,
    throughputPerSecond: successes / (measuredMs / 1_000),
    workers: workerIds.size,
  };
}

async function runRamp(name: any, config: any, resource: any) {
  const steps: any[] = [];
  try {
    for (const step of config.steps) {
      steps.push({
        concurrency: step.concurrency,
        metrics: await measureStep({
          ...step,
          connections: resource.connections?.(step) ?? 0,
          limits: config.limits,
          operation: resource.operation,
        }),
      });
    }
    globalThis.gc?.();
    await new Promise<any>((resolve: any) => setTimeout(resolve, 25));
    const recovery: any = await measureStep({
      concurrency: config.steps[0].concurrency,
      connections: resource.connections?.(config.steps[0]) ?? 0,
      durationMs: config.recoveryDurationMs,
      limits: config.limits,
      operation: resource.operation,
    });
    globalThis.gc?.();
    await new Promise<any>((resolve: any) => setTimeout(resolve, 25));
    recovery.settledMemory = resourceSnapshot();
    return {
      analysis: classifySteps(
        steps.map((step: any) => step.metrics),
        { recovery, ...config.thresholds },
      ),
      name,
      recovery,
      steps,
    };
  } finally {
    await resource.close();
  }
}

async function createJobResource(config: any, poolSize: any, durationMode: any) {
  let mixedIndex = 0;
  class StressHttpController extends HttpControllerBase {
    static prefix = '/stress';
    static routes = [{ method: 'POST', path: '/job', handler: 'job' }] as const;
    async job() {
      const durationMs =
        durationMode === 'mixed'
          ? mixedIndex++ % 2 === 0
            ? config.jobDurationsMs.short
            : config.jobDurationsMs.long
          : config.jobDurationsMs[durationMode];
      try {
        const result = await this.jobRunner.run(StressJob, {
          durationMs,
          submittedAtNs: process.hrtime.bigint(),
        });
        return { status: 200, body: result };
      } catch (error: any) {
        return { status: 503, body: { error: error.constructor.name } };
      }
    }
  }
  const application = new Application({
    appState: TestAppState,
    jobs: { poolSize, queueSize: config.queueSize },
  });
  application.registerHttpController(StressHttpController);
  const address = await application.listen({ port: 0 });
  return {
    close: () => application.close(),
    operation: () => request(address, '/stress/job', {}),
  };
}

async function queueScenario(config: any) {
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const gateView = new Int32Array(gate);
  const order = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  let submissions = 0;
  class QueueController extends HttpControllerBase {
    static prefix = '/stress';
    static routes = [{ method: 'POST', path: '/queue', handler: 'queue' }] as const;
    async queue(_appState: any, ctx: any) {
      submissions += 1;
      try {
        const result = await this.jobRunner.run(StressJob, {
          durationMs: 0,
          gate: ctx.body.block ? gate : undefined,
          label: ctx.body.label,
          order,
          submittedAtNs: process.hrtime.bigint(),
        });
        return { status: 200, body: result };
      } catch (error: any) {
        return { status: 503, body: { error: error.constructor.name } };
      }
    }
  }
  const application = new Application({
    appState: TestAppState,
    jobs: { poolSize: 1, queueSize: config.queueSize },
  });
  application.registerHttpController(QueueController);
  const address = await application.listen({ port: 0 });
  try {
    const running = request(address, '/stress/queue', { block: true, label: 'running' });
    await waitFor(() => Atomics.load(gateView, 1) === 1, 'running queue job');
    const queued: any[] = [];
    for (let index = 0; index < config.queueSize; index += 1) {
      queued.push(request(address, '/stress/queue', { label: `queued-${index}` }));
      await waitFor(() => submissions === index + 2, `queue submission ${index}`);
    }
    const overflow = await request(address, '/stress/queue', { label: 'overflow' });
    if (overflow.status !== 503 || overflow.value.error !== 'JobQueueFullError') {
      throw new Error(`unexpected queue overflow result: ${JSON.stringify(overflow)}`);
    }
    Atomics.store(gateView, 0, 1);
    Atomics.notify(gateView, 0);
    const results = await Promise.all([running, ...queued]);
    const queuedResults = results.slice(1);
    const fifo = queuedResults.every(
      (result: any, index: any) =>
        result.value.label === `queued-${index}` && result.value.order === index + 1,
    );
    const recovery = await request(address, '/stress/queue', { label: 'recovery' });
    if (!fifo || recovery.status !== 200) throw new Error('queue did not preserve FIFO or recover');
    return {
      fifo,
      overflow: { error: overflow.value.error, status: overflow.status },
      queueSize: config.queueSize,
      recovery: { latencyMs: recovery.latencyMs, status: recovery.status },
    };
  } finally {
    Atomics.store(gateView, 0, 1);
    Atomics.notify(gateView, 0);
    await application.close();
  }
}

async function applicationEventScenario(config: any) {
  let releaseSerial: any;
  const serialGate = new Promise<any>((resolve: any) => {
    releaseSerial = resolve;
  });
  let resolveSerialStarted: any;
  const serialStarted = new Promise<any>((resolve: any) => {
    resolveSerialStarted = resolve;
  });
  let resolveParallelHandled: any;
  const parallelHandled = new Promise<any>((resolve: any) => {
    resolveParallelHandled = resolve;
  });
  const handled: any[] = [];
  const unhandled: any[] = [];
  const onUnhandled = (error: any) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);

  class StressEvent {
    declare label: any;

    constructor(label: any) {
      this.label = label;
    }
  }
  class SerialEventListener extends EventListenerBase {
    static name = 'stress-serial';
    static events = [{ name: 'work', data: StressEvent, handler: 'work' }] as const;
    async work(_appState: any, data: any) {
      handled.push(data.label);
      if (data.label === 'active') {
        resolveSerialStarted();
        await serialGate;
      }
    }
  }
  class ParallelEventListener extends EventListenerBase {
    static name = 'stress-parallel';
    static events = [{ name: 'work', data: StressEvent, handler: 'work' }] as const;
    work(_appState: any, data: any) {
      handled.push(data.label);
      resolveParallelHandled();
    }
  }
  class EventController extends HttpControllerBase {
    static prefix = '/stress/events';
    static routes = [{ method: 'POST', path: '/', handler: 'push' }] as const;
    push(_appState: any, ctx: any) {
      const listener = ctx.body.parallel ? 'stress-parallel' : 'stress-serial';
      try {
        this.events.push({ listener, event: 'work' }, new StressEvent(ctx.body.label));
        return { status: 202, body: { accepted: true } };
      } catch (error: any) {
        if (error instanceof EventQueueFullError) {
          return { status: 503, body: { error: 'EventQueueFullError' } };
        }
        throw error;
      }
    }
  }

  const application = new Application({
    appState: TestAppState,
    events: { queueSize: config.queueSize },
  });
  application.registerEventListener(SerialEventListener);
  application.registerEventListener(ParallelEventListener);
  application.registerHttpController(EventController);
  const address = await application.listen({ port: 0 });
  try {
    await request(address, '/stress/events', { label: 'active' });
    await serialStarted;
    for (let index = 0; index < config.queueSize; index += 1) {
      const accepted = await request(address, '/stress/events', { label: `queued-${index}` });
      if (accepted.status !== 202) throw new Error('event mailbox rejected within capacity');
    }
    const overflow = await request(address, '/stress/events', { label: 'overflow' });
    if (overflow.status !== 503 || overflow.value.error !== 'EventQueueFullError') {
      throw new Error(`unexpected event overflow result: ${JSON.stringify(overflow)}`);
    }
    const parallel = await request(address, '/stress/events', {
      label: 'parallel',
      parallel: true,
    });
    await parallelHandled;
    if (parallel.status !== 202) throw new Error('parallel listener was blocked');
    releaseSerial();
    await application.close();
    await new Promise<any>((resolve: any) => setImmediate(resolve));
    if (unhandled.length > 0) throw new Error('application events produced unhandled rejection');
    return {
      handled: handled.length,
      overflow: { error: overflow.value.error, status: overflow.status },
      parallel: true,
      queueSize: config.queueSize,
      unhandledRejections: unhandled.length,
    };
  } finally {
    releaseSerial();
    process.off('unhandledRejection', onUnhandled);
    await application.close();
  }
}

async function applicationEventThroughput(config: any) {
  const acceptedIds = new Set();
  const handledIds = new Set();
  const queueWaitMs: any[] = [];
  const listenerOrders = { fast: 0, slow: 0 };
  const handledOrders: Record<string, number> = { fast: 0, slow: 0 };
  let duplicates = 0;
  let expectedErrors = 0;
  let fifoViolations = 0;
  let nextId = 1;
  let observedErrors = 0;
  let rejected = 0;

  class ThroughputEvent {
    declare acceptedAt: any;
    declare id: any;
    declare listener: any;
    declare order: any;
    declare poison: any;

    constructor({ acceptedAt, id, listener, order, poison }: any) {
      this.acceptedAt = acceptedAt;
      this.id = id;
      this.listener = listener;
      this.order = order;
      this.poison = poison;
    }
  }

  function record(data: any) {
    if (handledIds.has(data.id)) duplicates += 1;
    handledIds.add(data.id);
    if (data.order !== handledOrders[data.listener]) fifoViolations += 1;
    handledOrders[data.listener] += 1;
    queueWaitMs.push(performance.now() - data.acceptedAt);
  }

  class FastThroughputListener extends EventListenerBase {
    static name = 'throughput-fast';
    static events = [{ name: 'work', data: ThroughputEvent, handler: 'work' }] as const;
    work(_appState: any, data: any) {
      record(data);
      if (data.poison) throw new Error(`event poison:${data.id}`);
    }
  }

  class SlowThroughputListener extends EventListenerBase {
    static name = 'throughput-slow';
    static events = [{ name: 'work', data: ThroughputEvent, handler: 'work' }] as const;
    async work(_appState: any, data: any) {
      record(data);
      await new Promise<any>((resolve: any) => setTimeout(resolve, 2));
      if (data.poison) throw new Error(`event poison:${data.id}`);
    }
  }

  function push(sender: any, input: any) {
    const listener = input.listener === 'slow' ? 'slow' : 'fast';
    const id = nextId++;
    const poison = (acceptedIds.size + 1) % 97 === 0;
    const data = new ThroughputEvent({
      acceptedAt: performance.now(),
      id,
      listener,
      order: listenerOrders[listener],
      poison,
    });
    try {
      sender.push({ listener: `throughput-${listener}`, event: 'work' }, data);
      listenerOrders[listener] += 1;
      acceptedIds.add(id);
      if (poison) expectedErrors += 1;
      return { accepted: true, id };
    } catch (error: any) {
      if (!(error instanceof EventQueueFullError)) throw error;
      rejected += 1;
      return { accepted: false, error: 'EventQueueFullError' };
    }
  }

  class ThroughputHttpController extends HttpControllerBase {
    static prefix = '/stress/event-throughput';
    static routes = [{ method: 'POST', path: '/', handler: 'push' }] as const;
    push(_appState: any, ctx: any) {
      const result = push(this.events, ctx.body);
      return { status: result.accepted ? 202 : 503, body: result };
    }
  }

  class ThroughputWebSocketController extends WebSocketControllerBase {
    static name = 'event-throughput';
    static events = [{ name: 'push', handler: 'push' }] as const;
    push(_appState: any, ctx: any) {
      return push(this.events, ctx.body);
    }
  }

  const application = new Application({
    appState: TestAppState,
    events: {
      onError: () => {
        observedErrors += 1;
      },
      queueSize: Math.max(config.queueSize, config.limits.maxConcurrency * 16),
    },
  });
  application.registerEventListener(FastThroughputListener);
  application.registerEventListener(SlowThroughputListener);
  application.registerHttpController(ThroughputHttpController);
  application.registerWebSocketController(ThroughputWebSocketController);
  const address = await application.listen({ port: 0 });
  const sockets = await Promise.all(
    Array.from(
      { length: config.limits.maxConcurrency },
      async () => (await openWebSocket(`ws://${address.address}:${address.port}/websocket`)).socket,
    ),
  );
  let operationIndex = 0;

  async function measureEventStep(step: any) {
    const queueWaitStart = queueWaitMs.length;
    const acceptedStart = acceptedIds.size;
    const metrics: any = await measureStep({
      ...step,
      connections: sockets.length,
      limits: config.limits,
      operation: async (worker: any) => {
        const current = operationIndex++;
        const body = { listener: current % 2 === 0 ? 'fast' : 'slow' };
        if (current % 2 === 0) {
          return request(address, '/stress/event-throughput', body);
        }
        return webSocketRequest(sockets[worker], {
          controller: 'event-throughput',
          event: 'push',
          body,
        });
      },
    });
    await waitFor(
      () => handledIds.size >= acceptedIds.size,
      `event throughput drain after ${step.concurrency}`,
    );
    metrics.eventQueueWaitMs = distribution(queueWaitMs.slice(queueWaitStart));
    metrics.eventsAccepted = acceptedIds.size - acceptedStart;
    return metrics;
  }

  try {
    const steps: any[] = [];
    for (const step of config.steps) {
      steps.push({ concurrency: step.concurrency, metrics: await measureEventStep(step) });
    }
    const recovery: any = await measureEventStep({
      concurrency: config.steps[0].concurrency,
      durationMs: config.recoveryDurationMs,
    });
    const accounting = {
      accepted: acceptedIds.size,
      duplicates,
      expectedErrors,
      fifoViolations,
      handled: handledIds.size,
      observedErrors,
      rejected,
    };
    if (
      accounting.accepted !== accounting.handled ||
      duplicates !== 0 ||
      fifoViolations !== 0 ||
      expectedErrors !== observedErrors
    ) {
      throw new Error(`application event accounting failed: ${JSON.stringify(accounting)}`);
    }
    return {
      accounting,
      analysis: classifySteps(
        steps.map((step: any) => ({
          ...step.metrics,
          queueWaitMs: step.metrics.eventQueueWaitMs,
        })),
        {
          ...config.thresholds,
          recovery: { ...recovery, queueWaitMs: recovery.eventQueueWaitMs },
        },
      ),
      name: 'application-event-throughput',
      recovery,
      steps,
    };
  } finally {
    await Promise.all(sockets.map(closeWebSocket));
    await application.close();
  }
}

async function applicationEventShutdownChaos(config: any) {
  const decisions = createShutdownChaosPlan(config.eventChaosSeed, config.eventShutdownIterations);
  const iterations: any[] = [];

  for (const decision of decisions) {
    let abortFirst: any;
    let accepted = 0;
    let abortedActive = 0;
    let dropped = 0;
    let duplicates = 0;
    let handled = 0;
    let resolveFirstStarted: any;
    const firstStarted = new Promise<any>((resolve: any) => {
      resolveFirstStarted = resolve;
    });
    const seen = new Set();
    const producerFailures: Record<string, any> = {};
    const unexpectedErrors: any[] = [];
    const unhandled: any[] = [];
    const onUnhandled = (error: any) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);

    function recordProducerFailure(reason: any) {
      producerFailures[reason] = (producerFailures[reason] ?? 0) + 1;
    }

    async function observeProducer(producer: any, operation: any) {
      try {
        const result = await operation;
        if (producer === 'http' && result.status !== 202) {
          recordProducerFailure(`HTTP_${result.status}`);
        }
        const code = result.value?.body?.error?.code;
        if (producer === 'websocket' && code) recordProducerFailure(code);
        return result;
      } catch (error: any) {
        recordProducerFailure(error.code ?? error.message ?? error.constructor.name);
        return undefined;
      }
    }

    class ChaosEvent {
      declare id: any;

      constructor(id: any) {
        this.id = id;
      }
    }

    class ChaosListener extends EventListenerBase {
      static name = 'chaos';
      static events = [{ name: 'work', data: ChaosEvent, handler: 'work' }] as const;
      async work(_appState: any, data: any, { signal }: any) {
        if (seen.has(data.id)) duplicates += 1;
        seen.add(data.id);
        if (data.id === 0) {
          resolveFirstStarted();
          await new Promise<any>((resolve: any) => {
            abortFirst = () => {
              abortedActive += 1;
              resolve();
            };
            signal.addEventListener('abort', abortFirst, { once: true });
          });
          return;
        }
        handled += 1;
      }
    }

    function push(sender: any, id: any) {
      sender.push({ listener: 'chaos', event: 'work' }, new ChaosEvent(id));
      accepted += 1;
      return { accepted: true, id };
    }

    class ChaosHttpController extends HttpControllerBase {
      static prefix = '/stress/event-chaos';
      static routes = [{ method: 'POST', path: '/', handler: 'push' }] as const;
      push(_appState: any, ctx: any) {
        return { status: 202, body: push(this.events, ctx.body.id) };
      }
    }

    class ChaosWebSocketController extends WebSocketControllerBase {
      static name = 'event-chaos';
      static events = [{ name: 'push', handler: 'push' }] as const;
      push(_appState: any, ctx: any) {
        return push(this.events, ctx.body.id);
      }
    }

    const application = new Application({
      appState: TestAppState,
      events: {
        onError(error: any) {
          if (error instanceof EventDroppedError) dropped += 1;
          else unexpectedErrors.push(error.message);
        },
        queueSize: config.queueSize,
        shutdownTimeout: 5,
      },
      http: { shutdownTimeout: 50 },
      websocket: { shutdownTimeout: 50 },
    });
    application.registerEventListener(ChaosListener);
    application.registerHttpController(ChaosHttpController);
    application.registerWebSocketController(ChaosWebSocketController);
    const address = await application.listen({ port: 0 });
    const websocketUrl = `ws://${address.address}:${address.port}/websocket`;
    const operationCount = decision.producers.length;
    const sockets = await Promise.all(
      Array.from(
        { length: operationCount },
        async () => (await openWebSocket(websocketUrl)).socket,
      ),
    );

    try {
      const first = request(address, '/stress/event-chaos', { id: 0 });
      await firstStarted;
      const operations: any[] = [];
      for (let id = 1; id <= operationCount; id += 1) {
        const producer = decision.producers[id - 1];
        if (producer === 'http') {
          operations.push(
            observeProducer(producer, request(address, '/stress/event-chaos', { id })),
          );
        } else {
          operations.push(
            observeProducer(
              producer,
              webSocketRequest(sockets[id - 1], {
                controller: 'event-chaos',
                event: 'push',
                body: { id },
              }),
            ),
          );
        }
      }
      await new Promise<any>((resolve: any) => setTimeout(resolve, decision.closeDelayMs));
      const startedAt = performance.now();
      const closing = application.close();
      await Promise.allSettled([first, ...operations]);
      await closing;
      const closeMs = performance.now() - startedAt;
      if (unexpectedErrors.length > 0) {
        throw new Error(`unexpected chaos errors: ${unexpectedErrors.join(', ')}`);
      }
      const result = {
        abortedActive,
        accepted,
        closeMs,
        dropped,
        duplicates,
        handled,
        producerFailures,
        unhandledRejections: unhandled.length,
      };
      if (
        accepted !== handled + dropped + abortedActive ||
        duplicates !== 0 ||
        unhandled.length !== 0
      ) {
        throw new Error(`application event shutdown accounting failed: ${JSON.stringify(result)}`);
      }
      iterations.push(result);
    } finally {
      abortFirst?.();
      await Promise.all(sockets.map(closeWebSocket));
      await application.close();
      process.off('unhandledRejection', onUnhandled);
    }
  }

  return {
    decisions,
    iterations,
    name: 'application-event-shutdown-chaos',
    seed: config.eventChaosSeed,
  };
}

async function createWebSocketApplication() {
  class StressWebSocketController extends WebSocketControllerBase {
    static name = 'stress';
    static events = [{ name: 'echo', handler: 'echo' }] as const;
    async echo(_appState: any, ctx: any) {
      return ctx.body;
    }
  }
  const application = new Application({
    appState: TestAppState,
    websocket: { maxPayload: 64 * 1024 },
  });
  application.registerWebSocketController(StressWebSocketController);
  const address = await application.listen({ port: 0 });
  return {
    application,
    url: `ws://${address.address}:${address.port}/websocket`,
  };
}

async function websocketProfiles(config: any) {
  const profiles: Record<string, any> = {};
  {
    const { application, url } = await createWebSocketApplication();
    const sockets = new Set();
    profiles.handshake = await runRamp('websocket-handshake', config, {
      close: async () => {
        await Promise.all([...sockets].map(closeWebSocket));
        await application.close();
      },
      connections: (step: any) => step.concurrency,
      operation: async () => {
        const opened = await openWebSocket(url);
        sockets.add(opened.socket);
        await closeWebSocket(opened.socket);
        sockets.delete(opened.socket);
        return { latencyMs: opened.latencyMs, value: {} };
      },
    });
  }
  {
    const { application, url } = await createWebSocketApplication();
    const sockets: any[] = [];
    const counts = config.steps.map((step: any) =>
      Math.min(config.limits.maxConnections, step.concurrency * 4),
    );
    const steps: any[] = [];
    try {
      for (let index = 0; index < counts.length; index += 1) {
        while (sockets.length < counts[index]) sockets.push((await openWebSocket(url)).socket);
        steps.push({
          connections: sockets.length,
          metrics: await measureStep({
            concurrency: 1,
            connections: sockets.length,
            durationMs: config.steps[index].durationMs,
            limits: config.limits,
            operation: async () => {
              await new Promise<any>((resolve: any) => setTimeout(resolve, 25));
              return { latencyMs: 0, value: {} };
            },
          }),
        });
      }
      profiles.idle = { name: 'websocket-idle', steps };
    } finally {
      await Promise.all(sockets.map(closeWebSocket));
      await application.close();
    }
  }
  {
    const { application, url } = await createWebSocketApplication();
    const sockets = await Promise.all(
      Array.from(
        { length: config.limits.maxConcurrency },
        async () => (await openWebSocket(url)).socket,
      ),
    );
    let sequence = 0;
    let singleChain = Promise.resolve();
    profiles.singleSession = await runRamp('websocket-single-session', config, {
      close: async () => {
        await Promise.all(sockets.map(closeWebSocket));
        await application.close();
      },
      connections: () => sockets.length,
      operation: () => {
        const expected = sequence++;
        const operation = singleChain.then(async () => {
          const result = await webSocketRequest(sockets[0], stressMessage(expected));
          if (result.value.body.sequence !== expected) {
            throw new Error(`single-session sequence ${expected} was reordered`);
          }
          return result;
        });
        singleChain = operation.catch(() => {});
        return operation;
      },
    });
    const { application: parallelApplication, url: parallelUrl } =
      await createWebSocketApplication();
    const parallelSockets = await Promise.all(
      Array.from(
        { length: config.limits.maxConcurrency },
        async () => (await openWebSocket(parallelUrl)).socket,
      ),
    );
    profiles.manySessions = await runRamp('websocket-many-sessions', config, {
      close: async () => {
        await Promise.all(parallelSockets.map(closeWebSocket));
        await parallelApplication.close();
      },
      connections: () => parallelSockets.length,
      operation: async (worker: any) => {
        const expected = sequence++;
        const result = await webSocketRequest(parallelSockets[worker], stressMessage(expected));
        if (result.value.body.sequence !== expected) {
          throw new Error(`session ${worker} sequence ${expected} was reordered`);
        }
        return result;
      },
    });
  }
  {
    const { application, url } = await createWebSocketApplication();
    const count = Math.min(config.limits.maxConnections, config.limits.maxConcurrency * 2);
    const first = await Promise.all(
      Array.from({ length: count }, async () => (await openWebSocket(url)).socket),
    );
    const disconnectedAt = performance.now();
    await Promise.all(first.map(closeWebSocket));
    const disconnectMs = performance.now() - disconnectedAt;
    const reconnectAt = performance.now();
    const reconnected = await Promise.all(
      Array.from({ length: count }, async () => (await openWebSocket(url)).socket),
    );
    const reconnectMs = performance.now() - reconnectAt;
    await Promise.all(reconnected.map(closeWebSocket));
    await application.close();
    profiles.reconnect = { connections: count, disconnectMs, reconnectMs };
  }
  return profiles;
}

async function protocolErrorScenario() {
  const { application, url } = await createWebSocketApplication();
  try {
    const socket = (await openWebSocket(url)).socket;
    const response = await webSocketRequest(socket, {
      controller: 'stress',
      event: 'missing',
      body: {},
    });
    await closeWebSocket(socket);
    if (response.value.body?.error?.code !== 'UNKNOWN_EVENT') {
      throw new Error('UNKNOWN_EVENT was not returned as a public protocol result');
    }
    const oversized = (await openWebSocket(url)).socket;
    const closed = new Promise<any>((resolve: any) =>
      oversized.addEventListener('close', (event: any) => resolve(event.code), { once: true }),
    );
    oversized.send(
      JSON.stringify({ controller: 'stress', event: 'echo', body: { value: 'x'.repeat(70_000) } }),
    );
    const closeCode = await closed;
    if (closeCode !== 1009) throw new Error(`oversized payload closed with ${closeCode}`);
    let invalidHandshakeRejected = false;
    try {
      await openWebSocket(url, 'invalid.v1');
    } catch {
      invalidHandshakeRejected = true;
    }
    if (!invalidHandshakeRejected) throw new Error('invalid WebSocket handshake was accepted');
    return {
      invalidHandshakeRejected,
      oversizedPayloadCloseCode: closeCode,
      protocolError: 'UNKNOWN_EVENT',
    };
  } finally {
    await application.close();
  }
}

async function mixedProfile(config: any) {
  let jobIndex = 0;
  class MixedHttpController extends HttpControllerBase {
    static prefix = '/stress';
    static routes = [
      { method: 'GET', path: '/fast', handler: 'fast' },
      { method: 'POST', path: '/job', handler: 'job' },
    ] as const;
    async fast() {
      return { status: 200, body: { ok: true } };
    }
    async job() {
      try {
        const result = await this.jobRunner.run(StressJob, {
          durationMs: config.jobDurationsMs.long,
          label: jobIndex++,
          submittedAtNs: process.hrtime.bigint(),
        });
        return { status: 200, body: result };
      } catch (error: any) {
        return { status: 503, body: { error: error.constructor.name } };
      }
    }
  }
  class MixedWebSocketController extends WebSocketControllerBase {
    static name = 'mixed';
    static events = [{ name: 'echo', handler: 'echo' }] as const;
    async echo(_appState: any, ctx: any) {
      return ctx.body;
    }
  }
  const poolSize = config.poolSizes.at(-1);
  const application = new Application({
    appState: TestAppState,
    jobs: { poolSize, queueSize: config.queueSize },
  });
  application.registerHttpController(MixedHttpController);
  application.registerWebSocketController(MixedWebSocketController);
  const address = await application.listen({ port: 0 });
  const url = `ws://${address.address}:${address.port}/websocket`;
  const sockets = await Promise.all(
    Array.from(
      { length: config.limits.maxConcurrency },
      async () => (await openWebSocket(url)).socket,
    ),
  );
  let sequence = 0;
  try {
    return await runRamp('mixed-http-websocket-job', config, {
      close: async () => {
        await Promise.all(sockets.map(closeWebSocket));
        await application.close();
      },
      connections: () => sockets.length,
      operation: async (worker: any) => {
        const startedAt = performance.now();
        const [fast, webSocket, job] = await Promise.all([
          request(address, '/stress/fast'),
          webSocketRequest(sockets[worker], {
            controller: 'mixed',
            event: 'echo',
            body: { sequence: sequence++ },
          }),
          request(address, '/stress/job', {}),
        ]);
        if (fast.status !== 200 || webSocket.value.body.sequence === undefined) {
          throw new Error('independent transport failed under job load');
        }
        return {
          latencyMs: performance.now() - startedAt,
          value: job.status === 200 ? job.value : {},
        };
      },
    });
  } catch (error: any) {
    await Promise.all(sockets.map(closeWebSocket));
    await application.close();
    throw error;
  }
}

function runChild(config: any, outputPath: any) {
  const timeoutMs = config.limits.maxDurationMs + 10_000;
  return new Promise<any>((resolve: any, reject: any) => {
    const child = spawn(
      process.execPath,
      [
        '--expose-gc',
        fileURLToPath(import.meta.url),
        '--child-config',
        JSON.stringify(config),
        '--output',
        outputPath,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const stdout: any[] = [];
    const stderr: any[] = [];
    child.stdout.on('data', (chunk: any) => stdout.push(chunk));
    child.stderr.on('data', (chunk: any) => stderr.push(chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', reject);
    child.on('close', (code: any, signal: any) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`stress child failed (${signal ?? code}): ${Buffer.concat(stderr)}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString());
    });
  });
}

async function childMain(config: any, outputPath: any) {
  const profiles: Record<string, any> = {};
  for (const poolSize of config.poolSizes) {
    for (const duration of ['short', 'long', 'mixed']) {
      const name = `job-${duration}-pool-${poolSize}`;
      profiles[name] = await runRamp(
        name,
        config,
        await createJobResource(config, poolSize, duration),
      );
    }
  }
  profiles.queue = await queueScenario(config);
  profiles.applicationEvents = await applicationEventScenario(config);
  profiles['application-event-throughput'] = await applicationEventThroughput(config);
  profiles['application-event-shutdown-chaos'] = await applicationEventShutdownChaos(config);
  Object.assign(profiles, await websocketProfiles(config));
  profiles.protocolErrors = await protocolErrorScenario();
  profiles.mixed = await mixedProfile(config);
  const failures = Object.entries(profiles)
    .filter(([, profile]: any) => profile.analysis?.recovery === 'not-recovered')
    .map(([name]: any) => `${name}: did not recover`);
  const artifact = {
    config,
    environment: environment(),
    generatedAt: new Date().toISOString(),
    profiles,
    schemaVersion: 1,
    status: failures.length === 0 ? 'passed' : 'failed',
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
  process.stdout.write(`Stress artifact: ${outputPath}\n`);
  if (failures.length > 0) throw new Error(`stress acceptance failed: ${failures.join(', ')}`);
}

async function main() {
  const childConfig = argument('child-config');
  const generatedAt = new Date().toISOString().replaceAll(':', '-');
  const outputPath = path.resolve(
    argument('output', path.join(root, 'test/stress/results', `${generatedAt}.json`)),
  );
  if (childConfig) {
    await childMain(JSON.parse(childConfig), outputPath);
    return;
  }
  const mode = argument('mode', 'full');
  let config = mode === 'smoke' ? smokeStressConfig() : createStressConfig();
  const eventChaosSeed = numberArgument('event-chaos-seed', config.eventChaosSeed);
  const eventShutdownIterations = numberArgument(
    'event-shutdown-iterations',
    config.eventShutdownIterations,
  );
  const stepMs = numberArgument('step-ms', config.steps[0].durationMs);
  const stepValues = argument('steps');
  if (
    stepValues ||
    stepMs !== config.steps[0].durationMs ||
    eventChaosSeed !== config.eventChaosSeed ||
    eventShutdownIterations !== config.eventShutdownIterations
  ) {
    config = createStressConfig({
      ...config.limits,
      maxDurationMs: config.limits.maxDurationMs,
      maxMemoryBytes: config.limits.maxMemoryBytes,
      eventChaosSeed,
      eventShutdownIterations,
      queueSize: config.queueSize,
      recoveryDurationMs: stepMs,
      stepConcurrency: stepValues
        ? stepValues.split(',').map((value: any) => Number(value))
        : config.steps.map((step: any) => step.concurrency),
      stepDurationMs: stepMs,
    });
  }
  const summary = await runChild(config, outputPath);
  process.stdout.write(summary);
}

main()
  .catch((error: any) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  })
  .finally(() => request.agent.destroy());
