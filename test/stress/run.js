import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { availableParallelism, cpus, platform, release } from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Application } from '../../lib/framework/Application.js';
import { HttpControllerBase } from '../../lib/framework/HttpControllerBase.js';
import { WebSocketControllerBase } from '../../lib/framework/WebSocketControllerBase.js';
import { classifySteps, distribution } from './analysis.js';
import { createStressConfig, smokeStressConfig } from './config.js';
import StressJob from './fixtures/stress-job.js';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function numberArgument(name, fallback) {
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

function request(address, route, body) {
  const startedAt = performance.now();
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
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
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          try {
            resolve({
              latencyMs: performance.now() - startedAt,
              status: response.statusCode,
              value: text ? JSON.parse(text) : undefined,
            });
          } catch (error) {
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

function openWebSocket(url, protocol = 'daevox.v1') {
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocol);
    socket.addEventListener(
      'open',
      () => resolve({ latencyMs: performance.now() - startedAt, socket }),
      { once: true },
    );
    socket.addEventListener('error', reject, { once: true });
  });
}

function closeWebSocket(socket) {
  if (socket.readyState >= WebSocket.CLOSING) return Promise.resolve();
  return new Promise((resolve) => {
    socket.addEventListener('close', resolve, { once: true });
    socket.close();
  });
}

