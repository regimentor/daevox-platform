import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Application } from '../../lib/framework/Application.js';
import { HttpControllerBase } from '../../lib/framework/HttpControllerBase.js';
import { WebSocketControllerBase } from '../../lib/framework/WebSocketControllerBase.js';
import {
  clientFrame,
  deserializeCase,
  fixedCorpus,
  generatedCases,
  serializeCase,
} from './cases.js';

const DEFAULT_BODY_LIMIT = 256;
const DEFAULT_CASE_TIMEOUT = 1_000;
const DEFAULT_DEPTH_LIMIT = 4;
const DEFAULT_OPERATION_LIMIT = 1_000;
const DEFAULT_GENERATED_CASES = 200;
const DEFAULT_SEED = 0xdae0f00d;
const MAX_DEPTH_LIMIT = 16;
const HANDSHAKE = Buffer.from(
  'GET /websocket HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: daevox.v1\r\n\r\n',
);
const VALID_ENVELOPE = Buffer.from(
  JSON.stringify({ controller: 'fuzz', event: 'echo', body: { value: 'health' } }),
);

class FuzzHttpController extends HttpControllerBase {
  static prefix = '/fuzz';
  static routes = [
    { method: 'GET', path: '/health', handler: 'health' },
    { method: 'POST', path: '/echo', handler: 'echo' },
  ];
  health() {
    return { status: 200, body: { ok: true } };
  }
  echo(ctx) {
    return { status: 200, body: ctx.body };
  }
}

class FuzzWebSocketController extends WebSocketControllerBase {
  static name = 'fuzz';
  static events = [{ name: 'echo', handler: 'echo' }];
  echo(ctx) {
    return { value: ctx.body.value };
  }
}

class SocketObserver {
  #buffer = Buffer.alloc(0);
  #closed = false;
  #error;
  #waiters = new Set();

  constructor(socket) {
    socket.on('connect', () => this.#notify());
    socket.on('data', (chunk) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#notify();
    });
    socket.on('error', (error) => {
      this.#error = error;
      this.#notify();
    });
    socket.on('close', () => {
      this.#closed = true;
      this.#notify();
    });
  }

  get buffer() {
    return this.#buffer;
  }

  get closed() {
    return this.#closed;
  }

  consume(length) {
    this.#buffer = this.#buffer.subarray(length);
  }

  waitFor(predicate, timeout, label, reportedTimeout = timeout) {
    return new Promise((resolve, reject) => {
      const waiter = () => {
        let result;
        try {
          result = predicate(this.#buffer, this.#closed, this.#error);
        } catch (error) {
          finish(reject, error);
          return;
        }
        if (result !== undefined) finish(resolve, result);
      };
      const timer = setTimeout(
        () => finish(reject, new Error(`${label} exceeded ${reportedTimeout}ms`)),
        timeout,
      );
      const finish = (settle, value) => {
        clearTimeout(timer);
        this.#waiters.delete(waiter);
        settle(value);
      };
      this.#waiters.add(waiter);
      waiter();
    });
  }

  #notify() {
    for (const waiter of this.#waiters) waiter();
  }
}

function parseServerFrames(bytes) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= bytes.byteLength) {
    const first = bytes[offset];
    const second = bytes[offset + 1];
    let length = second & 0x7f;
    let headerLength = 2;
    if ((second & 0x80) !== 0) throw new Error('server sent a masked WebSocket frame');
    if (length === 126) {
      if (offset + 4 > bytes.byteLength) break;
      length = bytes.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (offset + 10 > bytes.byteLength) break;
      const largeLength = bytes.readBigUInt64BE(offset + 2);
      if (largeLength > 1_048_576n) throw new Error('server frame exceeded fuzzer limit');
      length = Number(largeLength);
      headerLength = 10;
    }
    if (offset + headerLength + length > bytes.byteLength) break;
    frames.push({
      final: (first & 0x80) !== 0,
      opcode: first & 0x0f,
      payload: bytes.subarray(offset + headerLength, offset + headerLength + length),
    });
    offset += headerLength + length;
  }
  return frames;
}

function observedWebSocketOutcome(bytes, closed) {
  const frames = parseServerFrames(bytes);
  const close = frames.find((frame) => frame.opcode === 8);
  const texts = frames.filter((frame) => frame.opcode === 1);
  const pongs = frames.filter((frame) => frame.opcode === 10);
  return {
    closed,
    closeCode: close?.payload.byteLength >= 2 ? close.payload.readUInt16BE(0) : undefined,
    texts,
    pongs,
  };
}

