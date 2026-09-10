/* oxlint-disable unicorn/require-post-message-target-origin -- MessagePort.postMessage has no targetOrigin. */
import { dlopen, toString, types } from 'node:ffi';
import { parentPort } from 'node:worker_threads';

interface NativeClient {
  readonly handle: bigint;
}

interface NativeApi {
  readonly library: { close: () => void };
  readonly create: () => bigint | null;
  readonly send: (
    handle: bigint | string | ArrayBuffer | NodeJS.ArrayBufferView | null,
    request: string,
  ) => void;
  readonly receive: (
    handle: bigint | string | ArrayBuffer | NodeJS.ArrayBufferView | null,
    timeout: number,
  ) => bigint | null;
  readonly destroy: (handle: bigint | string | ArrayBuffer | NodeJS.ArrayBufferView | null) => void;
}

interface WorkerClient {
  readonly clientId: string;
  readonly native: NativeClient;
}

const clients = new Map<string, WorkerClient>();
let native: NativeApi | undefined;
let nativePath: string | undefined;
let pumping = false;
let receiveTimeoutMs = 25;

function getNative(path: string): NativeApi {
  if (native) {
    if (nativePath !== path)
      throw new Error(
        `TDLib worker already loaded ${nativePath}; all clients must use the same library`,
      );
    return native;
  }
  const loaded = dlopen(path, {
    td_json_client_create: { arguments: [], return: types.POINTER },
    td_json_client_send: { arguments: [types.POINTER, types.STRING], return: types.VOID },
    td_json_client_receive: { arguments: [types.POINTER, types.DOUBLE], return: types.POINTER },
    td_json_client_destroy: { arguments: [types.POINTER], return: types.VOID },
  });
  native = {
    library: loaded.lib,
    create: loaded.functions.td_json_client_create,
    send: loaded.functions.td_json_client_send,
    receive: loaded.functions.td_json_client_receive,
    destroy: loaded.functions.td_json_client_destroy,
  };
  nativePath = path;
  return native;
}

function fail(clientId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  parentPort?.postMessage({ kind: 'fatal', clientId, error: { message } });
  const client = clients.get(clientId);
  if (client) {
    clients.delete(clientId);
    try {
      native?.destroy(client.native.handle);
    } catch {
      /* The handle may already be invalid after a native failure. */
    }
  }
}

function pump(): void {
  if (pumping) return;
  pumping = true;
  try {
    for (const client of clients.values()) {
      try {
        const pointer = native!.receive(client.native.handle, receiveTimeoutMs / 1000);
        const response = pointer === null ? null : toString(pointer);
        if (response === null) continue;
        const payload = JSON.parse(response) as { '@extra'?: string; '@type'?: string };
        const requestId = payload['@extra'];
        if (requestId) {
          delete payload['@extra'];
          parentPort?.postMessage({
            kind: 'response',
            clientId: client.clientId,
            requestId,
            payload,
          });
        } else {
          parentPort?.postMessage({ kind: 'update', clientId: client.clientId, payload });
        }
      } catch (error) {
        fail(client.clientId, error);
      }
    }
  } finally {
    pumping = false;
    if (clients.size) setImmediate(pump);
  }
}

parentPort?.on(
  'message',
  (message: {
    kind: string;
    clientId: string;
    libraryPath?: string;
    receiveTimeoutMs?: number;
    requestId?: string;
    request?: object;
  }) => {
    try {
      if (message.kind === 'init') {
        receiveTimeoutMs = Math.max(1, message.receiveTimeoutMs ?? receiveTimeoutMs);
        const api = getNative(message.libraryPath!);
        const handle = api.create();
        if (handle === null || handle === 0n)
          throw new Error('td_json_client_create returned a null pointer');
        clients.set(message.clientId, { clientId: message.clientId, native: { handle } });
        parentPort?.postMessage({ kind: 'ready', clientId: message.clientId });
        setImmediate(pump);
      } else if (message.kind === 'send') {
        const client = clients.get(message.clientId);
        if (!client) throw new Error(`Unknown TDLib client ${message.clientId}`);
        const request = { ...(message.request as object), '@extra': message.requestId };
        native!.send(client.native.handle, JSON.stringify(request));
      } else if (message.kind === 'destroy') {
        const client = clients.get(message.clientId);
        if (client) {
          native!.destroy(client.native.handle);
          clients.delete(message.clientId);
        }
        parentPort?.postMessage({ kind: 'destroyed', clientId: message.clientId });
        if (!clients.size && native) {
          native.library.close();
          native = undefined;
          nativePath = undefined;
        }
      }
    } catch (error) {
      fail(message.clientId, error);
    }
  },
);
