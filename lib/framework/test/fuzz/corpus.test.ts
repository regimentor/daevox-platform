import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runFuzz } from './run.ts';

test('фиксированный corpus повреждённого HTTP и WebSocket ввода ограниченно завершается', async () => {
  const result = await runFuzz({ persistFailures: false });
  assert.ok(result.completed >= 20);
});

test('fuzzer обнаруживает нарушение WebSocket frame parsing', async () => {
  await assert.rejects(
    runFuzz({ injection: 'websocket-frame-parser', persistFailures: false }),
    /name=ws-unmasked/,
  );
});

test('fuzzer обнаруживает нарушение HTTP body limit', async () => {
  await assert.rejects(
    runFuzz({ injection: 'http-body-limit', persistFailures: false }),
    /name=http-body-limit-over-slow: unexpected HTTP status 200/,
  );
});

test('fuzzer обнаруживает пропущенную проверку multipart boundary', async () => {
  await assert.rejects(
    runFuzz({ injection: 'http-multipart-boundary', persistFailures: false }),
    /name=http-multipart-missing-boundary: unexpected HTTP status 204/,
  );
});

test('сохранённый сбой точно воспроизводится без повторного задания параметров', async () => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'daevox-fuzz-replay-'));
  try {
    await assert.rejects(
      runFuzz({
        injection: 'websocket-frame-parser',
        outputDirectory,
      }),
      /name=ws-unmasked/,
    );
    const metadataName = (await readdir(outputDirectory)).find((name: any) =>
      name.endsWith('.json'),
    );
    assert.ok(metadataName, 'fuzzer did not save replay metadata');
    await assert.rejects(
      runFuzz({ replay: path.join(outputDirectory, metadataName), persistFailures: false }),
      /name=ws-unmasked/,
    );
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('fuzzer отклоняет небезопасные границы собственного генератора', async () => {
  await assert.rejects(
    runFuzz({ depthLimit: 65, persistFailures: false }),
    /depthLimit must be an integer between 0 and 16/,
  );
  await assert.rejects(
    runFuzz({ operationLimit: 0, persistFailures: false }),
    /operationLimit must be a positive integer/,
  );
  await assert.rejects(
    runFuzz({ caseTimeout: 0, persistFailures: false }),
    /caseTimeout must be a positive integer/,
  );
});

test('лимиты операций и общего времени применяются ко всему case', async () => {
  await assert.rejects(
    runFuzz({ caseIndex: 30, operationLimit: 2, persistFailures: false }),
    /case exceeded the operation limit/,
  );
  await assert.rejects(
    runFuzz({ caseIndex: 30, caseTimeout: 10, persistFailures: false }),
    /exceeded 10ms/,
  );
});