function websocketSatisfied(expectation, outcome) {
  if (expectation.reset) return outcome.closed ? outcome : undefined;
  if (expectation.closeCode !== undefined) {
    return outcome.closeCode !== undefined && outcome.closed ? outcome : undefined;
  }
  const textCount = expectation.textMessages ?? 0;
  const pongCount = expectation.pongCount ?? expectation.pongPayloads?.length ?? 0;
  return outcome.texts.length >= textCount && outcome.pongs.length >= pongCount
    ? outcome
    : undefined;
}

function assertWebSocketOutcome(expectation, outcome) {
  if (expectation.reset) {
    assert.equal(outcome.closed, true, 'expected a controlled connection reset');
    return;
  }
  if (expectation.closeCode !== undefined) {
    assert.equal(outcome.closeCode, expectation.closeCode, 'unexpected WebSocket close code');
  }
  if (expectation.textMessages !== undefined) {
    assert.equal(outcome.texts.length, expectation.textMessages, 'unexpected text frame count');
  }
  if (expectation.pongCount !== undefined) {
    assert.equal(outcome.pongs.length, expectation.pongCount, 'unexpected pong count');
  }
  if (expectation.pongPayloads) {
    assert.deepEqual(
      outcome.pongs.map((frame) => frame.payload.toString()),
      expectation.pongPayloads,
      'unexpected pong payloads',
    );
  }
  if (expectation.errorCode) {
    const messages = outcome.texts.map((frame) => JSON.parse(frame.payload.toString()));
    assert.ok(
      messages.some((message) => message.body?.error?.code === expectation.errorCode),
      `missing recoverable ${expectation.errorCode} response`,
    );
    assert.ok(
      messages.some((message) => message.body?.value === 'ok'),
      'connection did not process the valid message after a recoverable error',
    );
  }
}

function remainingTime(deadline, totalTimeout, label) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`${label} exceeded ${totalTimeout}ms`);
  return remaining;
}

async function connect(address, sockets, timeout, reportedTimeout = timeout) {
  const socket = net.connect(address.port, address.address);
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
  const observer = new SocketObserver(socket);
  await observer.waitFor(
    (_bytes, _closed, error) => {
      if (error) throw error;
      return socket.readyState === 'open' ? true : undefined;
    },
    timeout,
    'TCP connect',
    reportedTimeout,
  );
  socket.setNoDelay(true);
  return { observer, socket };
}

