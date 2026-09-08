import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TdlibClient, type TdlibTransport } from '../src/index.ts';
import type { TransportClientHandlers } from '../src/transport.ts';
import { TdlibError, TdlibUpdateQueueFullError } from '../src/index.ts';

class MockTransport implements TdlibTransport {
  private handlers = new Map<string, TransportClientHandlers>();
  clientId = '';
  manualClose = false;
  readonly requests: Array<{ clientId: string; requestId: string; request: object }> = [];
  closeResponse: (() => void) | undefined;

  async start(
    clientId: string,
    _libraryPath: string,
    _receiveTimeoutMs: number,
    handlers: TransportClientHandlers,
  ): Promise<void> {
    this.clientId = clientId;
    this.handlers.set(clientId, handlers);
  }

  send(clientId: string, requestId: string, request: object): void {
    this.requests.push({ clientId, requestId, request });
    if ((request as { '@type': string })['@type'] === 'testCallString') {
      this.respond(clientId, requestId, {
        '@type': 'testString',
        value: (request as { x: string }).x,
      });
    }
    if ((request as { '@type': string })['@type'] === 'close') {
      this.closeResponse = () => this.respond(clientId, requestId, { '@type': 'ok' });
      if (!this.manualClose) this.closeResponse();
    }
  }

  async destroy(clientId: string): Promise<void> {
    this.handlers.delete(clientId);
  }

  respond(clientId: string, requestId: string, payload: unknown): void {
    this.handlers.get(clientId)?.onMessage({ kind: 'response', clientId, requestId, payload });
  }

  update(clientId: string, payload: unknown): void {
    this.handlers.get(clientId)?.onMessage({ kind: 'update', clientId, payload });
  }
}

const waitForTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('correlates typed requests and preserves TDLib errors', async () => {
  const transport = new MockTransport();
  const client = new TdlibClient({ transport });
  await client.start();

  const result = await client.invoke({ '@type': 'testCallString', x: 'hello' });
  assert.equal(result.value, 'hello');

  const failed = client.invoke({ '@type': 'getAuthorizationState' }, { timeout: 10 });
  const failedRequest = transport.requests.at(-1)!;
  transport.respond(failedRequest.clientId, failedRequest.requestId, {
    '@type': 'error',
    code: 401,
    message: 'bad key',
  });
  await assert.rejects(
    failed,
    (error: unknown) =>
      error instanceof TdlibError && error.code === 401 && error.message === 'bad key',
  );
  await client.close();
});

test('abort cancels only the caller wait', async () => {
  const transport = new MockTransport();
  const client = new TdlibClient({ transport });
  await client.start();
  const controller = new AbortController();
  const pending = client.invoke(
    { '@type': 'getAuthorizationState' },
    { signal: controller.signal },
  );
  const request = transport.requests.at(-1)!;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  transport.respond(request.clientId, request.requestId, { '@type': 'authorizationStateReady' });
  await client.close();
});

test('subscriptions are ordered, isolated, and report handler failures', async () => {
  const transport = new MockTransport();
  const client = new TdlibClient({ transport });
  await client.start();
  const received: string[] = [];
  const errors: unknown[] = [];
  client.onError((error) => {
    errors.push(error);
  });
  client.onUpdate(async (update) => {
    received.push(update['@type']);
    await waitForTurn();
    if (received.length === 2) throw new Error('handler failed');
  });
  transport.update(transport.clientId, { '@type': 'updateOption', name: 'one', value: '1' });
  transport.update(transport.clientId, { '@type': 'updateOption', name: 'two', value: '2' });
  await waitForTurn();
  await waitForTurn();
  assert.deepEqual(received, ['updateOption', 'updateOption']);
  assert.ok(
    errors.some(
      (error) => typeof error === 'object' && error !== null && 'subscriptionId' in error,
    ),
  );
  await client.close();
});

test('queue overflow disables only the overflowing subscription', async () => {
  const transport = new MockTransport();
  const client = new TdlibClient({ transport });
  await client.start();
  const errors: unknown[] = [];
  client.onError((error) => {
    errors.push(error);
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let count = 0;
  client.onUpdate(
    async () => {
      count++;
      await blocked;
    },
    { maxQueueSize: 1 },
  );
  transport.update(transport.clientId, { '@type': 'updateOption', name: 'one', value: '1' });
  transport.update(transport.clientId, { '@type': 'updateOption', name: 'two', value: '2' });
  transport.update(transport.clientId, { '@type': 'updateOption', name: 'three', value: '3' });
  assert.equal(count, 1);
  assert.ok(
    errors.some(
      (error) =>
        typeof error === 'object' &&
        error !== null &&
        'error' in error &&
        error.error instanceof TdlibUpdateQueueFullError,
    ),
  );
  release();
  await waitForTurn();
  await client.close();
});

test('readiness and close waiting can be cancelled independently', async () => {
  const transport = new MockTransport();
  const client = new TdlibClient({ transport });
  await client.start();
  transport.manualClose = true;
  const readiness = client.waitUntilReady({ timeout: 100 });
  transport.update(transport.clientId, {
    '@type': 'updateAuthorizationState',
    authorization_state: { '@type': 'authorizationStateReady' },
  });
  await readiness;
  const controller = new AbortController();
  const closing = client.close({ signal: controller.signal });
  controller.abort();
  await assert.rejects(closing, { name: 'AbortError' });
  transport.closeResponse!();
  await client.close();
});
