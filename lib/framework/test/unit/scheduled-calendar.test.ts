import assert from 'node:assert/strict';
import test from 'node:test';
import { Application, ScheduledTaskBase } from '../../src/index.ts';

const scenarios = [
  ['leap day', 'UTC', '0 0 9 29 2 *', '2026-01-01T00:00:00Z', '2028-02-29T09:00:00Z'],
  ['day OR weekday', 'UTC', '0 0 9 31 2 1', '2026-02-01T10:00:00Z', '2026-02-02T09:00:00Z'],
  ['day only', 'UTC', '0 0 9 1 * *', '2026-01-01T10:00:00Z', '2026-02-01T09:00:00Z'],
  ['weekday only', 'UTC', '0 0 9 * * 7', '2026-01-01T00:00:00Z', '2026-01-04T09:00:00Z'],
  ['both match once', 'UTC', '0 0 9 1 * 1', '2026-06-01T08:59:59Z', '2026-06-01T09:00:00Z'],
  [
    'range step',
    'UTC',
    '5-20/5 10-20/5 9-17 * * *',
    '2026-01-01T09:15:06Z',
    '2026-01-01T09:15:10Z',
  ],
  ['numeric step', 'UTC', '5/10 * * * * *', '2026-01-01T00:00:05Z', '2026-01-01T00:00:15Z'],
  [
    'local timezone',
    'Asia/Kathmandu',
    '0 0 9 * * *',
    '2026-01-01T00:00:00Z',
    '2026-01-01T03:15:00Z',
  ],
  [
    'missing DST hour',
    'America/New_York',
    '0 30 2 * * *',
    '2026-03-08T06:59:59Z',
    '2026-03-09T06:30:00Z',
  ],
  [
    'first repeated hour',
    'America/New_York',
    '0 30 1 * * *',
    '2026-11-01T04:59:59Z',
    '2026-11-01T05:30:00Z',
  ],
  [
    'second repeated hour',
    'America/New_York',
    '0 30 1 * * *',
    '2026-11-01T05:30:00Z',
    '2026-11-01T06:30:00Z',
  ],
  [
    'half-hour DST gap',
    'Australia/Lord_Howe',
    '0 15 2 * * *',
    '2026-10-03T15:29:59Z',
    '2026-10-04T15:15:00Z',
  ],
];

for (const [name, zone, cron, activation, expected] of scenarios) {
  test(`ScheduledTask calendar: ${name}`, async (t) => {
    const previous = process.env.TZ;
    process.env.TZ = zone;
    t.after(() => {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    });
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(activation) });
    const firings: number[] = [];
    class State {
      marker = true;
    }
    class Tick extends ScheduledTaskBase {
      static cron = cron;
      async run() {
        firings.push(Date.now());
      }
    }
    const app = new Application({ appState: State }).registerScheduledTask(Tick);
    t.after(() => app.close());
    await app.listen({ port: 0 });
    const delta = Date.parse(expected) - Date.parse(activation);
    t.mock.timers.tick(delta - 1);
    assert.deepEqual(firings, []);
    t.mock.timers.tick(1);
    assert.deepEqual(firings, [Date.parse(expected)]);
  });
}

test('clock corrections coalesce forward jumps and never replay absolute instants', async (t) => {
  const previous = process.env.TZ;
  process.env.TZ = 'UTC';
  t.after(() => {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date('2026-01-01T08:00:00Z') });
  let count = 0;
  class State {
    marker = true;
  }
  class Tick extends ScheduledTaskBase {
    static cron = '0 0 9 * * *';
    async run() {
      count++;
    }
  }
  const app = new Application({ appState: State }).registerScheduledTask(Tick);
  t.after(() => app.close());
  await app.listen({ port: 0 });
  t.mock.timers.setTime(Date.parse('2026-01-03T09:00:00Z'));
  t.mock.timers.tick(1000);
  assert.equal(count, 1);
  await Promise.resolve();
  t.mock.timers.setTime(Date.parse('2026-01-03T08:59:59Z'));
  t.mock.timers.tick(1000);
  assert.equal(count, 1);
  t.mock.timers.tick(86400000);
  assert.equal(count, 2);
});

test('wall clock jumps are detected while monotonic timers have not reached the old deadline', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const originalNow = Date.now;
  let offset = 0;
  t.mock.method(Date, 'now', () => originalNow() + offset);
  let count = 0;
  class State {
    marker = true;
  }
  class Tick extends ScheduledTaskBase {
    static cron = '0 * * * * *';
    async run() {
      count++;
    }
  }
  const app = new Application({ appState: State }).registerScheduledTask(Tick);
  t.after(() => app.close());
  await app.listen({ port: 0 });
  offset = 120000;
  t.mock.timers.tick(1000);
  assert.equal(count, 1);
});
