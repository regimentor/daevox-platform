import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('CLI-точка входа запускает приложение', async () => {
  const { stderr, stdout } = await execFileAsync(process.execPath, ['src/cli.ts']);

  assert.equal(stderr, '');
  assert.equal(stdout, 'hello world\n');
});

test('CLI-точка входа сообщает об ошибке запуска и завершает процесс', async (t: any) => {
  const startupError = new Error('startup failed');
  let errorReported: any;
  const reported = new Promise<any>((resolve: any) => {
    errorReported = resolve;
  });
  t.mock.method(console, 'log', () => {
    throw startupError;
  });
  const consoleError = t.mock.method(console, 'error', (error: any) => errorReported(error));
  const processExit = t.mock.method(process, 'exit', () => {});

  await import('../../src/cli.ts');

  assert.equal(await reported, startupError);
  assert.equal(consoleError.mock.callCount(), 1);
  assert.equal(processExit.mock.callCount(), 1);
  assert.equal(processExit.mock.calls[0].arguments[0], 1);
});
