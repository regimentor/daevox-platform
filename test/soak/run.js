import { EventEmitter } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { availableParallelism, cpus, platform, release } from 'node:os';
import path from 'node:path';
import { createHistogram, monitorEventLoopDelay, performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Application } from '../../lib/framework/Application.js';
import { HttpControllerBase } from '../../lib/framework/HttpControllerBase.js';
import { WebSocketControllerBase } from '../../lib/framework/WebSocketControllerBase.js';
import { analyzeSoak, distribution } from './analysis.js';
import { createSoakConfig } from './config.js';
import SoakJob from './fixtures/soak-job.js';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const getActiveHandles = Reflect.get(process, '_getActiveHandles').bind(process);

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function numberArgument(name) {
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
  return getActiveHandles().map((handle) => ({
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

function agentConnections(agent) {
  return [...Object.values(agent.sockets), ...Object.values(agent.freeSockets)].reduce(
    (sum, sockets) => sum + sockets.length,
    0,
  );
}

function listenerCount(handles, emitter) {
  return (
    emitter.listenerCount('soak-control') +
    handles.reduce(
      (sum, handle) =>
        sum +
        (typeof handle.eventNames === 'function'
          ? handle.eventNames().reduce((count, event) => count + handle.listenerCount(event), 0)
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

function record(metrics, name, startedAt, succeeded, error) {
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

function httpRequest(address, route, body, { abortAfterMs } = {}) {
  const serialized = JSON.stringify(body);
  return new Promise((resolve, reject) => {
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
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          try {
            resolve({ status: response.statusCode, value: text ? JSON.parse(text) : undefined });
          } catch (error) {
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

function openWebSocket(url, sockets) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, 'daevox.v1');
    sockets.add(socket);
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener(
      'error',
      (error) => {
        sockets.delete(socket);
        reject(error);
      },
      { once: true },
    );
  });
}

function closeWebSocket(socket, sockets) {
  if (socket.readyState === WebSocket.CLOSED) {
    sockets.delete(socket);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
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

function webSocketRoundTrip(socket, sequence) {
  return new Promise((resolve, reject) => {
    const onError = () => reject(new Error('WebSocket operation failed'));
    socket.addEventListener(
      'message',
      (event) => {
        socket.removeEventListener('error', onError);
        try {
          const message = JSON.parse(event.data);
          if (message.body.sequence !== sequence) throw new Error('WebSocket response mismatch');
          resolve(message);
        } catch (error) {
          reject(error);
        }
      },
      { once: true },
    );
    socket.addEventListener('error', onError, { once: true });
    socket.send(JSON.stringify({ controller: 'soak', event: 'echo', body: { sequence } }));
  });
}

function summary(metrics) {
  return Object.fromEntries(
    Object.entries(metrics).map(([name, state]) => [
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

function counters(metrics) {
  return Object.fromEntries(
    Object.entries(metrics).map(([name, state]) => [name, state.successes + state.failures]),
  );
}

function deltaCounters(current, previous) {
  return Object.fromEntries(
    Object.entries(current).map(([name, value]) => [name, value - (previous[name] ?? 0)]),
  );
}

async function injectLeak(kind, leakState) {
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
    await new Promise((resolve, reject) => {
      leakState.server.once('error', reject);
      leakState.server.listen({ host: '127.0.0.1', port: 0 }, resolve);
    });
    leakState.socket = net.connect(leakState.server.address());
    await new Promise((resolve, reject) => {
      leakState.socket.once('connect', resolve);
      leakState.socket.once('error', reject);
    });
    return;
  }
  throw new TypeError(`Unknown leak control: ${kind}`);
}

async function cleanupLeak(leakState) {
  leakState.emitter.removeAllListeners();
  clearInterval(leakState.timer);
  leakState.socket?.destroy();
  if (leakState.server) {
    await new Promise((resolve) => leakState.server.close(resolve));
  }
}

function snapshot({ elapsedMs, leakState, metrics, openSockets }) {
  const memory = process.memoryUsage();
  const resources = activeResources();
  const handles = getActiveHandles();
  const allLatencies = Object.values(metrics).flatMap((state) => state.windowLatencies);
  return {
    activeHandles: handles.length,
    activeResourceTypes: Object.fromEntries(
      [...new Set(resources)].map((type) => [
        type,
        resources.filter((entry) => entry === type).length,
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
    timers: resources.filter((type) => type === 'Timeout').length,
    workers: resources.filter((type) => type === 'MessagePort').length,
  };
}

async function main() {
  const mode = argument('mode', 'short');
  const overrides = Object.fromEntries(
    [
      ['durationMs', numberArgument('duration-ms')],
      ['sampleIntervalMs', numberArgument('sample-interval-ms')],
      ['timeoutMs', numberArgument('timeout-ms')],
      ['warmupMs', numberArgument('warmup-ms')],
    ].filter(([, value]) => value !== undefined),
  );
  const config = createSoakConfig(mode, overrides);
  const outputDir = path.resolve(argument('output-dir', path.join(root, 'test/soak/results')));
  const injectedLeak = argument('inject-leak', undefined);
  const generatedAt = new Date().toISOString();
  const timestamp = generatedAt.replaceAll(':', '-');
  const artifactPath = path.join(outputDir, `${timestamp}-${mode}.json`);
  const diagnosticsPath = path.join(outputDir, `${timestamp}-${mode}-diagnostics.json`);
  const metrics = createMetrics();
  const lifecycle = { connected: 0, disconnected: 0 };
  const openSockets = new Set();
  const leakState = { emitter: new EventEmitter() };
  const errors = [];
  let application;
  let samplingTimer;
  let watchdog;
  const startedAt = performance.now();
  let previousCounters = counters(metrics);
  let previousSampleAt = startedAt;
  let workloadPromises = [];
  const samples = [];
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
      { method: 'POST', path: '/echo', handler: 'echo', authentication: false },
      {
        method: 'POST',
        path: '/job/success',
        handler: 'jobSuccess',
        authentication: false,
      },
      {
        method: 'POST',
        path: '/job/cancel',
        handler: 'jobCancel',
        authentication: false,
      },
      {
        method: 'POST',
        path: '/job/timeout',
        handler: 'jobTimeout',
        authentication: false,
      },
    ];
    async echo(ctx) {
      return { status: 200, body: ctx.body };
    }
    async jobSuccess(ctx) {
      const result = await this.jobRunner.run(SoakJob, { delayMs: 2, sequence: ctx.body.sequence });
      return { status: 200, body: result };
    }
    async jobCancel(ctx) {
      try {
        await this.jobRunner.run(
          SoakJob,
          { delayMs: config.jobTimeoutMs * 4, sequence: ctx.body.sequence },
          { signal: ctx.signal },
        );
        return { status: 500, body: { outcome: 'not-cancelled' } };
      } catch (error) {
        return { status: 200, body: { outcome: error.constructor.name } };
      }
    }
    async jobTimeout(ctx) {
      try {
        await this.jobRunner.run(
          SoakJob,
          { delayMs: config.jobTimeoutMs * 4, sequence: ctx.body.sequence },
          { timeout: config.jobTimeoutMs },
        );
        return { status: 500, body: { outcome: 'not-timed-out' } };
      } catch (error) {
        return { status: 200, body: { outcome: error.constructor.name } };
      }
    }
  }

  class SoakWebSocketController extends WebSocketControllerBase {
    static name = 'soak';
    static events = [{ name: 'echo', handler: 'echo' }];
    async echo(ctx) {
      return ctx.body;
    }
  }

  try {
    application = new Application({
      http: { shutdownTimeout: 5_000 },
      jobs: {
        poolSize: Math.min(2, availableParallelism()),
        queueSize: config.operationConcurrency * 2,
        shutdownTimeout: 5_000,
        terminationGracePeriod: 25,
      },
      websocket: {
        authentication: false,
        async onConnect() {
          lifecycle.connected += 1;
        },
        async onDisconnect() {
          lifecycle.disconnected += 1;
        },
        onError(error) {
          errors.push(error.message);
        },
      },
    });
    application.registerHttpController(SoakHttpController);
    application.registerWebSocketController(SoakWebSocketController);
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
        Object.entries(deltaCounters(current, previousCounters)).map(([name, value]) => [
          name,
          value / intervalSeconds,
        ]),
      );
      sample.latencyMs = distribution(
        Object.values(metrics).flatMap((state) => state.windowLatencies),
      );
      previousCounters = current;
      for (const state of Object.values(metrics)) state.windowLatencies.length = 0;
      previousSampleAt = sampledAt;
      samples.push(sample);
      eventLoop.reset();
    }, config.sampleIntervalMs);

    const operations = [
      async (current) => {
        const result = await httpRequest(address, '/soak/echo', { sequence: current });
        if (result.status !== 200 || result.value.sequence !== current) {
          throw new Error('HTTP response mismatch');
        }
      },
      async (current) => {
        const socket = await openWebSocket(websocketUrl, openSockets);
        try {
          await webSocketRoundTrip(socket, current);
        } finally {
          await closeWebSocket(socket, openSockets);
        }
      },
      async (current) => {
        const result = await httpRequest(address, '/soak/job/success', { sequence: current });
        if (result.status !== 200 || result.value.sequence !== current) {
          throw new Error('successful Job response mismatch');
        }
      },
      async (current) => {
        try {
          await httpRequest(
            address,
            '/soak/job/cancel',
            { sequence: current },
            { abortAfterMs: 2 },
          );
          throw new Error('cancelled Job kept its HTTP connection');
        } catch (error) {
          if (error.message !== 'expected client cancellation') throw error;
        }
      },
      async (current) => {
        const result = await httpRequest(address, '/soak/job/timeout', { sequence: current });
        if (result.status !== 200 || result.value.outcome !== 'JobTimedOutError') {
          throw new Error(`unexpected timeout outcome: ${JSON.stringify(result)}`);
        }
      },
    ];
    const names = ['http', 'websocket', 'jobSuccess', 'jobCancelled', 'jobTimeout'];
    workloadPromises = Array.from({ length: config.operationConcurrency }, async (_, worker) => {
      let operationIndex = worker % operations.length;
      while (performance.now() < deadline && errors.length === 0) {
        const current = sequence++;
        const started = performance.now();
        try {
          await operations[operationIndex](current);
          record(metrics, names[operationIndex], started, true);
        } catch (error) {
          record(metrics, names[operationIndex], started, false, error);
        }
        operationIndex = (operationIndex + 1) % operations.length;
      }
    });
    await Promise.all(workloadPromises);
  } finally {
    clearInterval(samplingTimer);
    clearTimeout(watchdog);
    eventLoop.disable();
    await Promise.all([...openSockets].map((socket) => closeWebSocket(socket, openSockets)));
    httpRequest.agent.destroy();
    await application?.close();
  }

  globalThis.gc?.();
  await new Promise((resolve) => setImmediate(resolve));
  await injectLeak(injectedLeak, leakState);
  const finalResources = snapshot({
    elapsedMs: performance.now() - startedAt,
    leakState,
    metrics,
    openSockets,
  });
  const analysis = analyzeSoak(samples, {
    baselineResources,
    finalResources,
    thresholds: config.thresholds,
    warmupMs: config.warmupMs,
  });
  analysis.thresholds.operations = {
    failures: Object.values(metrics).reduce((sum, state) => sum + state.failures, 0),
    lifecycleErrors: errors,
    status:
      errors.length === 0 && Object.values(metrics).every((state) => state.failures === 0)
        ? 'passed'
        : 'failed',
  };
  analysis.thresholds.lifecycle = {
    connected: lifecycle.connected,
    disconnected: lifecycle.disconnected,
    status: lifecycle.connected === lifecycle.disconnected ? 'passed' : 'failed',
  };
  analysis.passed &&= Object.values(analysis.thresholds).every(
    (threshold) => threshold.status === 'passed',
  );
  const artifact = {
    analysis,
    config,
    diagnosticsPath: analysis.passed ? null : diagnosticsPath,
    environment: environment(),
    generatedAt,
    lifecycle,
    samples,
    schemaVersion: 1,
    summary: { operations: summary(metrics) },
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
  for (const [name, result] of Object.entries(analysis.thresholds)) {
    console.log(`${name}: ${result.status}`);
  }
  console.log(`artifact: ${artifactPath}`);
  if (!analysis.passed) console.log(`diagnostics: ${diagnosticsPath}`);
  await cleanupLeak(leakState);
  if (!analysis.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
