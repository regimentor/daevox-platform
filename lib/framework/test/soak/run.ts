import { EventEmitter } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { availableParallelism, cpus, platform, release } from 'node:os';
import path from 'node:path';
import { createHistogram, monitorEventLoopDelay, performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Application } from '../../src/Application.ts';
import { EventListenerBase } from '../../src/EventListenerBase.ts';
import { HttpControllerBase } from '../../src/HttpControllerBase.ts';
import { WebSocketControllerBase } from '../../src/WebSocketControllerBase.ts';
import { EventDroppedError, EventQueueFullError } from '../../src/errors.ts';
import { analyzeSoak, distribution } from './analysis.ts';
import { createSoakConfig } from './config.ts';
import SoakJob from './fixtures/soak-job.ts';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const getActiveHandles = Reflect.get(process, '_getActiveHandles').bind(process);

function argument(name: any, fallback: any = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function numberArgument(name: any) {
  const raw = argument(name, undefined);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new TypeError(`--${name} must be an integer`);
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

function handleDetails() {
  return getActiveHandles().map((handle: any) => ({
    address: typeof handle.address === 'function' ? handle.address() : undefined,
    constructor: handle.constructor?.name ?? 'unknown',
    destroyed: handle.destroyed,
  }));
}

function activeResources() {
  return typeof process.getActiveResourcesInfo === 'function'
    ? process.getActiveResourcesInfo()
    : [];
}

function agentConnections(agent: any) {
  return [...Object.values(agent.sockets), ...Object.values(agent.freeSockets)].reduce(
    (sum: any, sockets: any) => sum + sockets.length,
    0,
  );
}

function listenerCount(handles: any, emitter: any) {
  return (
    emitter.listenerCount('soak-control') +
    handles.reduce(
      (sum: any, handle: any) =>
        sum +
        (typeof handle.eventNames === 'function'
          ? handle
              .eventNames()
              .reduce((count: any, event: any) => count + handle.listenerCount(event), 0)
          : 0),
      0,
    )
  );
}

function operationState() {
  return {
    failures: 0,
    latencyHistogram: createHistogram(),
    successes: 0,
    windowLatencies: [],
  };
}

function createMetrics() {
  return {
    http: operationState(),
    jobCancelled: operationState(),
    jobSuccess: operationState(),
    jobTimeout: operationState(),
    websocket: operationState(),
  };
}

function record(metrics: any, name: any, startedAt: any, succeeded: any, error: any = undefined) {
  const state = metrics[name];
  const latencyMs = performance.now() - startedAt;
  state.latencyHistogram.record(Math.max(1, Math.round(latencyMs * 1_000_000)));
  state.windowLatencies.push(latencyMs);
  if (succeeded) state.successes += 1;
  else {
    state.failures += 1;
    state.errors ??= [];
    if (state.errors.length < 20) state.errors.push(error?.message ?? String(error));
  }
}

function httpRequest(address: any, route: any, body: any, { abortAfterMs }: any = {}) {
  const serialized = JSON.stringify(body);
  return new Promise<any>((resolve: any, reject: any) => {
    const request = http.request(
      {
        ...address,
        agent: httpRequest.agent,
        headers: {
          'content-length': Buffer.byteLength(serialized),
          'content-type': 'application/json',
        },
        method: 'POST',
        path: route,
      },
      (response: any) => {
        const chunks: any[] = [];
        response.on('data', (chunk: any) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          try {
            resolve({ status: response.statusCode, value: text ? JSON.parse(text) : undefined });
          } catch (error: any) {
            reject(error);
          }
        });
      },
    );
    request.setTimeout(5_000, () => request.destroy(new Error('HTTP operation timed out')));
    request.on('error', reject);
    request.end(serialized);
    if (abortAfterMs !== undefined) {
      setTimeout(() => request.destroy(new Error('expected client cancellation')), abortAfterMs);
    }
  });
}
httpRequest.agent = new http.Agent({ keepAlive: true, maxSockets: 32 });

function openWebSocket(url: any, sockets: any) {
  return new Promise<any>((resolve: any, reject: any) => {
    const socket = new WebSocket(url, 'daevox.v1');
    sockets.add(socket);
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener(
      'error',
      (error: any) => {
        sockets.delete(socket);
        reject(error);
      },
      { once: true },
    );
  });
}

function closeWebSocket(socket: any, sockets: any) {
  if (socket.readyState === WebSocket.CLOSED) {
    sockets.delete(socket);
    return Promise.resolve();
  }
  return new Promise<any>((resolve: any) => {
    socket.addEventListener(
      'close',
      () => {
        sockets.delete(socket);
        resolve();
      },
      { once: true },
    );
    socket.close();
  });
}

function webSocketRoundTrip(socket: any, sequence: any) {
  return new Promise<any>((resolve: any, reject: any) => {
    const onError = () => reject(new Error('WebSocket operation failed'));
    socket.addEventListener(
      'message',
      (event: any) => {
        socket.removeEventListener('error', onError);
        try {
          const message = JSON.parse(event.data);
          if (message.body.sequence !== sequence) throw new Error('WebSocket response mismatch');
          resolve(message);
        } catch (error: any) {
          reject(error);
        }
      },
      { once: true },
    );
    socket.addEventListener('error', onError, { once: true });
    socket.send(JSON.stringify({ controller: 'soak', event: 'echo', body: { sequence } }));
  });
}

function summary(metrics: any) {
  return Object.fromEntries(
    Object.entries(metrics).map(([name, state]: any) => [
      name,
      {
        failures: state.failures,
        latencyMs: {
          p50: state.latencyHistogram.percentile(50) / 1_000_000,
          p95: state.latencyHistogram.percentile(95) / 1_000_000,
          p99: state.latencyHistogram.percentile(99) / 1_000_000,
        },
        successes: state.successes,
      },
    ]),
  );
}

function counters(metrics: any) {
  return Object.fromEntries(
    Object.entries(metrics).map(([name, state]: any) => [name, state.successes + state.failures]),
  );
}

function deltaCounters(current: any, previous: any) {
  return Object.fromEntries(
    Object.entries(current).map(([name, value]: any) => [name, value - (previous[name] ?? 0)]),
  );
}

async function injectLeak(kind: any, leakState: any) {
  if (kind === undefined) return;
  if (kind === 'listener') {
    leakState.emitter.on('soak-control', () => {});
    return;
  }
  if (kind === 'timer') {
    leakState.timer = setInterval(() => {}, 60_000);
    return;
  }
  if (kind === 'socket') {
    leakState.server = net.createServer();
    await new Promise<any>((resolve: any, reject: any) => {
      leakState.server.once('error', reject);
      leakState.server.listen({ host: '127.0.0.1', port: 0 }, resolve);
    });
    leakState.socket = net.connect(leakState.server.address());
    await new Promise<any>((resolve: any, reject: any) => {
      leakState.socket.once('connect', resolve);
      leakState.socket.once('error', reject);
    });
    return;
  }
  throw new TypeError(`Unknown leak control: ${kind}`);
}

async function cleanupLeak(leakState: any) {
  leakState.emitter.removeAllListeners();
  clearInterval(leakState.timer);
  leakState.socket?.destroy();
  if (leakState.server) {
    await new Promise<any>((resolve: any) => leakState.server.close(resolve));
  }
}

function snapshot({ elapsedMs, leakState, metrics, openSockets }: any) {
  const memory = process.memoryUsage();
  const resources = activeResources();
  const handles = getActiveHandles();
  const allLatencies = Object.values(metrics).flatMap((state: any) => state.windowLatencies);
  return {
    activeHandles: handles.length,
    activeResourceTypes: Object.fromEntries(
      [...new Set(resources)].map((type: any) => [
        type,
        resources.filter((entry: any) => entry === type).length,
      ]),
    ),
    connections:
      openSockets.size +
      agentConnections(httpRequest.agent) +
      (leakState.socket && !leakState.socket.destroyed ? 1 : 0),
    elapsedMs,
    eventLoopLagMs: { max: 0, p95: 0, p99: 0 },
    heapUsedBytes: memory.heapUsed,
    latencyMs: distribution(allLatencies),
    listeners: listenerCount(handles, leakState.emitter),
    rssBytes: memory.rss,
    throughput: counters(metrics),
    timers: resources.filter((type: any) => type === 'Timeout').length,
    workers: resources.filter((type: any) => type === 'MessagePort').length,
  };
}

// oxlint-disable-next-line typescript/no-extraneous-class -- DTO class provides nominal identity.
class SoakApplicationEvent {
  declare listener: any;
  declare order: any;
  declare poison: any;
  declare sequence: any;
  declare source: any;

  constructor({ listener, order, poison, sequence, source }: any) {
    this.listener = listener;
    this.order = order;
    this.poison = poison;
    this.sequence = sequence;
    this.source = source;
  }
}

function createApplicationEventAccounting(errorEvery: any) {
  const listeners: Record<string, any> = {
    fast: { accepted: 0, acceptedChecksum: 0n, handled: 0, handledChecksum: 0n },
    slow: { accepted: 0, acceptedChecksum: 0n, handled: 0, handledChecksum: 0n },
  };
  const state: any = {
    dropped: 0,
    duplicates: 0,
    expectedErrors: 0,
    fifoViolations: 0,
    observedErrors: 0,
    rejected: 0,
    unexpectedErrors: [],
  };

  function push(sender: any, sequence: any, source: any) {
    const listener = sequence % 2 === 0 ? 'fast' : 'slow';
    const ledger = listeners[listener];
    const order = ledger.accepted;
    const poison = (listeners.fast.accepted + listeners.slow.accepted + 1) % errorEvery === 0;
    const data = new SoakApplicationEvent({ listener, order, poison, sequence, source });
    try {
      sender.push({ listener: `soak-${listener}`, event: 'work' }, data);
    } catch (error: any) {
      if (error instanceof EventQueueFullError) state.rejected += 1;
      throw error;
    }
    ledger.accepted += 1;
    ledger.acceptedChecksum += BigInt(order + 1);
    if (poison) state.expectedErrors += 1;
  }

  function recordHandled(data: any) {
    const ledger = listeners[data.listener];
    if (data.order < ledger.handled) state.duplicates += 1;
    if (data.order !== ledger.handled) state.fifoViolations += 1;
    ledger.handled += 1;
    ledger.handledChecksum += BigInt(data.order + 1);
  }

  function report(error: any) {
    if (error instanceof EventDroppedError) state.dropped += 1;
    else if (error.message.startsWith('soak event poison:')) state.observedErrors += 1;
    else if (state.unexpectedErrors.length < 20) state.unexpectedErrors.push(error.message);
  }

  function accounting() {
    const accepted = listeners.fast.accepted + listeners.slow.accepted;
    const handled = listeners.fast.handled + listeners.slow.handled;
    const acceptedChecksum = listeners.fast.acceptedChecksum + listeners.slow.acceptedChecksum;
    const handledChecksum = listeners.fast.handledChecksum + listeners.slow.handledChecksum;
    return {
      accepted,
      acceptedChecksum: String(acceptedChecksum),
      dropped: state.dropped,
      duplicates: state.duplicates,
      expectedErrors: state.expectedErrors,
      fifoViolations: state.fifoViolations,
      handled,
      handledChecksum: String(handledChecksum),
      listeners: Object.fromEntries(
        Object.entries(listeners).map(([name, ledger]: any) => [
          name,
          { accepted: ledger.accepted, handled: ledger.handled },
        ]),
      ),
      observedErrors: state.observedErrors,
      rejected: state.rejected,
      unexpectedErrors: state.unexpectedErrors,
    };
  }

  return { accounting, push, recordHandled, report };
}

async function main() {
  const mode = argument('mode', 'short');
  const overrides = Object.fromEntries(
    [
      ['durationMs', numberArgument('duration-ms')],
      ['eventErrorEvery', numberArgument('event-error-every')],
      ['sampleIntervalMs', numberArgument('sample-interval-ms')],
      ['timeoutMs', numberArgument('timeout-ms')],
      ['warmupMs', numberArgument('warmup-ms')],
    ].filter(([, value]: any) => value !== undefined),
  );
  const config = createSoakConfig(mode, overrides);
  const outputDir = path.resolve(argument('output-dir', path.join(root, 'test/soak/results')));
  const injectedLeak = argument('inject-leak', undefined);
  const generatedAt = new Date().toISOString();
  const timestamp = generatedAt.replaceAll(':', '-');
  const artifactPath = path.join(outputDir, `${timestamp}-${mode}.json`);
  const diagnosticsPath = path.join(outputDir, `${timestamp}-${mode}-diagnostics.json`);
  const metrics = createMetrics();
  const applicationEvents = createApplicationEventAccounting(config.eventErrorEvery);
  const lifecycle = { connected: 0, disconnected: 0 };
  const openSockets = new Set();
  const leakState = { emitter: new EventEmitter() };
  const errors: any[] = [];
  let application: any;
  let samplingTimer: any;
  let watchdog: any;
  const startedAt = performance.now();
  let previousCounters = counters(metrics);
  let previousSampleAt = startedAt;
  let workloadPromises: any[] = [];
  const samples: any[] = [];
  const baselineResources = snapshot({
    elapsedMs: 0,
    leakState,
    metrics,
    openSockets,
  });
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });

  class SoakHttpController extends HttpControllerBase {
    static prefix = '/soak';
    static routes = [
      { method: 'POST', path: '/echo', handler: 'echo' },
      { method: 'POST', path: '/job/success', handler: 'jobSuccess' },
      { method: 'POST', path: '/job/cancel', handler: 'jobCancel' },
      { method: 'POST', path: '/job/timeout', handler: 'jobTimeout' },
    ];
    async echo(ctx: any) {
      applicationEvents.push(this.events, ctx.body.sequence, 'http');
      return { status: 200, body: ctx.body };
    }
    async jobSuccess(ctx: any) {
      applicationEvents.push(this.events, ctx.body.sequence, 'jobSuccess');
      const result = await this.jobRunner.run(SoakJob, { delayMs: 2, sequence: ctx.body.sequence });
      return { status: 200, body: result };
    }
    async jobCancel(ctx: any) {
      applicationEvents.push(this.events, ctx.body.sequence, 'jobCancelled');
      try {
        await this.jobRunner.run(
          SoakJob,
          { delayMs: config.jobTimeoutMs * 4, sequence: ctx.body.sequence },
          { signal: ctx.signal },
        );
        return { status: 500, body: { outcome: 'not-cancelled' } };
      } catch (error: any) {
        return { status: 200, body: { outcome: error.constructor.name } };
      }
    }
    async jobTimeout(ctx: any) {
      applicationEvents.push(this.events, ctx.body.sequence, 'jobTimeout');
      try {
        await this.jobRunner.run(
          SoakJob,
          { delayMs: config.jobTimeoutMs * 4, sequence: ctx.body.sequence },
          { timeout: config.jobTimeoutMs },
        );
        return { status: 500, body: { outcome: 'not-timed-out' } };
      } catch (error: any) {
        return { status: 200, body: { outcome: error.constructor.name } };
      }
    }
  }

  class SoakWebSocketController extends WebSocketControllerBase {
    static name = 'soak';
    static events = [{ name: 'echo', handler: 'echo' }];
    async echo(ctx: any) {
      applicationEvents.push(this.events, ctx.body.sequence, 'websocket');
      return ctx.body;
    }
  }

  class FastSoakEventListener extends EventListenerBase {
    static name = 'soak-fast';
    static events = [{ name: 'work', data: SoakApplicationEvent, handler: 'work' }];
    work(data: any) {
      applicationEvents.recordHandled(data);
      if (data.poison) throw new Error(`soak event poison:${data.sequence}`);
    }
  }

  class SlowSoakEventListener extends EventListenerBase {
    static name = 'soak-slow';
    static events = [{ name: 'work', data: SoakApplicationEvent, handler: 'work' }];
    async work(data: any) {
      applicationEvents.recordHandled(data);
      await new Promise<any>((resolve: any) => setTimeout(resolve, 2));
      if (data.poison) throw new Error(`soak event poison:${data.sequence}`);
    }
  }

  try {
    application = new Application({
      events: {
        onError: applicationEvents.report,
        queueSize: config.operationConcurrency * 8,
      },
      http: { shutdownTimeout: 5_000 },
      jobs: {
        poolSize: Math.min(2, availableParallelism()),
        queueSize: config.operationConcurrency * 2,
        shutdownTimeout: 5_000,
        terminationGracePeriod: 25,
      },
      websocket: {
        async onConnect() {
          lifecycle.connected += 1;
        },
        async onDisconnect() {
          lifecycle.disconnected += 1;
        },
        onError(error: any) {
          errors.push(error.message);
        },
      },
    });
    application.registerHttpController(SoakHttpController);
    application.registerWebSocketController(SoakWebSocketController);
    application.registerEventListener(FastSoakEventListener);
    application.registerEventListener(SlowSoakEventListener);
    const address = await application.listen({ port: 0 });
    const websocketUrl = `ws://${address.address}:${address.port}/websocket`;
    const deadline = startedAt + config.durationMs;
    let sequence = 0;
    eventLoop.enable();
    watchdog = setTimeout(() => {
      errors.push(`soak exceeded timeout ${config.timeoutMs}ms`);
    }, config.timeoutMs);
    samplingTimer = setInterval(() => {
      const sampledAt = performance.now();
      const sample = snapshot({
        elapsedMs: sampledAt - startedAt,
        leakState,
        metrics,
        openSockets,
      });
      sample.eventLoopLagMs = {
        max: eventLoop.max / 1_000_000,
        p95: eventLoop.percentile(95) / 1_000_000,
        p99: eventLoop.percentile(99) / 1_000_000,
      };
      const current = counters(metrics);
      const intervalSeconds = (sampledAt - previousSampleAt) / 1_000;
      sample.throughput = Object.fromEntries(
        Object.entries(deltaCounters(current, previousCounters)).map(([name, value]: any) => [
          name,
          value / intervalSeconds,
        ]),
      );
      sample.latencyMs = distribution(
        Object.values(metrics).flatMap((state: any) => state.windowLatencies),
      );
      previousCounters = current;
      for (const state of Object.values(metrics)) state.windowLatencies.length = 0;
      previousSampleAt = sampledAt;
      samples.push(sample);
      eventLoop.reset();
    }, config.sampleIntervalMs);

    const operations = [
      async (current: any) => {
        const result = await httpRequest(address, '/soak/echo', { sequence: current });
        if (result.status !== 200 || result.value.sequence !== current) {
          throw new Error('HTTP response mismatch');
        }
      },
      async (current: any) => {
        const socket = await openWebSocket(websocketUrl, openSockets);
        try {
          await webSocketRoundTrip(socket, current);
        } finally {
          await closeWebSocket(socket, openSockets);
        }
      },
      async (current: any) => {
        const result = await httpRequest(address, '/soak/job/success', { sequence: current });
        if (result.status !== 200 || result.value.sequence !== current) {
          throw new Error('successful Job response mismatch');
        }
      },
      async (current: any) => {
        try {
          await httpRequest(
            address,
            '/soak/job/cancel',
            { sequence: current },
            { abortAfterMs: 2 },
          );
          throw new Error('cancelled Job kept its HTTP connection');
        } catch (error: any) {
          if (error.message !== 'expected client cancellation') throw error;
        }
      },
      async (current: any) => {
        const result = await httpRequest(address, '/soak/job/timeout', { sequence: current });
        if (result.status !== 200 || result.value.outcome !== 'JobTimedOutError') {
          throw new Error(`unexpected timeout outcome: ${JSON.stringify(result)}`);
        }
      },
    ];
    const names = ['http', 'websocket', 'jobSuccess', 'jobCancelled', 'jobTimeout'];
    workloadPromises = Array.from(
      { length: config.operationConcurrency },
      async (_: any, worker: any) => {
        let operationIndex = worker % operations.length;
        while (performance.now() < deadline && errors.length === 0) {
          const current = sequence++;
          const started = performance.now();
          try {
            await operations[operationIndex]!(current);
            record(metrics, names[operationIndex]!, started, true);
          } catch (error: any) {
            record(metrics, names[operationIndex]!, started, false, error);
          }
          operationIndex = (operationIndex + 1) % operations.length;
        }
      },
    );
    await Promise.all(workloadPromises);
  } finally {
    clearInterval(samplingTimer);
    clearTimeout(watchdog);
    eventLoop.disable();
    await Promise.all([...openSockets].map((socket: any) => closeWebSocket(socket, openSockets)));
    httpRequest.agent.destroy();
    await application?.close();
  }

  globalThis.gc?.();
  await new Promise<any>((resolve: any) => setImmediate(resolve));
  await injectLeak(injectedLeak, leakState);
  const finalResources = snapshot({
    elapsedMs: performance.now() - startedAt,
    leakState,
    metrics,
    openSockets,
  });
  const analysis: any = analyzeSoak(samples, {
    baselineResources,
    finalResources,
    thresholds: config.thresholds,
    warmupMs: config.warmupMs,
  });
  analysis.thresholds.operations = {
    failures: Object.values(metrics).reduce((sum: any, state: any) => sum + state.failures, 0),
    lifecycleErrors: errors,
    status:
      errors.length === 0 && Object.values(metrics).every((state: any) => state.failures === 0)
        ? 'passed'
        : 'failed',
  };
  analysis.thresholds.lifecycle = {
    connected: lifecycle.connected,
    disconnected: lifecycle.disconnected,
    status: lifecycle.connected === lifecycle.disconnected ? 'passed' : 'failed',
  };
  const applicationEventSummary = applicationEvents.accounting();
  analysis.thresholds.applicationEvents = {
    ...applicationEventSummary,
    status:
      applicationEventSummary.accepted === applicationEventSummary.handled &&
      applicationEventSummary.acceptedChecksum === applicationEventSummary.handledChecksum &&
      applicationEventSummary.dropped === 0 &&
      applicationEventSummary.duplicates === 0 &&
      applicationEventSummary.expectedErrors === applicationEventSummary.observedErrors &&
      applicationEventSummary.fifoViolations === 0 &&
      applicationEventSummary.rejected === 0 &&
      applicationEventSummary.unexpectedErrors.length === 0
        ? 'passed'
        : 'failed',
  };
  analysis.passed &&= Object.values(analysis.thresholds).every(
    (threshold: any) => threshold.status === 'passed',
  );
  const artifact = {
    analysis,
    config,
    diagnosticsPath: analysis.passed ? null : diagnosticsPath,
    environment: environment(),
    generatedAt,
    lifecycle,
    samples,
    schemaVersion: 2,
    summary: { applicationEvents: applicationEventSummary, operations: summary(metrics) },
  };
  await mkdir(outputDir, { recursive: true });
  if (!analysis.passed) {
    await writeFile(
      diagnosticsPath,
      `${JSON.stringify(
        {
          activeHandles: handleDetails(),
          activeResources: activeResources(),
          analysis,
          errors,
          finalResources,
          injectedLeak,
        },
        null,
        2,
      )}\n`,
    );
  }
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`Daevox soak (${mode}): ${analysis.passed ? 'passed' : 'failed'}`);
  for (const [name, result] of Object.entries(analysis.thresholds) as [string, any][]) {
    console.log(`${name}: ${result.status}`);
  }
  console.log(`artifact: ${artifactPath}`);
  if (!analysis.passed) console.log(`diagnostics: ${diagnosticsPath}`);
  await cleanupLeak(leakState);
  if (!analysis.passed) process.exitCode = 1;
}

main().catch((error: any) => {
  console.error(error);
  process.exitCode = 1;
});
