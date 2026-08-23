import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('точка входа запускает приложение', async () => {
  const { stderr, stdout } = await execFileAsync(process.execPath, ['src/index.js']);

  assert.equal(stderr, '');
  assert.equal(stdout, 'hello world\n');
});
