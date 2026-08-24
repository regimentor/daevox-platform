import { createHash, randomUUID } from 'node:crypto';
import { WebSocketProtocolError } from './errors.js';
import {
  decodeWebSocketMessage,
  encodeWebSocketError,
  encodeWebSocketMessage,
} from './webSocketProtocol.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function serialize(data) {
  return { opcode: 1, payload: Buffer.from(data) };
}

function frame(opcode, payload = Buffer.alloc(0)) {
  const length = payload.byteLength;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length <= 65_535) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

class WebSocketConnection {
  #buffer = Buffer.alloc(0);
  #closed = false;
  #fragmentedChunks = [];
  #fragmentedLength = 0;
  #fragmentedOpcode;
  #maxPayload;
  #onClose;
  #onMessage;
  #onProtocolError;
  #socket;

  constructor(socket, { maxPayload, onClose, onMessage, onProtocolError }) {
    this.#socket = socket;
    this.#maxPayload = maxPayload;
    this.#onClose = onClose;
    this.#onMessage = onMessage;
    this.#onProtocolError = onProtocolError;
    socket.on('data', (chunk) => this.#read(chunk));
    socket.on('error', () => this.#finish(1006, ''));
    socket.on('end', () => {
      this.#finish(1006, '');
      socket.destroy();
    });
    socket.on('close', () => this.#finish(1006, ''));
  }

  start(head) {
    if (head.byteLength > 0) this.#read(head);
  }

  send(data) {
    if (this.#closed || !this.#socket.writable) return false;
    const message = serialize(data);
    this.#socket.write(frame(message.opcode, message.payload));
    return true;
  }

  close(code = 1000, reason = '') {
    if (this.#closed) return;
    const reasonBytes = Buffer.from(reason);
    const payload = Buffer.alloc(2 + Math.min(reasonBytes.byteLength, 123));
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2, 0, payload.byteLength - 2);
    this.#socket.end(frame(8, payload));
    this.#finish(code, reason);
  }

  #fail(code, reason) {
    this.#onProtocolError(code, reason);
    this.close(code, reason);
    this.#socket.destroySoon();
  }

  #read(chunk) {
    if (this.#closed) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.byteLength >= 2) {
      const first = this.#buffer[0];
      const second = this.#buffer[1];
      const final = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      const control = opcode >= 8;
      if (
        (first & 0x70) !== 0 ||
        !masked ||
        ![0, 1, 2, 8, 9, 10].includes(opcode) ||
        (control && !final) ||
        (opcode === 0 && this.#fragmentedOpcode === undefined) ||
        ((opcode === 1 || opcode === 2) && this.#fragmentedOpcode !== undefined)
      ) {
        this.#fail(1002, 'Protocol error');
        return;
      }
      if (length === 126) {
        if (this.#buffer.byteLength < 4) return;
        length = this.#buffer.readUInt16BE(2);
        if (length < 126) {
          this.#fail(1002, 'Protocol error');
          return;
        }
        offset = 4;
      } else if (length === 127) {
        if (this.#buffer.byteLength < 10) return;
        const largeLength = this.#buffer.readBigUInt64BE(2);
        if (largeLength < 65_536n) {
          this.#fail(1002, 'Protocol error');
          return;
        }
        if (largeLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.#fail(1009, 'Message too large');
          return;
        }
        length = Number(largeLength);
        offset = 10;
      }
      if (control && length > 125) {
        this.#fail(1002, 'Protocol error');
        return;
      }
      const messageLength = opcode === 0 ? this.#fragmentedLength + length : length;
      if (!control && messageLength > this.#maxPayload) {
        this.#fail(1009, 'Message too large');
        return;
      }
      if (this.#buffer.byteLength < offset + 4 + length) return;
      const mask = this.#buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(this.#buffer.subarray(offset, offset + length));
      this.#buffer = this.#buffer.subarray(offset + length);
      for (let index = 0; index < payload.byteLength; index += 1) {
        payload[index] ^= mask[index % 4];
      }
      if (opcode === 8) {
        if (payload.byteLength === 1) {
          this.#fail(1002, 'Protocol error');
          return;
        }
        const code = payload.byteLength === 0 ? 1000 : payload.readUInt16BE(0);
        if (payload.byteLength > 0 && !this.#isValidCloseCode(code)) {
          this.#fail(1002, 'Protocol error');
          return;
        }
        let reason;
        try {
          reason = UTF8_DECODER.decode(payload.subarray(2));
        } catch {
          this.#fail(1007, 'Invalid message');
          return;
        }
        if (!this.#closed) this.#socket.end(frame(8, payload));
        this.#finish(code, reason);
        return;
      }
      if (opcode === 9) {
        this.#socket.write(frame(10, payload));
      } else if (opcode === 1 || opcode === 2) {
        if (final) this.#deliverMessage(opcode, payload);
        else {
          this.#fragmentedOpcode = opcode;
          this.#fragmentedChunks = [payload];
          this.#fragmentedLength = payload.byteLength;
        }
      } else if (opcode === 0) {
        this.#fragmentedChunks.push(payload);
        this.#fragmentedLength += payload.byteLength;
        if (final) {
          const messageOpcode = this.#fragmentedOpcode;
          const messagePayload = Buffer.concat(this.#fragmentedChunks, this.#fragmentedLength);
          this.#fragmentedOpcode = undefined;
          this.#fragmentedChunks = [];
          this.#fragmentedLength = 0;
          this.#deliverMessage(messageOpcode, messagePayload);
        }
      }
    }
  }

  #deliverMessage(opcode, payload) {
    if (opcode === 2) {
      this.#onMessage(payload);
      return;
    }
    try {
      this.#onMessage(UTF8_DECODER.decode(payload));
    } catch {
      this.#fail(1007, 'Invalid message');
    }
  }

  #isValidCloseCode(code) {
    return (
      (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
      (code >= 3000 && code <= 4999)
    );
  }

  #finish(code, reason) {
    if (this.#closed) return;
    this.#closed = true;
    this.#onClose(code, reason);
  }
}

export class WebSocketTransport {
  #controllers;
  #disconnectPromises = new Set();
  #jobRunner;
  #onError;
  #options;
  #sessionStore;

  constructor({ controllers, jobRunner, onError, options, sessionStore }) {
    this.#controllers = controllers;
    this.#jobRunner = jobRunner;
    this.#onError = onError;
    this.#options = options;
    this.#sessionStore = sessionStore;
  }

  attach(server) {
    server.on('upgrade', (request, socket, head) => {
      this.#upgrade(request, socket, head).catch((error) => {
        this.#report(error, undefined);
        if (socket.writable) socket.end('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      });
    });
  }

  async #upgrade(request, socket, head) {
    let url;
    try {
      url = new URL(request.url, 'http://localhost');
    } catch {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    if (url.pathname !== this.#options.path) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    const key = request.headers['sec-websocket-key'];
    if (
      request.method !== 'GET' ||
      request.headers.upgrade?.toLowerCase() !== 'websocket' ||
      !request.headers.connection
        ?.toLowerCase()
        .split(/\s*,\s*/)
        .includes('upgrade') ||
      request.headers['sec-websocket-version'] !== '13' ||
      !request.headers['sec-websocket-protocol']?.split(/\s*,\s*/).includes('daevox.v1') ||
      typeof key !== 'string'
    ) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }

    const abortController = new AbortController();
    const clientId = randomUUID();
    const sessionId = randomUUID();
    const connectContext = Object.freeze({
      clientId,
      path: url.pathname,
      query: new URLSearchParams(url.searchParams),
      headers: new Headers(request.headers),
      sessionId,
      signal: abortController.signal,
    });
    try {
      await this.#options.onConnect?.(connectContext);
    } catch (error) {
      this.#report(error, connectContext);
      socket.end('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      return;
    }

    const accept = createHash('sha1')
      .update(key + GUID)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: daevox.v1\r\n\r\n`,
    );
    let messageChain = Promise.resolve();
    const connection = new WebSocketConnection(socket, {
      maxPayload: this.#options.maxPayload,
      onProtocolError: () => {
        const error = new WebSocketProtocolError('INVALID_MESSAGE', { fatal: true });
        this.#report(error, Object.freeze({ clientId, sessionId, signal: abortController.signal }));
      },
      onMessage: (data) => {
        if (Buffer.isBuffer(data)) {
          const error = new WebSocketProtocolError('INVALID_MESSAGE', { fatal: true });
          this.#report(
            error,
            Object.freeze({ clientId, sessionId, signal: abortController.signal }),
          );
          connection.close(1003, 'Binary messages are not supported');
          return;
        }
        messageChain = messageChain
          .then(async () => {
            const message = decodeWebSocketMessage(data);
            const route = this.#controllers.resolve(message.controller, message.event);
            if (!route) {
              const error = new WebSocketProtocolError('UNKNOWN_CONTROLLER', {
                controller: message.controller,
                event: message.event,
              });
              this.#report(
                error,
                Object.freeze({
                  clientId,
                  sessionId,
                  controller: message.controller,
                  event: message.event,
                  signal: abortController.signal,
                }),
              );
              connection.send(
                encodeWebSocketError(
                  message.controller,
                  message.event,
                  error.code,
                  this.#options.maxPayload,
                ),
              );
              return;
            }
            if (!route.handler) {
              const error = new WebSocketProtocolError('UNKNOWN_EVENT', {
                controller: message.controller,
                event: message.event,
              });
              this.#report(
                error,
                Object.freeze({
                  clientId,
                  sessionId,
                  controller: message.controller,
                  event: message.event,
                  signal: abortController.signal,
                }),
              );
              connection.send(
                encodeWebSocketError(
                  message.controller,
                  message.event,
                  error.code,
                  this.#options.maxPayload,
                ),
              );
              return;
            }
            const handlerContext = Object.freeze({
              body: message.body,
              clientId,
              sessionId,
              signal: abortController.signal,
            });
            let result;
            try {
              const controller = new route.controller({ jobRunner: this.#jobRunner });
              result = await controller[route.handler](handlerContext);
            } catch (error) {
              this.#report(
                error,
                Object.freeze({
                  clientId,
                  sessionId,
                  controller: message.controller,
                  event: message.event,
                  signal: abortController.signal,
                }),
              );
              connection.send(
                encodeWebSocketError(
                  message.controller,
                  message.event,
                  'HANDLER_ERROR',
                  this.#options.maxPayload,
                ),
              );
              return;
            }
            if (result !== undefined) {
              connection.send(
                encodeWebSocketMessage(
                  message.controller,
                  message.event,
                  result,
                  this.#options.maxPayload,
                ),
              );
            }
          })
          .catch((error) =>
            this.#handleMessageError(error, connection, {
              clientId,
              sessionId,
              signal: abortController.signal,
            }),
          );
      },
      onClose: (code, reason) => {
        abortController.abort();
        this.#sessionStore.remove(sessionId);
        const disconnectPromise = Promise.resolve()
          .then(() =>
            this.#options.onDisconnect?.(Object.freeze({ ...connectContext, code, reason })),
          )
          .catch((error) => this.#report(error, connectContext))
          .finally(() => this.#disconnectPromises.delete(disconnectPromise));
        this.#disconnectPromises.add(disconnectPromise);
      },
    });
    this.#sessionStore.add(clientId, connection, sessionId);
    connection.start(head);
  }

  async waitForDisconnects() {
    await Promise.all(this.#disconnectPromises);
  }

  #report(error, ctx) {
    if (!this.#onError) return;
    try {
      Promise.resolve(this.#onError(error, ctx)).catch(console.error);
    } catch (reportingError) {
      console.error(reportingError);
    }
  }

  #handleMessageError(error, connection, sessionContext) {
    const ctx = Object.freeze({
      ...sessionContext,
      ...(error.controller === undefined ? {} : { controller: error.controller }),
      ...(error.event === undefined ? {} : { event: error.event }),
    });
    this.#report(error, ctx);
    if (!(error instanceof WebSocketProtocolError)) return;
    if (error.fatal) {
      connection.close(1007, 'Invalid message');
      return;
    }
    try {
      connection.send(
        encodeWebSocketError(error.controller, error.event, error.code, this.#options.maxPayload),
      );
    } catch {
      connection.close(1011, 'Internal error');
    }
  }
}
