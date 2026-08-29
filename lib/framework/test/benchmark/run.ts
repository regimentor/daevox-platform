import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus, platform, release } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { benchmarkConfig, REGRESSION_THRESHOLDS, SCHEMA_VERSION } from './config.ts';
import { compareBenchmark } from './compare.ts';

function hasFlag(name: any) {
  return process.argv.includes(`--${name}`);
}

function argument(name: any, fallback: any = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function environment() {
  const processors = cpus();
  const result = {
    architecture: process.arch,
    availableParallelism: availableParallelism(),
    cpuCount: processors.length,
    cpuModel: processors[0]?.model ?? 'unknown',
    node: process.version,
    platform: platform(),
    release: release(),
  };
  return { ...result, fingerprint: JSON.stringify(result) };
}

async function loadJson(filename: any) {
  try {
    return JSON.parse(await readFile(filename, 'utf8'));
  } catch (error: any) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function runProfile(name: any, profileConfig: any, phases: any, injectedDelayMs: any) {
  const script = fileURLToPath(new URL('./profile-process.ts', import.meta.url));
  const timeoutMs = phases.warmupMs + phases.measureMs + phases.cooldownMs + 10_000;
  return new Promise<any>((resolve: any, reject: any) => {
    const child = spawn(
      process.execPath,
      [
        script,
        '--profile',
        name,
        '--config',
        JSON.stringify(profileConfig),
        '--phases',
        JSON.stringify(phases),
        '--inject-delay-ms',
        String(injectedDelayMs),
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
        reject(
          new Error(
            `${name} benchmark failed (${signal ?? code}): ${Buffer.concat(stderr).toString()}`,
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString()));
      } catch (error: any) {
        reject(new Error(`${name} benchmark returned invalid JSON`, { cause: error }));
      }
    });
  });
}

function summary(artifact: any, outputPath: any) {
  const lines = [
    `Daevox benchmark (${artifact.mode})`,
    `Environment: ${artifact.environment.node}, ${artifact.environment.platform} ${artifact.environment.release}, ${artifact.environment.cpuCount} CPU`,
  ];
  for (const [name, profile] of Object.entries(artifact.profiles) as [string, any][]) {
    const { metrics } = profile;
    lines.push(
      `${name}: ${metrics.throughputPerSecond.toFixed(1)} ops/s, p95 ${metrics.latencyMs.p95.toFixed(2)} ms, errors ${(metrics.errorRate * 100).toFixed(2)}%`,
    );
  }
  lines.push(`Regression gate: ${artifact.regression.status}`);
  for (const reason of artifact.regression.reasons) lines.push(`  - ${reason}`);
  lines.push(`JSON artifact: ${outputPath}`);
  return lines.join('\n');
}

async function main() {
  const mode = argument('mode', 'smoke');
  const config = benchmarkConfig(mode);
  const injectedDelayMs = Number(argument('inject-delay-ms', '0'));
  if (!Number.isFinite(injectedDelayMs) || injectedDelayMs < 0) {
    throw new TypeError('--inject-delay-ms must be a non-negative number');
  }
  const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const baselinePath = path.resolve(
    argument('baseline', path.join(root, 'test/benchmark/baseline.json')),
  );
  const generatedAt = new Date().toISOString();
  const defaultOutput = path.join(
    root,
    'test/benchmark/results',
    `${generatedAt.replaceAll(':', '-')}-${mode}.json`,
  );
  const outputPath = path.resolve(argument('output', defaultOutput));
  const profiles: Record<string, any> = {};
  for (const [name, profileConfig] of Object.entries(config.profiles)) {
    profiles[name] = await runProfile(name, profileConfig, config.phases, injectedDelayMs);
  }
  const artifact: any = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    mode,
    environment: environment(),
    config: {
      injectedDelayMs,
      phases: config.phases,
      thresholds: REGRESSION_THRESHOLDS,
    },
    profiles,
  };
  const updateBaseline = hasFlag('update-baseline');
  if (updateBaseline && !hasFlag('confirm-baseline-update')) {
    throw new Error('--update-baseline requires --confirm-baseline-update');
  }
  const baseline = updateBaseline ? undefined : await loadJson(baselinePath);
  artifact.regression = updateBaseline
    ? { status: 'baseline-updated', reasons: [] }
    : compareBenchmark(artifact, baseline);
  const operationalFailures = Object.entries(profiles)
    .filter(([, profile]: any) => profile.metrics.errorRate > 0 || profile.metrics.successes === 0)
    .map(
      ([name, profile]: any) =>
        `${name}: ${profile.metrics.successes} successes, ${(profile.metrics.errorRate * 100).toFixed(2)}% errors`,
    );
  if (operationalFailures.length > 0) {
    artifact.regression = {
      status: 'failed',
      reasons: [...artifact.regression.reasons, ...operationalFailures],
    };
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
  if (updateBaseline) {
    await mkdir(path.dirname(baselinePath), { recursive: true });
    await writeFile(baselinePath, `${JSON.stringify(artifact, null, 2)}\n`);
  }
  process.stdout.write(`${summary(artifact, outputPath)}\n`);
  if (artifact.regression.status === 'failed') process.exitCode = 1;
}

main().catch((error: any) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
