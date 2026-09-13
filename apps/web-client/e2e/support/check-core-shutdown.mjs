import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const port = '3190';
const result = spawnSync('npm', ['run', 'test:e2e:core', '--', '--grep', 'build panel exposes'], {
  cwd: fileURLToPath(new URL('../..', import.meta.url)),
  env: { ...process.env, CORE_ROUTER_PORT: port },
  stdio: 'inherit',
});
assert.equal(result.status, 0, 'Browser scenario failed');
const response = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
assert.equal(
  response,
  null,
  'Browser tests leaked a model server: its HTTP port is still listening',
);
console.log('Browser shutdown: model server port closed');
