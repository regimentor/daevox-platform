import assert from 'node:assert/strict';
import test from 'node:test';

import { WebSocketSessionStore } from '../../lib/framework/WebSocketSessionStore.js';

test('WebSocketSessionStore сообщает об отсутствии удаляемой сессии', () => {
  const sessions = new WebSocketSessionStore();

  assert.equal(sessions.remove('missing-session'), false);
});

test('WebSocketSessionStore ведёт двусторонний AuthSession membership', () => {
  const sessions = new WebSocketSessionStore();
  const firstConnection = { close() {} };
  const secondConnection = { close() {} };
  const isolatedConnection = { close() {} };
  const guestConnection = { close() {} };
  const sharedAuthSession = Object.freeze({
    authSessionId: 'shared',
    principal: Object.freeze({ id: 'user-1' }),
  });
  const isolatedAuthSession = Object.freeze({
    authSessionId: 'isolated',
    principal: Object.freeze({ id: 'user-1' }),
  });

  sessions.add('client-1', firstConnection, 'session-1', sharedAuthSession);
  sessions.add('client-2', secondConnection, 'session-2', sharedAuthSession);
  sessions.add('client-3', isolatedConnection, 'session-3', isolatedAuthSession);
  sessions.add('client-4', guestConnection, 'session-4');

  const sharedConnections = sessions.connectionsForAuthSession('shared');
  assert.deepEqual(sharedConnections, [firstConnection, secondConnection]);
  assert.ok(Object.isFrozen(sharedConnections));
  assert.deepEqual(sessions.connectionsForAuthSession('isolated'), [isolatedConnection]);
  assert.deepEqual(sessions.connectionsForAuthSession('missing'), []);
  assert.equal(sessions.authSessionForSession('session-2'), sharedAuthSession);
  assert.equal(sessions.authSessionForSession('session-4'), undefined);

  assert.equal(sessions.remove('session-1'), true);
  assert.deepEqual(sessions.connectionsForAuthSession('shared'), [secondConnection]);
  assert.deepEqual(sharedConnections, [firstConnection, secondConnection]);
  assert.equal(sessions.remove('session-1'), false);
  assert.equal(sessions.authSessionForSession('session-1'), undefined);
});
