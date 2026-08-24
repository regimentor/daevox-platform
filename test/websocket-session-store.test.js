import assert from 'node:assert/strict';
import test from 'node:test';

import { WebSocketSessionStore } from '../lib/framework/WebSocketSessionStore.js';

test('WebSocketSessionStore сообщает об отсутствии удаляемой сессии', () => {
  const sessions = new WebSocketSessionStore();

  assert.equal(sessions.remove('missing-session'), false);
});
