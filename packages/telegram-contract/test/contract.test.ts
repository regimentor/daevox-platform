import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCommand, isSnapshot, isAccepted, isSafeError } from '../src/index.ts';
import { isObservationCommand } from '../src/secretary.ts';
const expected = { instanceId: 'test', controlVersion: 0 };
const snapshot = {
  ...expected,
  revision: 1,
  client: 'running',
  connection: 'ready',
  authorization: { kind: 'not_connected' },
  allowedActions: ['connect'],
  operation: null,
  error: null,
};

test('strict commands reject unknown fields, invalid versions and password leakage', () => {
  assert.ok(isCommand({ expected }, 'connect'));
  assert.ok(isCommand({ expected, password: 'secret' }, 'submit_password'));
  for (const body of [
    null,
    [],
    {},
    { expected, password: 'secret' },
    { expected, extra: true },
    { expected: { ...expected, controlVersion: -1 } },
    { expected: { ...expected, controlVersion: 0.5 } },
    { expected: { ...expected, controlVersion: Number.MAX_SAFE_INTEGER + 1 } },
    { expected: { ...expected, secret: 'x' } },
  ])
    assert.equal(isCommand(body, 'connect'), false);
  for (const password of ['', 42, null, 'a'.repeat(4097)])
    assert.equal(isCommand({ expected, password }, 'submit_password'), false);
});
test('browser validates complete snapshots and variant fields', () => {
  assert.ok(isSnapshot(snapshot));
  for (const value of [
    null,
    { ...snapshot, secret: 'x' },
    { ...snapshot, allowedActions: ['connect', 'connect'] },
    { ...snapshot, authorization: { kind: 'password', link: 'tg://login?token=dGVzdA' } },
    { ...snapshot, authorization: { kind: 'qr', link: 'https://external.invalid' } },
    {
      ...snapshot,
      authorization: { kind: 'connected', account: { id: 42, displayName: 'x', username: null } },
    },
    { ...snapshot, operation: { id: 'x', kind: 'connect', status: 'pending', password: 'secret' } },
  ])
    assert.equal(isSnapshot(value), false);
  assert.ok(isSnapshot({ ...snapshot, authorization: { kind: 'qr', link: null } }));
  assert.ok(isAccepted({ instanceId: 'test', operationId: 'test' }));
  assert.equal(isAccepted({ instanceId: 'test' }), false);
  assert.equal(isSafeError({ code: 'raw_tdlib_error', message: 'secret' }), false);
});
test('observation command keeps context fields outside expected', () => {
  assert.ok(
    isObservationCommand({
      accountId: '287895731',
      chatId: '323014428',
      enabled: true,
      expected: {
        instanceId: '574eb4d7-a7cd-42a2-921b-ec727b805b0c',
        accountEpoch: 1,
        observationVersion: 0,
      },
    }),
  );
  assert.equal(
    isObservationCommand({
      accountId: '287895731',
      chatId: '323014428',
      enabled: true,
      expected: {
        instanceId: '574eb4d7-a7cd-42a2-921b-ec727b805b0c',
        accountId: '287895731',
        accountEpoch: 1,
        revision: 413,
        observationVersion: 0,
      },
    }),
    false,
  );
});

test('auto-reply commands validate account/chat IDs and independent setting version', async () => {
  const { isAutoReplyCommand } = await import('../src/secretary.ts');
  const command = {
    accountId: '42',
    chatId: '-100',
    enabled: true,
    expected: { instanceId: 'backend', accountEpoch: 1, autoReplyVersion: 0 },
  };
  assert.equal(isAutoReplyCommand(command), true);
  for (const invalid of [
    { ...command, chatId: '9007199254740992' },
    { ...command, accountId: 'garbage' },
    { ...command, enabled: 'yes' },
    { ...command, extra: true },
    { ...command, expected: { ...command.expected, observationVersion: 0 } },
    { ...command, expected: { ...command.expected, autoReplyVersion: -1 } },
  ])
    assert.equal(isAutoReplyCommand(invalid), false);
});