async function writeChunks(socket, chunks, testCase, limits, deadline) {
  const operationCount = chunks.reduce((total, chunk) => {
    if (chunk.byteLength === 0) return total;
    const chunkSize = testCase.chunkSize ?? chunk.byteLength;
    return total + Math.ceil(chunk.byteLength / chunkSize);
  }, 0);
  assert.ok(operationCount <= limits.operationLimit, 'case exceeded the operation limit');
  for (const original of chunks) {
    for (
      let offset = 0;
      offset < original.byteLength;
      offset += testCase.chunkSize ?? original.byteLength
    ) {
      remainingTime(deadline, limits.caseTimeout, testCase.name);
      const chunk = original.subarray(offset, offset + (testCase.chunkSize ?? original.byteLength));
      if (!socket.write(chunk)) await new Promise((resolve) => socket.once('drain', resolve));
      if (testCase.chunkSize) await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  remainingTime(deadline, limits.caseTimeout, testCase.name);
  if (testCase.endInput) socket.end();
}

async function executeWebSocketCase(address, testCase, limits, sockets) {
  const deadline = Date.now() + limits.caseTimeout;
  const { observer, socket } = await connect(
    address,
    sockets,
    remainingTime(deadline, limits.caseTimeout, testCase.name),
    limits.caseTimeout,
  );
  try {
    socket.write(HANDSHAKE);
    const headerEnd = await observer.waitFor(
      (bytes, closed, error) => {
        if (error) throw error;
        const end = bytes.indexOf('\r\n\r\n');
        if (end !== -1) return end + 4;
        if (closed) throw new Error('connection closed before WebSocket handshake');
        return undefined;
      },
      remainingTime(deadline, limits.caseTimeout, testCase.name),
      'WebSocket handshake',
      limits.caseTimeout,
    );
    assert.match(observer.buffer.subarray(0, headerEnd).toString(), /^HTTP\/1\.1 101 /);
    observer.consume(headerEnd);
    await writeChunks(socket, testCase.chunks, testCase, limits, deadline);
    const outcome = await observer.waitFor(
      (bytes, closed, error) => {
        if (error && !closed) return observedWebSocketOutcome(bytes, true);
        return websocketSatisfied(testCase.expectation, observedWebSocketOutcome(bytes, closed));
      },
      remainingTime(deadline, limits.caseTimeout, testCase.name),
      testCase.name,
      limits.caseTimeout,
    );
    assertWebSocketOutcome(testCase.expectation, outcome);
  } finally {
    socket.destroy();
  }
}

async function executeHttpCase(address, testCase, limits, sockets) {
  const deadline = Date.now() + limits.caseTimeout;
  const { observer, socket } = await connect(
    address,
    sockets,
    remainingTime(deadline, limits.caseTimeout, testCase.name),
    limits.caseTimeout,
  );
  try {
    await writeChunks(socket, testCase.chunks, testCase, limits, deadline);
    const outcome = await observer.waitFor(
      (bytes, closed, error) => {
        const match = /^HTTP\/1\.1 (\d{3}) /.exec(bytes.toString());
        if (match) return { status: Number(match[1]), reset: false };
        if (closed || error) return { reset: true };
        return undefined;
      },
      remainingTime(deadline, limits.caseTimeout, testCase.name),
      testCase.name,
      limits.caseTimeout,
    );
    if (testCase.expectation.reset) assert.equal(outcome.reset, true, 'expected reset');
    else {
      assert.ok(
        testCase.expectation.statuses.includes(outcome.status),
        `unexpected HTTP status ${outcome.status ?? 'reset'}`,
      );
    }
  } finally {
    socket.destroy();
  }
}

async function waitForNoSockets(sockets, timeout) {
  const started = Date.now();
  while (sockets.size > 0 && Date.now() - started < timeout) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(sockets.size, 0, 'client connections grew between fuzz cases');
}

async function healthCheck(address, limits, sockets) {
  await executeHttpCase(
    address,
    {
      name: 'post-fuzz-http-health',
      protocol: 'http',
      chunks: [Buffer.from('GET /fuzz/health HTTP/1.1\r\nHost: localhost\r\n\r\n')],
      expectation: { statuses: [200] },
    },
    limits,
    sockets,
  );
  await executeWebSocketCase(
    address,
    {
      name: 'post-fuzz-websocket-health',
      protocol: 'websocket',
      chunks: [clientFrame({ payload: VALID_ENVELOPE })],
      expectation: { textMessages: 1 },
    },
    limits,
    sockets,
  );
}

function applyInjection(testCase, injection) {
  if (injection === 'websocket-frame-parser' && testCase.name === 'ws-unmasked') {
    return {
      ...testCase,
      chunks: [clientFrame({ payload: VALID_ENVELOPE })],
    };
  }
  return testCase;
}

async function saveFailure(
  testCase,
  seed,
  caseIndex,
  error,
  outputDirectory,
  injection,
  configuration,
) {
  await mkdir(outputDirectory, { recursive: true });
  const basename = `failure-${seed}-${caseIndex}`;
  const metadataPath = path.resolve(outputDirectory, `${basename}.json`);
  const bytesPath = path.resolve(outputDirectory, `${basename}.bin`);
  await writeFile(bytesPath, Buffer.concat(testCase.chunks));
  await writeFile(
    metadataPath,
    `${JSON.stringify(
      {
        seed,
        caseIndex,
        injection,
        configuration,
        error: { name: error.name, message: error.message, stack: error.stack },
        bytesPath,
        case: serializeCase(testCase),
        replay: `npm run fuzz:replay -- --replay ${metadataPath}`,
      },
      null,
      2,
    )}\n`,
  );
  return { bytesPath, metadataPath };
}

export async function runFuzz(options = {}) {
  const replayArtifact = options.replay
    ? JSON.parse(await readFile(options.replay, 'utf8'))
    : undefined;
  const seed = Number(options.seed ?? replayArtifact?.seed ?? DEFAULT_SEED) >>> 0;
  const bodyLimit =
    options.bodyLimit ?? replayArtifact?.configuration?.bodyLimit ?? DEFAULT_BODY_LIMIT;
  const limits = {
    caseTimeout:
      options.caseTimeout ?? replayArtifact?.configuration?.caseTimeout ?? DEFAULT_CASE_TIMEOUT,
    operationLimit:
      options.operationLimit ??
      replayArtifact?.configuration?.operationLimit ??
      DEFAULT_OPERATION_LIMIT,
  };
  const depthLimit =
    options.depthLimit ?? replayArtifact?.configuration?.depthLimit ?? DEFAULT_DEPTH_LIMIT;
  if (!Number.isInteger(depthLimit) || depthLimit < 0 || depthLimit > MAX_DEPTH_LIMIT) {
    throw new TypeError(`depthLimit must be an integer between 0 and ${MAX_DEPTH_LIMIT}`);
  }
  if (!Number.isInteger(limits.operationLimit) || limits.operationLimit <= 0) {
    throw new TypeError('operationLimit must be a positive integer');
  }
  if (!Number.isInteger(limits.caseTimeout) || limits.caseTimeout <= 0) {
    throw new TypeError('caseTimeout must be a positive integer');
  }
  const injection = options.injection ?? replayArtifact?.injection;
  let cases;
  if (replayArtifact) {
    cases = [deserializeCase(replayArtifact.case)];
  } else {
    cases = fixedCorpus(bodyLimit);
    if (options.mode === 'full') {
      cases.push(
        ...generatedCases(
          seed,
          options.generatedCases ?? DEFAULT_GENERATED_CASES,
          bodyLimit,
          depthLimit,
        ),
      );
    }
    if (options.caseIndex !== undefined) cases = [cases[options.caseIndex]];
  }
  assert.ok(cases.length > 0 && cases.every(Boolean), 'no fuzz cases selected');

  const sockets = new Set();
  const asynchronousErrors = [];
  let connections = 0;
  let disconnections = 0;
  const onUncaughtException = (error) =>
    asynchronousErrors.push({ type: 'uncaughtException', error });
  const onUnhandledRejection = (error) =>
    asynchronousErrors.push({ type: 'unhandledRejection', error });
  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);
  const effectiveBodyLimit = injection === 'http-body-limit' ? bodyLimit + 1 : bodyLimit;
  const app = new Application({
    http: { bodyLimit: effectiveBodyLimit, shutdownTimeout: limits.caseTimeout },
    websocket: {
      maxPayload: bodyLimit,
      onConnect() {
        connections += 1;
      },
      onDisconnect() {
        disconnections += 1;
      },
    },
  });
  app.registerHttpController(FuzzHttpController);
  app.registerWebSocketController(FuzzWebSocketController);
  const address = await app.listen({ port: 0 });
  let completed = 0;
  try {
    for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
      const originalCase = cases[caseIndex];
      const testCase = applyInjection(originalCase, injection);
      assert.ok(
        testCase.chunks.reduce((total, chunk) => total + chunk.byteLength, 0) <= 64 * 1024,
        'case exceeded the byte limit',
      );
      try {
        if (testCase.protocol === 'websocket') {
          await executeWebSocketCase(address, testCase, limits, sockets);
        } else {
          await executeHttpCase(address, testCase, limits, sockets);
        }
        await waitForNoSockets(sockets, limits.caseTimeout);
        if (asynchronousErrors.length > 0) {
          throw new AggregateError(
            asynchronousErrors.map((entry) => entry.error),
            `process observed ${asynchronousErrors.map((entry) => entry.type).join(', ')}`,
          );
        }
        completed += 1;
      } catch (error) {
        error.message = `seed=${seed} case=${caseIndex} name=${testCase.name}: ${error.message}`;
        if (options.persistFailures !== false) {
          const artifact = await saveFailure(
            originalCase,
            seed,
            caseIndex,
            error,
            options.outputDirectory ?? './test/fuzz/failures',
            injection,
            { bodyLimit, depthLimit, ...limits },
          );
          error.message += `; case=${artifact.metadataPath}; bytes=${artifact.bytesPath}`;
        }
        throw error;
      }
    }
    await healthCheck(address, limits, sockets);
    await waitForNoSockets(sockets, limits.caseTimeout);
  } finally {
    for (const socket of sockets) socket.destroy();
    await app.close();
    process.off('uncaughtException', onUncaughtException);
    process.off('unhandledRejection', onUnhandledRejection);
  }
  assert.equal(connections, disconnections, 'WebSocket connections remained open after fuzzing');
  assert.equal(asynchronousErrors.length, 0, 'fuzzing caused an asynchronous process error');
  return { seed, completed, connections };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--mode') options.mode = argv[++index];
    else if (name === '--seed') options.seed = Number(argv[++index]);
    else if (name === '--cases') options.generatedCases = Number(argv[++index]);
    else if (name === '--case-index') options.caseIndex = Number(argv[++index]);
    else if (name === '--case-timeout-ms') options.caseTimeout = Number(argv[++index]);
    else if (name === '--depth-limit') options.depthLimit = Number(argv[++index]);
    else if (name === '--replay') options.replay = argv[++index];
    else if (name === '--output') options.outputDirectory = argv[++index];
    else if (name === '--inject') options.injection = argv[++index];
    else throw new Error(`unknown argument: ${name}`);
  }
  return options;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  try {
    const result = await runFuzz(parseArguments(process.argv.slice(2)));
    console.log(`Fuzzing passed: seed=${result.seed} cases=${result.completed}`);
  } catch (error) {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  }
}
