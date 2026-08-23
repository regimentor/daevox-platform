import assert from 'node:assert/strict';
import test from 'node:test';

import { Job } from '../lib/framework/Job.js';
import { JobRunner } from '../lib/framework/JobRunner.js';
import { InvalidJobError } from '../lib/framework/errors.js';
import {
  InvalidJobOptionsError,
  JobAbortedError,
  JobDataCloneError,
  JobExecutionError,
  JobQueueFullError,
  JobRunnerClosedError,
  JobTimedOutError,
  WorkerTerminatedError,
} from '../lib/framework/errors.js';
import ControlJob from './fixtures/jobs/control-job.js';
import EchoJob from './fixtures/jobs/echo-job.js';
import StatefulJob from './fixtures/jobs/stateful-job.js';
import ProtocolJob from './fixtures/jobs/protocol-job.js';

function UnrelatedJob() {}

test('Job нельзя создать напрямую', () => {
  assert.throws(() => new Job(), InvalidJobError);
});

test('задача обязана напрямую наследовать Job', () => {
  class IntermediateJob extends Job {
    static metaUrl = import.meta.url;
    run() {}
  }
  class IndirectJob extends IntermediateJob {}

  const runner = new JobRunner();

  for (const JobClass of [null, {}, UnrelatedJob, IndirectJob]) {
    assert.throws(() => runner.run(JobClass), InvalidJobError);
  }
});

test('задача обязана объявить собственные data-поле metaUrl и метод run', () => {
  class MissingMetaUrlJob extends Job {
    run() {}
  }
  class MetaUrlAccessorJob extends Job {
    static get metaUrl() {
      return import.meta.url;
    }
    run() {}
  }
  class MissingRunJob extends Job {
    static metaUrl = import.meta.url;
  }
  class StaticRunJob extends Job {
    static metaUrl = import.meta.url;
    static run() {}
  }

  const runner = new JobRunner();

  for (const JobClass of [MissingMetaUrlJob, MetaUrlAccessorJob, MissingRunJob, StaticRunJob]) {
    assert.throws(() => runner.run(JobClass), InvalidJobError);
  }
});

test('JobRunner выполняет default-export задачи в Worker и возвращает результат', async (t) => {
  const runner = new JobRunner();
  t.after(() => runner.close());

  const payload = { id: 42, values: new Set(['worker']) };

  assert.deepEqual(await runner.run(EchoJob, payload), payload);
});

test('JobRunner синхронно отклоняет неверные options', async (t) => {
  const runner = new JobRunner();
  t.after(() => runner.close());

  for (const options of [
    null,
    [],
    { unknown: true },
    { signal: {} },
    { timeout: -1 },
    { timeout: Infinity },
  ]) {
    assert.throws(() => runner.run(EchoJob, undefined, options), InvalidJobOptionsError);
  }
});

test('JobRunner восстанавливает ошибку задачи и цепочку cause', async (t) => {
  const runner = new JobRunner();
  t.after(() => runner.close());

  await assert.rejects(runner.run(ControlJob, { type: 'throw' }), (error) => {
    assert(error instanceof JobExecutionError);
    assert.equal(error.cause.name, 'RangeError');
    assert.equal(error.cause.message, 'job failed');
    assert.equal(error.cause.cause.message, 'root cause');
    return true;
  });
  assert.deepEqual(await runner.run(EchoJob, 'reused'), 'reused');
});

test('JobRunner нормализует выброшенное задачей значение, не являющееся Error', async (t) => {
  const runner = new JobRunner();
  t.after(() => runner.close());

  await assert.rejects(runner.run(ControlJob, { type: 'throw-value' }), (error) => {
    assert(error instanceof JobExecutionError);
    assert.equal(error.cause.name, 'Error');
    assert.equal(error.cause.message, 'plain failure');
    return true;
  });
});

test('JobRunner безопасно обрывает циклическую цепочку cause', async (t) => {
  const runner = new JobRunner({ poolSize: 1 });
  t.after(() => runner.close());

  await assert.rejects(runner.run(ControlJob, { type: 'throw-circular-cause' }), (error) => {
    assert(error instanceof JobExecutionError);
    assert.equal(error.cause.message, 'circular failure');
    assert.equal(error.cause.cause.message, 'Circular error cause');
    return true;
  });
  assert.equal(await runner.run(EchoJob, 'reused'), 'reused');
});

test('Worker окончательно проверяет default-export модуля задачи', async (t) => {
  class DeclaredJob extends Job {
    static metaUrl = new URL('./fixtures/jobs/invalid-default-job.js', import.meta.url).href;
    run() {}
  }
  const runner = new JobRunner();
  t.after(() => runner.close());

  await assert.rejects(runner.run(DeclaredJob), (error) => {
    assert(error instanceof JobExecutionError);
    assert.equal(error.cause.name, 'TypeError');
    return true;
  });
});

test('JobRunner различает ошибки structured clone payload и результата', async (t) => {
  const runner = new JobRunner();
  t.after(() => runner.close());

  await assert.rejects(
    runner.run(EchoJob, () => {}),
    JobDataCloneError,
  );
  await assert.rejects(runner.run(ControlJob, { type: 'uncloneable' }), JobDataCloneError);
});

