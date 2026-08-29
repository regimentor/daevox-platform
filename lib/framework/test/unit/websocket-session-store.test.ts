import assert from 'node:assert/strict';
import test from 'node:test';

import { WebSocketSessionStore } from '../../src/WebSocketSessionStore.ts';

test('WebSocketSessionStore сообщает об отсутствии удаляемой сессии', () => {
  const sessions = new WebSocketSessionStore();

  assert.equal(sessions.remove('missing-session'), false);
});
