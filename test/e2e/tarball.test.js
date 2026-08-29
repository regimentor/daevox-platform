import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const projectDirectory = fileURLToPath(new URL('../..', import.meta.url));
const consumerFixtureDirectory = fileURLToPath(new URL('./fixtures/consumer', import.meta.url));

test('package предоставляет отдельную команду black-box e2e', async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(projectDirectory, 'package.json'), 'utf8'),
  );

  assert.equal(packageJson.scripts['test:e2e'], 'node --test test/e2e/*.test.js');
});

test('npm tarball содержит публичный API без тестов и scratch-файлов', async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'daevox-e2e-pack-'));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  const { stdout } = await execFileAsync(
    'npm',
    ['pack', '--json', '--pack-destination', temporaryDirectory],
    {
      cwd: projectDirectory,
      env: {
        ...process.env,
        npm_config_cache: path.join(temporaryDirectory, 'npm-cache'),
      },
    },
  );
  const packOutput = JSON.parse(stdout);
  const packResult = Array.isArray(packOutput) ? packOutput[0] : Object.values(packOutput)[0];
  const packagedPaths = packResult.files.map(({ path: packagedPath }) => packagedPath);

  assert.ok(packagedPaths.includes('package.json'));
  assert.ok(packagedPaths.includes('README.md'));
  assert.ok(packagedPaths.includes('lib/framework/Application.js'));
  assert.ok(packagedPaths.includes('lib/framework/HttpControllerBase.js'));
  assert.ok(packagedPaths.includes('lib/framework/EventListenerBase.js'));
  assert.ok(packagedPaths.includes('lib/framework/WebSocketControllerBase.js'));
  assert.ok(packagedPaths.includes('lib/framework/Job.js'));
  assert.ok(packagedPaths.every((packagedPath) => !packagedPath.startsWith('test/')));
  assert.ok(packagedPaths.every((packagedPath) => !packagedPath.startsWith('.scratch/')));
});

test('внешнее приложение устанавливает tarball и использует HTTP, WebSocket и задачу', async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'daevox-e2e-consumer-'));
  const npmCacheDirectory = path.join(temporaryDirectory, 'npm-cache');
  const packageDirectory = path.join(temporaryDirectory, 'package');
  const consumerDirectory = path.join(temporaryDirectory, 'consumer');
  const childEnvironment = {
    ...process.env,
    npm_config_cache: npmCacheDirectory,
  };
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  await cp(consumerFixtureDirectory, consumerDirectory, { recursive: true });
  await mkdir(packageDirectory);
  const { stdout: packOutput } = await execFileAsync(
    'npm',
    ['pack', '--json', '--pack-destination', packageDirectory],
    { cwd: projectDirectory, env: childEnvironment },
  );
  const parsedPackOutput = JSON.parse(packOutput);
  const packResult = Array.isArray(parsedPackOutput)
    ? parsedPackOutput[0]
    : Object.values(parsedPackOutput)[0];
  const tarballPath = path.join(packageDirectory, packResult.filename);

  await execFileAsync(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath],
    { cwd: consumerDirectory, env: childEnvironment },
  );

  const installedPackage = JSON.parse(
    await readFile(
      path.join(consumerDirectory, 'node_modules/daevox-node-framework/package.json'),
      'utf8',
    ),
  );
  assert.deepEqual(installedPackage.dependencies ?? {}, {});

  await execFileAsync('node', ['import-check.js'], {
    cwd: consumerDirectory,
    env: childEnvironment,
    timeout: 10_000,
  });
  const { stdout } = await execFileAsync('node', ['application.js'], {
    cwd: consumerDirectory,
    env: childEnvironment,
    timeout: 10_000,
  });

  assert.deepEqual(JSON.parse(stdout), {
    http: {
      status: 200,
      body: {
        sum: 6,
        state: { application: true, controller: true, route: '/calculations/sum' },
      },
    },
    httpError: { status: 422, body: { error: 'values must be finite numbers' } },
    httpFailure: { status: 500, body: { error: 'Internal Server Error' } },
    httpRecovery: {
      status: 200,
      body: {
        sum: 9,
        state: { application: true, controller: true, route: '/calculations/sum' },
      },
    },
    httpShortCircuit: {
      status: 401,
      body: { error: 'Middleware short-circuit' },
    },
    websocketError: { code: 'UNKNOWN_EVENT' },
    websocketFailure: { code: 'HANDLER_ERROR' },
    websocketShortCircuit: { shortCircuit: true },
    websocket: {
      message: 'hello from tarball',
      state: { messageCount: 3, controller: true, event: 'echo' },
    },
    applicationEvents: {
      handled: ['http:6', 'http:9', 'websocket'],
      errors: ['isolated listener failure'],
    },
  });
});