test('WorkerPool ограничивает очередь и запускает ожидающие задачи FIFO', async (t) => {
  const runner = new JobRunner({ poolSize: 1, queueSize: 1 });
  t.after(() => runner.close());

  const first = runner.run(ControlJob, { type: 'wait', ms: 30, value: 'first' });
  const second = runner.run(ControlJob, { type: 'wait', ms: 0, value: 'second' });

  await assert.rejects(runner.run(EchoJob, 'third'), JobQueueFullError);
  assert.deepEqual(await first, { aborted: false, value: 'first' });
  assert.deepEqual(await second, { aborted: false, value: 'second' });
});

test('JobRunner отменяет ожидающую и выполняющуюся задачу', async (t) => {
  const runner = new JobRunner({ poolSize: 1, queueSize: 1, terminationGracePeriod: 10 });
  t.after(() => runner.close());
  const runningController = new AbortController();
  const running = runner.run(
    ControlJob,
    { type: 'wait', ms: 1000 },
    { signal: runningController.signal },
  );
  const queuedController = new AbortController();
  const queued = runner.run(EchoJob, 'queued', { signal: queuedController.signal });

  queuedController.abort();
  runningController.abort();

  await assert.rejects(queued, JobAbortedError);
  await assert.rejects(running, JobAbortedError);
  assert.equal(await runner.run(EchoJob, 'replacement'), 'replacement');
});

test('уже отменённый сигнал не создаёт Worker и сразу отклоняет задачу', async (t) => {
  const runner = new JobRunner();
  t.after(() => runner.close());
  const signal = AbortSignal.abort();

  await assert.rejects(runner.run(EchoJob, 'unused', { signal }), JobAbortedError);
});

test('timeout действует на ожидающую и выполняющуюся задачу', async (t) => {
  const runner = new JobRunner({ poolSize: 1, queueSize: 1, terminationGracePeriod: 5 });
  t.after(() => runner.close());
  const running = runner.run(ControlJob, { type: 'wait', ms: 1000 }, { timeout: 10 });
  const queued = runner.run(EchoJob, 'queued', { timeout: 0 });

  await assert.rejects(queued, JobTimedOutError);
  await assert.rejects(running, JobTimedOutError);
});

test('аварийное завершение Worker отклоняет задачу и пул восстанавливается', async (t) => {
  const runner = new JobRunner({ poolSize: 1 });
  t.after(() => runner.close());

  await assert.rejects(runner.run(ControlJob, { type: 'crash' }), WorkerTerminatedError);
  assert.equal(await runner.run(EchoJob, 'after crash'), 'after crash');
});

test('некооперативная задача принудительно завершается после grace period', async (t) => {
  const runner = new JobRunner({ poolSize: 1, terminationGracePeriod: 1 });
  t.after(() => runner.close());
  const controller = new AbortController();
  const hanging = runner.run(ControlJob, { type: 'hang' }, { signal: controller.signal });

  controller.abort();

  await assert.rejects(hanging, JobAbortedError);
  assert.equal(await runner.run(EchoJob, 'replacement'), 'replacement');
});

test('Worker с нарушенным протоколом завершается и заменяется', async (t) => {
  const runner = new JobRunner({ poolSize: 1 });
  t.after(() => runner.close());

  await assert.rejects(
    runner.run(ProtocolJob, { id: 999, status: 'success' }),
    WorkerTerminatedError,
  );
  assert.equal(await runner.run(EchoJob, 'after wrong id'), 'after wrong id');
});

test('Worker с неизвестным статусом протокола завершается', async (t) => {
  const runner = new JobRunner({ poolSize: 1 });
  t.after(() => runner.close());

  await assert.rejects(
    runner.run(ProtocolJob, { id: 1, status: 'unknown' }),
    WorkerTerminatedError,
  );
});

test('Worker кеширует модуль задачи, но создаёт новый экземпляр для каждого запуска', async (t) => {
  const runner = new JobRunner({ poolSize: 1 });
  t.after(() => runner.close());

  assert.equal(await runner.run(StatefulJob), 1);
  assert.equal(await runner.run(StatefulJob), 2);
});

test('close удаляет очередь и ограничивает graceful shutdown', async () => {
  const runner = new JobRunner({ poolSize: 1, queueSize: 1, shutdownTimeout: 5 });
  const running = runner.run(ControlJob, { type: 'wait', ms: 1000 });
  const queued = runner.run(EchoJob, 'queued');
  const runningRejected = assert.rejects(running, WorkerTerminatedError);
  const queuedRejected = assert.rejects(queued, JobAbortedError);

  await runner.close();
  await queuedRejected;
  await runningRejected;
});

test('close идемпотентен и запрещает новые задачи', async () => {
  const runner = new JobRunner();
  const closing = runner.close();

  assert.equal(runner.close(), closing);
  await closing;
  assert.throws(() => runner.run(EchoJob), JobRunnerClosedError);
});
