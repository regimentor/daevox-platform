import assert from 'node:assert/strict';
import test from 'node:test';
import { ScheduledTaskBase } from '../../src/index.ts';

test('ScheduledTaskBase requires explicit dependencies and exposes immutable capabilities', () => {
  class Task extends ScheduledTaskBase {}
  assert.throws(() => new ScheduledTaskBase({} as any), TypeError);
  for (const value of [
    undefined,
    null,
    [],
    {},
    { jobRunner: {}, events: {} },
    { jobRunner: {}, events: {}, websocket: {}, extra: true },
  ]) {
    assert.throws(() => new Task(value as any), TypeError);
  }
  const dependencies = { jobRunner: {}, events: {}, websocket: {} } as any;
  const task = new Task(dependencies);
  for (const key of ['jobRunner', 'events', 'websocket'] as const) {
    assert.equal(task[key], dependencies[key]);
    assert.deepEqual(Object.getOwnPropertyDescriptor(task, key), {
      value: dependencies[key],
      writable: false,
      enumerable: true,
      configurable: false,
    });
  }
});
