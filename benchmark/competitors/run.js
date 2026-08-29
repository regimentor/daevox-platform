import http from 'node:http';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { once } from 'node:events';

const frameworks = ['node', 'daevox', 'express', 'fastify', 'koa', 'hono', 'nestjs'];
const durationMs = Number(process.env.BENCHMARK_DURATION_MS ?? 10000);
const warmupMs = Number(process.env.BENCHMARK_WARMUP_MS ?? 2000);
const concurrency = Number(process.env.BENCHMARK_CONCURRENCY ?? 64);
const requestBody = JSON.stringify({ value: 'benchmark' });

function percentile(values, fraction) {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function request(port) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const clientRequest = http.request({ host: '127.0.0.1', port, path: '/benchmark', method: 'POST', agent: request.agent, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(requestBody) } }, (response) => {
      response.resume();
      response.on('end', () => response.statusCode === 200 ? resolve(performance.now() - started) : reject(new Error(`HTTP ${response.statusCode}`)));
    });
    clientRequest.on('error', reject);
    clientRequest.end(requestBody);
  });
}
request.agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });

async function start(framework) {
  const child = spawn(process.execPath, ['server.js', framework, '0'], { cwd: new URL('.', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 10000;
  while (!output.includes('\n')) {
    if (Date.now() > deadline) throw new Error(`${framework} did not start: ${output}`);
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit')]);
  }
  return { child, port: JSON.parse(output.trim().split('\n').at(-1)).port };
}

async function phase(port, milliseconds, record) {
  const deadline = performance.now() + milliseconds;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (performance.now() < deadline) {
      try { record(await request(port)); } catch { record(null); }
    }
  }));
}

async function benchmark(framework) {
  const { child, port } = await start(framework);
  const warmup = () => phase(port, warmupMs, () => {});
  await warmup();
  const latencies = []; let errors = 0;
  await phase(port, durationMs, (latency) => latency === null ? errors++ : latencies.push(latency));
  child.kill('SIGTERM');
  await once(child, 'exit');
  return { framework, requests: latencies.length, errors, throughput: latencies.length / (durationMs / 1000), p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99) };
}

const results = [];
for (const framework of frameworks) results.push(await benchmark(framework));
process.stdout.write(`${JSON.stringify({ node: process.version, durationMs, warmupMs, concurrency, results }, null, 2)}\n`);