function webSocketRequest(socket, message) {
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    const onError = () => reject(new Error('WebSocket operation failed'));
    socket.addEventListener(
      'message',
      (event) => {
        socket.removeEventListener('error', onError);
        try {
          resolve({
            latencyMs: performance.now() - startedAt,
            value: JSON.parse(event.data),
          });
        } catch (error) {
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

async function waitFor(predicate, label) {
  const deadline = performance.now() + 2_000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`${label} timed out`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function stressMessage(sequence) {
  return { controller: 'stress', event: 'echo', body: { sequence } };
}

async function measureStep({ concurrency, connections, durationMs, limits, operation }) {
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  const latencies = [];
  const queueWait = [];
  const execution = [];
  const errors = [];
  const workerIds = new Set();
  const startMemory = resourceSnapshot();
  let maxHeap = startMemory.heapUsedBytes;
  let maxRss = startMemory.rssBytes;
  let successes = 0;
  let failures = 0;
  const state = { fatal: undefined };
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
    Array.from({ length: concurrency }, async (_, worker) => {
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
        } catch (error) {
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

async function runRamp(name, config, resource) {
  const steps = [];
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
    await new Promise((resolve) => setTimeout(resolve, 25));
    const recovery = await measureStep({
      concurrency: config.steps[0].concurrency,
      connections: resource.connections?.(config.steps[0]) ?? 0,
      durationMs: config.recoveryDurationMs,
      limits: config.limits,
      operation: resource.operation,
    });
    globalThis.gc?.();
    await new Promise((resolve) => setTimeout(resolve, 25));
    recovery.settledMemory = resourceSnapshot();
    return {
      analysis: classifySteps(
        steps.map((step) => step.metrics),
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

async function createJobResource(config, poolSize, durationMode) {
  let mixedIndex = 0;
  class StressHttpController extends HttpControllerBase {
    static prefix = '/stress';
    static routes = [{ method: 'POST', path: '/job', handler: 'job' }];
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
      } catch (error) {
        return { status: 503, body: { error: error.constructor.name } };
      }
    }
  }
  const application = new Application({ jobs: { poolSize, queueSize: config.queueSize } });
  application.registerHttpController(StressHttpController);
  const address = await application.listen({ port: 0 });
  return {
    close: () => application.close(),
    operation: () => request(address, '/stress/job', {}),
  };
}

async function queueScenario(config) {
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const gateView = new Int32Array(gate);
  const order = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  let submissions = 0;
  class QueueController extends HttpControllerBase {
    static prefix = '/stress';
    static routes = [{ method: 'POST', path: '/queue', handler: 'queue' }];
    async queue(ctx) {
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
      } catch (error) {
        return { status: 503, body: { error: error.constructor.name } };
      }
    }
  }
  const application = new Application({ jobs: { poolSize: 1, queueSize: config.queueSize } });
  application.registerHttpController(QueueController);
  const address = await application.listen({ port: 0 });
  try {
    const running = request(address, '/stress/queue', { block: true, label: 'running' });
    await waitFor(() => Atomics.load(gateView, 1) === 1, 'running queue job');
    const queued = [];
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
      (result, index) =>
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

async function createWebSocketApplication() {
  class StressWebSocketController extends WebSocketControllerBase {
    static name = 'stress';
    static events = [{ name: 'echo', handler: 'echo' }];
    async echo(ctx) {
      return ctx.body;
    }
  }
  const application = new Application({ websocket: { maxPayload: 64 * 1024 } });
  application.registerWebSocketController(StressWebSocketController);
  const address = await application.listen({ port: 0 });
  return {
    application,
    url: `ws://${address.address}:${address.port}/websocket`,
  };
}

async function websocketProfiles(config) {
  const profiles = {};
  {
    const { application, url } = await createWebSocketApplication();
    const sockets = new Set();
    profiles.handshake = await runRamp('websocket-handshake', config, {
      close: async () => {
        await Promise.all([...sockets].map(closeWebSocket));
        await application.close();
      },
      connections: (step) => step.concurrency,
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
    const sockets = [];
    const counts = config.steps.map((step) =>
      Math.min(config.limits.maxConnections, step.concurrency * 4),
    );
    const steps = [];
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
              await new Promise((resolve) => setTimeout(resolve, 25));
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
      operation: async (worker) => {
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
    const closed = new Promise((resolve) =>
      oversized.addEventListener('close', (event) => resolve(event.code), { once: true }),
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

async function mixedProfile(config) {
  let jobIndex = 0;
  class MixedHttpController extends HttpControllerBase {
    static prefix = '/stress';
    static routes = [
      { method: 'GET', path: '/fast', handler: 'fast' },
      { method: 'POST', path: '/job', handler: 'job' },
    ];
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
      } catch (error) {
        return { status: 503, body: { error: error.constructor.name } };
      }
    }
  }
  class MixedWebSocketController extends WebSocketControllerBase {
    static name = 'mixed';
    static events = [{ name: 'echo', handler: 'echo' }];
    async echo(ctx) {
      return ctx.body;
    }
  }
  const poolSize = config.poolSizes.at(-1);
  const application = new Application({ jobs: { poolSize, queueSize: config.queueSize } });
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
      operation: async (worker) => {
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
  } catch (error) {
    await Promise.all(sockets.map(closeWebSocket));
    await application.close();
    throw error;
  }
}

function runChild(config, outputPath) {
  const timeoutMs = config.limits.maxDurationMs + 10_000;
  return new Promise((resolve, reject) => {
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
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`stress child failed (${signal ?? code}): ${Buffer.concat(stderr)}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString());
    });
  });
}

async function childMain(config, outputPath) {
  const profiles = {};
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
  Object.assign(profiles, await websocketProfiles(config));
  profiles.protocolErrors = await protocolErrorScenario();
  profiles.mixed = await mixedProfile(config);
  const failures = Object.entries(profiles)
    .filter(([, profile]) => profile.analysis?.recovery === 'not-recovered')
    .map(([name]) => `${name}: did not recover`);
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
  const stepMs = numberArgument('step-ms', config.steps[0].durationMs);
  const stepValues = argument('steps');
  if (stepValues || stepMs !== config.steps[0].durationMs) {
    config = createStressConfig({
      ...config.limits,
      maxDurationMs: config.limits.maxDurationMs,
      maxMemoryBytes: config.limits.maxMemoryBytes,
      queueSize: config.queueSize,
      recoveryDurationMs: stepMs,
      stepConcurrency: stepValues
        ? stepValues.split(',').map((value) => Number(value))
        : config.steps.map((step) => step.concurrency),
      stepDurationMs: stepMs,
    });
  }
  const summary = await runChild(config, outputPath);
  process.stdout.write(summary);
}

main()
  .catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  })
  .finally(() => request.agent.destroy());
