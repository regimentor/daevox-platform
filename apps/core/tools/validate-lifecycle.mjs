import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const base = process.env.CORE_VALIDATION_BASE;
assert(
  base,
  'Set CORE_VALIDATION_BASE explicitly: this test switches and unloads the active model',
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function api(path, body) {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  assert(response.ok, JSON.stringify(value));
  return value;
}
async function finish(id) {
  for (let i = 0; i < 300; i++) {
    const op = await api('/operations/' + id);
    assert.notEqual(op.status, 'failed', JSON.stringify(op));
    if (op.status === 'succeeded') return op;
    await sleep(100);
  }
  throw Error('operation timed out');
}
const initial = await api('/runtime');
const active = initial.active_instance;
assert(active);
const load = { preset_id: active.preset_id, preset_revision: active.applied_preset_revision };
async function stream() {
  const controller = new AbortController();
  const response = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: active.preset_id,
      messages: [{ role: 'user', content: 'Write a long list of numbers and keep going.' }],
      stream: true,
      ignore_eos: true,
      max_tokens: 1024,
      temperature: 0,
    }),
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const first = await reader.read();
  return { controller, reader, text: new TextDecoder().decode(first.value) };
}
async function rest(session) {
  try {
    while (true) {
      const item = await session.reader.read();
      if (item.done) break;
      session.text += new TextDecoder().decode(item.value);
    }
  } catch (error) {
    session.error = String(error);
  }
  return session.text;
}
const cancelled = await stream();
cancelled.controller.abort();
await rest(cancelled);
for (let i = 0; i < 100 && (await api('/runtime')).inflight_requests; i++) await sleep(20);
assert.equal((await api('/runtime')).inflight_requests, 0);
const draining = await stream();
const switching = await api('/runtime/switch', load);
const rejected = await fetch(base + '/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: active.preset_id, messages: [] }),
});
assert.equal(rejected.status, 503);
assert.equal((await rejected.json()).error.code, 'model_switching');
assert((await rest(draining)).includes('[DONE]'));
await finish(switching.operation_id);
assert.notEqual((await api('/runtime')).active_instance.id, active.id);
await sleep(1100);
const metrics = await api('/metrics');
const latest = metrics.samples.at(-1);
const owned = new Set(latest.processes.filter((p) => p.role === 'owned').map((p) => p.pid));
const allocated = latest.processes
  .filter((p) => owned.has(p.pid) && p.gpu_memory.some((g) => g.memory.value > 0))
  .map((p) => ({ pid: p.pid, gpus: p.gpu_memory }));
assert(allocated.length);
const forced = await stream();
const unloading = await api('/runtime/switch', { preset_id: null });
await api('/operations/' + unloading.operation_id + '/force', {});
const forceBody = await rest(forced);
assert(!forceBody.includes('[DONE]'), 'Force must not fabricate successful stream completion');
await finish(unloading.operation_id);
assert.deepEqual((await api('/v1/models')).data, []);
const processes = execFileSync(
  'nvidia-smi',
  ['--query-compute-apps=pid', '--format=csv,noheader,nounits'],
  { encoding: 'utf8' },
)
  .trim()
  .split('\n')
  .filter(Boolean)
  .map(Number);
assert(
  processes.every((pid) => !owned.has(pid)),
  'Owned GPU allocations survived unload',
);
await finish((await api('/runtime/switch', load)).operation_id);
await sleep(1100);
const finalMetrics = (await api('/metrics')).samples.at(-1);
assert(finalMetrics.inference.cancelled >= 2);
assert(finalMetrics.inference.succeeded >= 1);
assert(finalMetrics.inference.completion_tokens >= 1024);
console.log(
  JSON.stringify(
    {
      session_id: initial.session_id,
      abort: 'passed',
      drain: 'passed',
      admission_during_drain: '503 model_switching',
      force: 'passed without DONE',
      unload_gpu_allocations: 'gone',
      allocation_before_unload: allocated,
      inference: finalMetrics.inference,
      restored: (await api('/runtime')).active_instance,
    },
    null,
    2,
  ),
);
