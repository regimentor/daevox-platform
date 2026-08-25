import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocketConnection } from '../../lib/framework/WebSocketTransport.js';

class ControlledSocket extends EventEmitter {
  writable = true;
  writes = [];
  ends = [];
  destroys = 0;
  destroysSoon = 0;
  closeOnEnd = false;
  #writeResults;

  constructor(writeResults = []) {
    super();
    this.#writeResults = [...writeResults];
  }

  write(data) {
    this.writes.push(Buffer.from(data));
    return this.#writeResults.shift() ?? true;
  }

  end(data) {
    if (data !== undefined) this.ends.push(Buffer.from(data));
    this.writable = false;
    if (this.closeOnEnd) this.emit('close');
  }

  destroy() {
    this.destroys += 1;
    this.writable = false;
  }

  destroySoon() {
    this.destroysSoon += 1;
  }
}

function connection(socket, overrides = {}) {
  return new WebSocketConnection(socket, {
    maxPayload: 1024,
    maxWriteQueueBytes: 1024,
    onClose() {},
    onMessage() {},
    onProtocolError() {},
    ...overrides,
  });
}

test('WebSocket write queue ждёт drain и сохраняет FIFO', () => {
  const socket = new ControlledSocket([false, true, true]);
  const client = connection(socket);

  assert.equal(client.send('a'), true);
  assert.equal(client.send('b'), true);
  assert.equal(client.send('c'), true);
  assert.deepEqual(
    socket.writes.map((value) => value.toString('hex')),
    ['810161'],
  );
  assert.equal(socket.listenerCount('drain'), 1);

  socket.emit('drain');

  assert.deepEqual(
    socket.writes.map((value) => value.toString('hex')),
    ['810161', '810162', '810163'],
  );
  assert.equal(socket.listenerCount('drain'), 0);
});

test('переполнение write queue отклоняет frame и закрывает slow consumer кодом 1013', () => {
  const socket = new ControlledSocket([false]);
  const closes = [];
  const client = connection(socket, {
    maxWriteQueueBytes: 3,
    onClose: (code, reason) => closes.push({ code, reason }),
  });

  assert.equal(client.send('a'), true);
  assert.equal(client.send('b'), true);
  assert.equal(client.send('c'), false);

  assert.deepEqual(
    socket.writes.map((value) => value.toString('hex')),
    ['810161'],
  );
  assert.equal(socket.ends.length, 1);
  assert.equal(socket.ends[0][0], 0x88);
  assert.equal(socket.ends[0].readUInt16BE(2), 1013);
  assert.equal(socket.ends[0].subarray(4).toString(), 'Write queue overflow');
  assert.deepEqual(closes, [{ code: 1013, reason: 'Write queue overflow' }]);
  assert.equal(socket.listenerCount('drain'), 0);

  socket.emit('drain');
  assert.equal(client.send('d'), false);
  assert.equal(socket.writes.length, 1);
  assert.equal(socket.ends.length, 1);
});

test('pong проходит через ту же FIFO и не обгоняет заблокированный text frame', () => {
  const socket = new ControlledSocket([false, true]);
  const client = connection(socket);

  client.send('a');
  client.start(Buffer.from([0x89, 0x81, 1, 2, 3, 4, 0x79]));

  assert.deepEqual(
    socket.writes.map((value) => value.toString('hex')),
    ['810161'],
  );

  socket.emit('drain');

  assert.deepEqual(
    socket.writes.map((value) => value.toString('hex')),
    ['810161', '8a0178'],
  );
});

test('priority close очищает FIFO и сохраняет локальную причину при гонке с socket close', () => {
  const socket = new ControlledSocket([false]);
  socket.closeOnEnd = true;
  const closes = [];
  const client = connection(socket, {
    onClose: (code, reason) => closes.push({ code, reason }),
  });

  client.send('a');
  client.send('b');
  client.close(1000, 'done');
  client.close(1001, 'duplicate');
  socket.emit('drain');

  assert.deepEqual(closes, [{ code: 1000, reason: 'done' }]);
  assert.equal(socket.ends.length, 1);
  assert.equal(socket.ends[0].readUInt16BE(2), 1000);
  assert.equal(socket.ends[0].subarray(4).toString(), 'done');
  assert.deepEqual(
    socket.writes.map((value) => value.toString('hex')),
    ['810161'],
  );
  assert.equal(socket.listenerCount('drain'), 0);
});

test('socket error, end и close однократно очищают очередь и transport listeners', () => {
  for (const event of ['error', 'end', 'close']) {
    const socket = new ControlledSocket([false]);
    const closes = [];
    const client = connection(socket, {
      onClose: (code, reason) => closes.push({ code, reason }),
    });
    client.send('a');
    client.send('b');

    socket.emit(event, event === 'error' ? new Error('socket failed') : undefined);
    socket.emit('drain');
    socket.emit('close');

    assert.deepEqual(closes, [{ code: 1006, reason: '' }]);
    assert.equal(client.send('c'), false);
    assert.equal(socket.writes.length, 1);
    for (const name of ['data', 'drain', 'end', 'error', 'close']) {
      assert.equal(socket.listenerCount(name), 0);
    }
    assert.equal(socket.destroys, event === 'end' ? 1 : 0);
  }
});
