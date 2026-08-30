class TestAppState {
  readonly marker = undefined;
}
import nodeHttp from 'node:http';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

import { Application } from '../../src/Application.ts';
import { HttpControllerBase } from '../../src/HttpControllerBase.ts';
import { WebSocketControllerBase } from '../../src/WebSocketControllerBase.ts';
import CpuBenchmarkJob from './fixtures/cpu-job.ts';

function argument(name: any, fallback: any = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function delay(milliseconds: any) {
  return new Promise<any>((resolve: any) => setTimeout(resolve, milliseconds));
}

function percentile(sorted: any, fraction: any) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function distribution(values: any) {
  const sorted = values.toSorted((left: any, right: any) => left - right);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
}

function request(address: any, { body, method = 'GET', path }: any) {
  const startedAt = performance.now();
  return new Promise<any>((resolve: any, reject: any) => {
    const clientRequest = nodeHttp.request(
      {
        ...address,
        agent: request.agent,
        headers:
          body === undefined
            ? undefined
            : {
                'content-length': Buffer.byteLength(body),
                'content-type': 'application/json',
              },
        method,
        path,
      },
      (response: any) => {
        const chunks: any[] = [];
        response.on('data', (chunk: any) => chunks.push(chunk));
        response.on('end', () => {
          const latencyMs = performance.now() - startedAt;
          if (response.statusCode !== 200) {
            reject(new Error(`HTTP ${response.statusCode}`));
            return;
          }
          try {
            resolve({ latencyMs, value: JSON.parse(Buffer.concat(chunks).toString()) });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    clientRequest.setTimeout(5_000, () => clientRequest.destroy(new Error('HTTP timeout')));
    clientRequest.on('error', reject);
    clientRequest.end(body);
  });
}
request.agent = new nodeHttp.Agent({ keepAlive: true });

function openWebSocket(url: any) {
  return new Promise<any>((resolve: any, reject: any) => {
    const socket = new WebSocket(url, 'daevox.v1');
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
}

function webSocketRequest(socket: any, body: any) {
  const startedAt = performance.now();
  return new Promise<any>((resolve: any, reject: any) => {
    const onError = () => reject(new Error('WebSocket request failed'));
    socket.addEventListener(
      'message',
      (event: any) => {
        socket.removeEventListener('error', onError);
        try {
          const message = JSON.parse(event.data);
          if (message.body?.size !== body.value.length) throw new Error('Invalid response');
          resolve({ latencyMs: performance.now() - startedAt, value: message.body });
        } catch (error) {
          reject(error);
        }
      },
      { once: true },
    );
    socket.addEventListener('error', onError, { once: true });
    socket.send(JSON.stringify({ controller: 'benchmark', event: 'echo', body }));
  });
}

async function runPhase(operation: any, concurrency: any, durationMs: any, recorder?: any) {
  const deadline = performance.now() + durationMs;
  await Promise.all(
    Array.from({ length: concurrency }, async (_: any, worker: any) => {
      while (performance.now() < deadline) {
        const startedAt = performance.now();
        try {
          const result = await operation(worker);
          recorder?.success(result);
        } catch (error) {
          recorder?.failure(error, performance.now() - startedAt);
        }
      }
    }),
  );
}

async function createHttpOperation(profile: any, config: any, injectedDelayMs: any) {
  const value = 'x'.repeat(config.messageBytes);
  class BenchmarkController extends HttpControllerBase {
    static prefix = '/benchmark';
    static routes = [{ method: 'POST', path: '/', handler: 'run' }];
    async run(_appState: any, ctx: any) {
      if (injectedDelayMs > 0) await delay(injectedDelayMs);
      return { status: 200, body: { size: ctx.body.value.length } };
    }
  }
  const body = JSON.stringify({ value });
  const application = new Application({
    appState: TestAppState,
    http: { bodyLimit: profile === 'http-body-limit' ? 65_536 : 1024 },
  });
  application.registerHttpController(BenchmarkController);
  const address = await application.listen({ port: 0 });
  return {
    close: () => application.close(),
    operation: () => request(address, { body, method: 'POST', path: '/benchmark' }),
  };
}

async function createWebSocketOperation(config: any, injectedDelayMs: any) {
  class BenchmarkController extends WebSocketControllerBase {
    static name = 'benchmark';
    static events = [{ name: 'echo', handler: 'echo' }];
    async echo(_appState: any, ctx: any) {
      if (injectedDelayMs > 0) await delay(injectedDelayMs);
      return { size: ctx.body.value.length };
    }
  }
  const application = new Application({ appState: TestAppState });
  application.registerWebSocketController(BenchmarkController);
  const address = await application.listen({ port: 0 });
  const url = `ws://${address.address}:${address.port}/websocket`;
  const sockets = await Promise.all(
    Array.from({ length: config.concurrency }, () => openWebSocket(url)),
  );
  const body = { value: 'x'.repeat(config.messageBytes) };
  return {
    close: async () => {
      for (const socket of sockets) socket.close();
      await application.close();
    },
    operation: (worker: any) => webSocketRequest(sockets[worker], body),
  };
}

async function createJobOperation(config: any, injectedDelayMs: any) {
  class JobController extends HttpControllerBase {
    static prefix = '/benchmark-job';
    static routes = [{ method: 'POST', path: '/', handler: 'run' }];
    async run() {
      const submittedAtNs = process.hrtime.bigint();
      const result = await this.jobRunner.run(CpuBenchmarkJob, {
        delayMs: injectedDelayMs,
        iterations: config.cpuIterations,
        submittedAtNs,
      });
      return {
        status: 200,
        body: {
          checksum: result.checksum,
          executionMs: Number(result.finishedAtNs - result.startedAtNs) / 1_000_000,
          queueMs: Number(result.startedAtNs - result.submittedAtNs) / 1_000_000,
        },
      };
    }
  }
  const application = new Application({
    appState: TestAppState,
    jobs: { poolSize: config.poolSize },
  });
  application.registerHttpController(JobController);
  const address = await application.listen({ port: 0 });
  return {
    close: () => application.close(),
    operation: () => request(address, { body: '{}', method: 'POST', path: '/benchmark-job' }),
  };
}

async function main() {
  const profile = argument('profile');
  const phases = JSON.parse(argument('phases'));
  const config = JSON.parse(argument('config'));
  const injectedDelayMs = Number(argument('inject-delay-ms', '0'));
  const resource =
    profile === 'websocket'
      ? await createWebSocketOperation(config, injectedDelayMs)
      : profile === 'job'
        ? await createJobOperation(config, injectedDelayMs)
        : await createHttpOperation(profile, config, injectedDelayMs);
  const latencies: any[] = [];
  const queueLatencies: any[] = [];
  const executionLatencies: any[] = [];
  const errors: any[] = [];
  let failures = 0;
  let successes = 0;
  try {
    await runPhase(resource.operation, config.concurrency, phases.warmupMs);

    const histogram = monitorEventLoopDelay({ resolution: 10 });
    const cpuStart = process.cpuUsage();
    const rssStart = process.memoryUsage().rss;
    let rssMax = rssStart;
    const rssSampler = setInterval(() => {
      rssMax = Math.max(rssMax, process.memoryUsage().rss);
    }, 25);
    histogram.enable();
    const measuredAt = performance.now();
    await runPhase(resource.operation, config.concurrency, phases.measureMs, {
      failure(error: any) {
        failures += 1;
        if (errors.length < 5) errors.push(error.message);
      },
      success(result: any) {
        successes += 1;
        latencies.push(result.latencyMs);
        if (profile === 'job') {
          queueLatencies.push(result.value.queueMs);
          executionLatencies.push(result.value.executionMs);
        }
      },
    });
    const measuredMs = performance.now() - measuredAt;
    histogram.disable();
    clearInterval(rssSampler);
    const cpu = process.cpuUsage(cpuStart);
    const rssEnd = process.memoryUsage().rss;
    rssMax = Math.max(rssMax, rssEnd);
    const attempts = successes + failures;
    const metrics: any = {
      attempts,
      cpu: {
        systemMs: cpu.system / 1_000,
        totalPercent: ((cpu.user + cpu.system) / 1_000 / measuredMs) * 100,
        userMs: cpu.user / 1_000,
      },
      errorRate: attempts === 0 ? 0 : failures / attempts,
      errors,
      eventLoopLagMs: {
        max: histogram.max / 1_000_000,
        p50: histogram.percentile(50) / 1_000_000,
        p95: histogram.percentile(95) / 1_000_000,
        p99: histogram.percentile(99) / 1_000_000,
      },
      latencyMs: distribution(latencies),
      measuredMs,
      rssBytes: { end: rssEnd, max: rssMax, start: rssStart },
      successes,
      throughputPerSecond: successes / (measuredMs / 1_000),
    };
    if (profile === 'job') {
      metrics.queueLatencyMs = distribution(queueLatencies);
      metrics.executionLatencyMs = distribution(executionLatencies);
    }
    await delay(phases.cooldownMs);
    process.stdout.write(`${JSON.stringify({ config, metrics, pid: process.pid, profile })}\n`);
  } finally {
    request.agent.destroy();
    await resource.close();
  }
}

main().catch((error: any) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
