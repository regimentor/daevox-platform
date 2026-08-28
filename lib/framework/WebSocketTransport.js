import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import { HttpError, WebSocketEventError, WebSocketProtocolError } from './errors.js';
import { composeMiddleware } from './middleware.js';
import {
  decodeWebSocketMessage,
  encodeWebSocketError,
  encodeWebSocketMessage,
} from './webSocketProtocol.js';

/**

 * RFC 6455 handshake GUID. / GUID handshake из RFC 6455.

 *

 * @type {string}

 * @private

 */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/**
 * Strict UTF-8 decoder for text frames and close reasons. / Строгий декодер UTF-8 для text frames и причин закрытия.
 *
 * @type {TextDecoder}
 * @private
 */
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

/**

 * Serializes application text into an outbound message descriptor. / Сериализует прикладной текст в описание исходящего сообщения.

 *

 * @param {string} data Text data. / Текстовые данные.

 * @returns {WebSocketOutboundMessage} Message descriptor. / Описание сообщения.

 * @private

 */
function serialize(data) {
  return { opcode: 1, payload: Buffer.from(data) };
}

/**

 * Builds one unmasked server-to-client WebSocket frame. / Формирует один немаскированный WebSocket frame от сервера клиенту.

 *

 * @param {number} opcode Frame opcode. / Opcode frame.

 * @param {Buffer} [payload] Frame payload. / Payload frame.

 * @returns {Buffer} Encoded frame. / Кодированный frame.

 * @private

 */
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

/**

 * Parses frames and owns one upgraded WebSocket connection. / Разбирает frames и владеет одним upgraded WebSocket-соединением.

 *

 * @private

 */
class WebSocketConnection {
  /**
   * @type {Buffer} Unparsed inbound bytes. / Неразобранные входящие байты.
   * @private
   */
  #buffer = Buffer.alloc(0);
  /**
   * @type {boolean} Whether the connection finished. / Завершено ли соединение.
   * @private
   */
  #closed = false;
  /**
   * @type {Buffer[]} Fragments of the current message. / Фрагменты текущего сообщения.
   * @private
   */
  #fragmentedChunks = [];
  /**
   * @type {number} Accumulated fragmented message bytes. / Накопленный размер фрагментов.
   * @private
   */
  #fragmentedLength = 0;
  /**
   * @type {number} Opcode of the fragmented message. / Opcode фрагментированного сообщения.
   * @private
   */
  #fragmentedOpcode;
  /**
   * @type {number} Maximum inbound message bytes. / Максимальный размер входящего сообщения.
   * @private
   */
  #maxPayload;
  /**
   * @type {WebSocketCloseListener} Close listener. / Обработчик закрытия.
   * @private
   */
  #onClose;
  /**
   * @type {WebSocketMessageListener} Message listener. / Обработчик сообщения.
   * @private
   */
  #onMessage;
  /**
   * @type {WebSocketProtocolFailureListener} Frame-protocol listener. / Обработчик ошибки frame-протокола.
   * @private
   */
  #onProtocolError;
  /** @type {(error: Error) => void} Socket error listener. / Обработчик ошибки socket. */
  #onSocketError;
  /**
   * @type {Socket} Upgraded TCP socket. / Upgraded TCP-сокет.
   * @private
   */
  #socket;

  /**

   * Creates a connection parser around an upgraded socket. / Создаёт парсер соединения вокруг upgraded-сокета.

   *

   * @param {Socket} socket Upgraded socket. / Upgraded-сокет.

   * @param {WebSocketConnectionOptions} options Parser callbacks and limit. / Callbacks и ограничение парсера.

   * @private

   */
  constructor(socket, { maxPayload, onClose, onMessage, onProtocolError, onSocketError }) {
    this.#socket = socket;
    this.#maxPayload = maxPayload;
    this.#onClose = onClose;
    this.#onMessage = onMessage;
    this.#onProtocolError = onProtocolError;
    this.#onSocketError = onSocketError;
    socket.on('data', (chunk) => this.#read(chunk));
    socket.on('error', (error) => {
      this.#onSocketError?.(error);
      this.#finish(1006, '');
    });
    socket.on('end', () => {
      this.#finish(1006, '');
      socket.destroy();
    });
    socket.on('close', () => this.#finish(1006, ''));
  }

  /**

   * Feeds bytes already read after the HTTP upgrade request. / Передаёт байты, уже прочитанные после HTTP upgrade-запроса.

   *

   * @param {Buffer} head Buffered bytes. / Буферизованные байты.

   * @returns {void}

   * @private

   */
  start(head) {
    if (head.byteLength > 0) this.#read(head);
  }

  /**

   * Sends one protocol text message. / Отправляет одно текстовое сообщение протокола.

   *

   * @param {string} data Encoded message. / Кодированное сообщение.

   * @returns {boolean} Whether the frame was accepted for writing. / Был ли frame принят для записи.

   * @private

   */
  send(data) {
    if (this.#closed || !this.#socket.writable) return false;
    const message = serialize(data);
    this.#socket.write(frame(message.opcode, message.payload));
    return true;
  }

  /**

   * Starts a WebSocket closing handshake and finishes local state. / Начинает WebSocket closing handshake и завершает локальное состояние.

   *

   * @param {number} [code=1000] Close code. / Код закрытия.

   * @param {string} [reason=''] Close reason. / Причина закрытия.

   * @returns {void}

   * @private

   */
  close(code = 1000, reason = '') {
    if (this.#closed) return;
    const reasonBytes = Buffer.from(reason);
    const payload = Buffer.alloc(2 + Math.min(reasonBytes.byteLength, 123));
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2, 0, payload.byteLength - 2);
    this.#socket.end(frame(8, payload));
    this.#finish(code, reason);
  }

  /**

   * Reports a frame-protocol failure and destroys the socket after close. / Сообщает об ошибке frame-протокола и уничтожает сокет после закрытия.

   *

   * @param {number} code Close code. / Код закрытия.

   * @param {string} reason Close reason. / Причина закрытия.

   * @private

   */
  #fail(code, reason) {
    this.#onProtocolError(code, reason);
    this.close(code, reason);
    this.#socket.destroySoon();
  }

  /**

   * Incrementally parses masked client frames. / Инкрементально разбирает маскированные клиентские frames.

   *

   * @param {Buffer} chunk Inbound bytes. / Входящие байты.

   * @private

   */
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

  /**

   * Decodes and delivers one complete data message. / Декодирует и передаёт одно полное data-сообщение.

   *

   * @param {number} opcode Message opcode. / Opcode сообщения.

   * @param {Buffer} payload Message bytes. / Байты сообщения.

   * @private

   */
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

  /**

   * Checks a close code accepted from a peer. / Проверяет код закрытия от другой стороны.

   *

   * @param {number} code Close code. / Код закрытия.

   * @returns {boolean} Validation result. / Результат проверки.

   * @private

   */
  #isValidCloseCode(code) {
    return (
      (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
      (code >= 3000 && code <= 4999)
    );
  }

  /**

   * Completes local connection state exactly once. / Однократно завершает локальное состояние соединения.

   *

   * @param {number} code Close code. / Код закрытия.

   * @param {string} reason Close reason. / Причина закрытия.

   * @private

   */
  #finish(code, reason) {
    if (this.#closed) return;
    this.#closed = true;
    this.#onClose(code, reason);
  }
}

/**

 * Owns WebSocket upgrades, `daevox.v1` dispatch, and lifecycle hooks. / Владеет WebSocket upgrade, диспетчеризацией `daevox.v1` и lifecycle hooks.

 *

 * @private

 */
export class WebSocketTransport {
  /**
   * @type {WebSocketControllerRegistry} Controller catalog. / Каталог контроллеров.
   * @private
   */
  #controllers;
  /**
   * @type {Set<Promise<void>>} Pending disconnect hooks. / Незавершённые hooks отключения.
   * @private
   */
  #disconnectPromises = new Set();
  /**
   * @type {JobRunner} Controller job runner. / Исполнитель задач контроллеров.
   * @private
   */
  #jobRunner;
  /**
   * @type {WebSocketErrorHandler} Error observer. / Наблюдатель ошибок.
   * @private
   */
  #onError;
  /**
   * @type {NormalizedWebSocketOptions} Transport options. / Параметры транспорта.
   * @private
   */
  #options;
  /**
   * @type {WebSocketSessionStore} Active sessions. / Активные сессии.
   * @private
   */
  #sessionStore;

  /**

   * Creates the application-owned WebSocket transport. / Создаёт принадлежащий приложению WebSocket-транспорт.

   *

   * @param {WebSocketTransportDependencies} dependencies Owned dependencies. / Принадлежащие зависимости.

   * @private

   */
  constructor({ controllers, jobRunner, onError, options, sessionStore }) {
    this.#controllers = controllers;
    this.#jobRunner = jobRunner;
    this.#onError = onError;
    this.#options = options;
    this.#sessionStore = sessionStore;
  }

  /**

   * Attaches WebSocket upgrade handling to the shared HTTP server. / Подключает обработку WebSocket upgrade к общему HTTP-серверу.

   *

   * @param {Server} server Shared server. / Общий сервер.

   * @returns {void}

   * @private

   */
  attach(server) {
    server.on('upgrade', (request, socket, head) => {
      this.#upgrade(request, socket, head).catch((error) => {
        this.#report(error, undefined);
        if (socket.writable) socket.end('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      });
    });
  }

  /**

   * Validates and upgrades one handshake, then dispatches its messages serially. / Проверяет и выполняет upgrade одного handshake, затем последовательно обрабатывает сообщения.

   *

   * @param {IncomingMessage} request Upgrade request. / Upgrade-запрос.

   * @param {Socket} socket TCP socket. / TCP-сокет.

   * @param {Buffer} head Buffered bytes. / Буферизованные байты.

   * @returns {Promise<void>} Upgrade completion. / Завершение upgrade.

   * @private

   */
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
    const generatedClientId = randomUUID();
    let clientId;
    const sessionId = randomUUID();
    const state = Object.create(null);
    const connectContext = Object.freeze({
      clientId: generatedClientId,
      path: url.pathname,
      query: new URLSearchParams(url.searchParams),
      headers: new Headers(request.headers),
      sessionId,
      signal: abortController.signal,
      state,
    });
    try {
      const result = await this.#options.onConnect?.(connectContext);
      if (result !== undefined && (typeof result !== 'string' || result.length === 0)) {
        throw new TypeError('onConnect must return undefined or a non-empty string');
      }
      clientId = result ?? generatedClientId;
    } catch (error) {
      if (error instanceof HttpError) {
        this.#rejectHandshake(socket, error);
        return;
      }
      this.#report(error, connectContext);
      socket.end('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      return;
    }
    const finalConnectContext = Object.freeze({ ...connectContext, clientId });

    const accept = createHash('sha1')
      .update(key + GUID)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: daevox.v1\r\n\r\n`,
    );
    let messageChain = Promise.resolve();
    const connection = new WebSocketConnection(socket, {
      maxPayload: this.#options.maxPayload,
      onSocketError: (error) =>
        this.#report(
          error,
          Object.freeze({ clientId, sessionId, signal: abortController.signal, state }),
        ),
      onProtocolError: () => {
        const error = new WebSocketProtocolError('INVALID_MESSAGE', { fatal: true });
        this.#report(
          error,
          Object.freeze({ clientId, sessionId, signal: abortController.signal, state }),
        );
      },
      onMessage: (data) => {
        if (Buffer.isBuffer(data)) {
          const error = new WebSocketProtocolError('INVALID_MESSAGE', { fatal: true });
          this.#report(
            error,
            Object.freeze({ clientId, sessionId, signal: abortController.signal, state }),
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
                  state,
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
                  state,
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
              controller: message.controller,
              event: message.event,
              sessionId,
              signal: abortController.signal,
              state,
            });
            let result;
            try {
              const execute = composeMiddleware(
                [
                  ...this.#options.middleware,
                  ...route.controllerMiddleware,
                  ...route.eventMiddleware,
                ],
                () => {
                  const controller = new route.controller({ jobRunner: this.#jobRunner });
                  return controller[route.handler](handlerContext);
                },
              );
              result = await execute(handlerContext);
            } catch (error) {
              if (error instanceof WebSocketEventError) {
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
              this.#report(
                error,
                Object.freeze({
                  clientId,
                  sessionId,
                  controller: message.controller,
                  event: message.event,
                  signal: abortController.signal,
                  state,
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
              state,
            }),
          );
      },
      onClose: (code, reason) => {
        abortController.abort();
        this.#sessionStore.remove(sessionId);
        const disconnectPromise = Promise.resolve()
          .then(() =>
            this.#options.onDisconnect?.(Object.freeze({ ...finalConnectContext, code, reason })),
          )
          .catch((error) => this.#report(error, finalConnectContext))
          .finally(() => this.#disconnectPromises.delete(disconnectPromise));
        this.#disconnectPromises.add(disconnectPromise);
      },
    });
    this.#sessionStore.add(clientId, connection, sessionId);
    connection.start(head);
  }

  /**

   * Waits for all currently pending disconnect hooks. / Ожидает все текущие hooks отключения.

   *

   * @returns {Promise<void>} Hook completion. / Завершение hooks.

   * @private

   */
  async waitForDisconnects() {
    await Promise.all(this.#disconnectPromises);
  }

  /**

   * Reports an error without letting observer failures affect transport. / Сообщает об ошибке, не позволяя сбою наблюдателя повлиять на транспорт.

   *

   * @param {*} error Reported error. / Ошибка.

   * @param {Object} [ctx] Available context. / Доступный контекст.

   * @private

   */
  #report(error, ctx) {
    if (!this.#onError) return;
    try {
      Promise.resolve(this.#onError(error, ctx)).catch(console.error);
    } catch (reportingError) {
      console.error(reportingError);
    }
  }

  /**
   * Rejects a WebSocket handshake with an expected HTTP response.
   * Отклоняет WebSocket handshake ожидаемым HTTP-ответом.
   *
   * @param {Socket} socket Handshake socket. / Socket handshake.
   * @param {HttpError} error Expected HTTP failure. / Ожидаемая HTTP-ошибка.
   * @returns {void}
   * @private
   */
  #rejectHandshake(socket, error) {
    const headers = Object.fromEntries(error.headers ?? []);
    let body;
    if (error.body === undefined) body = Buffer.alloc(0);
    else if (typeof error.body === 'string') {
      body = Buffer.from(error.body);
      headers['content-type'] ??= 'text/plain; charset=utf-8';
    } else if (Buffer.isBuffer(error.body) || error.body instanceof Uint8Array) {
      body = Buffer.from(error.body);
      headers['content-type'] ??= 'application/octet-stream';
    } else {
      body = Buffer.from(JSON.stringify(error.body));
      headers['content-type'] ??= 'application/json; charset=utf-8';
    }
    headers['content-length'] = String(body.byteLength);
    const lines = [`HTTP/1.1 ${error.status} ${http.STATUS_CODES[error.status] ?? 'Error'}`];
    for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
    socket.end(Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`), body]));
  }

  /**

   * Converts a queued message failure into a protocol response or close. / Преобразует ошибку очереди сообщений в ответ протокола или закрытие.

   *

   * @param {*} error Processing error. / Ошибка обработки.

   * @param {WebSocketConnection} connection Active connection. / Активное соединение.

   * @param {WebSocketSessionContext} sessionContext Session identifiers and signal. / Идентификаторы и сигнал сессии.

   * @private

   */
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

/**
 * Encoded outbound WebSocket message descriptor.
 * Описание кодированного исходящего WebSocket-сообщения.
 *
 * @typedef {Object} WebSocketOutboundMessage
 * @property {number} opcode Frame opcode. / Opcode frame.
 * @property {Buffer} payload Frame payload. / Payload frame.
 * @private
 */

/**
 * Options used by the frame-level connection parser.
 * Параметры парсера соединения на уровне frames.
 *
 * @typedef {Object} WebSocketConnectionOptions
 * @property {number} maxPayload Maximum message bytes. / Максимальный размер сообщения.
 * @property {WebSocketCloseListener} onClose Close listener. / Обработчик закрытия.
 * @property {WebSocketMessageListener} onMessage Message listener. / Обработчик сообщения.
 * @property {WebSocketProtocolFailureListener} onProtocolError Protocol listener. / Обработчик.
 * @property {(error: Error) => void} [onSocketError] Socket error listener. / Обработчик ошибки socket.
 * @private
 */

/**
 * Receives a completed WebSocket close.
 * Получает завершённое закрытие WebSocket.
 *
 * @callback WebSocketCloseListener
 * @param {number} code Close code. / Код закрытия.
 * @param {string} reason Close reason. / Причина закрытия.
 * @returns {void}
 * @private
 */

/**
 * Receives one decoded text string or binary Buffer.
 * Получает одну декодированную строку или бинарный Buffer.
 *
 * @callback WebSocketMessageListener
 * @param {string|Buffer} data Message data. / Данные сообщения.
 * @returns {void}
 * @private
 */

/**
 * Receives a frame-level protocol failure.
 * Получает ошибку протокола на уровне frames.
 *
 * @callback WebSocketProtocolFailureListener
 * @param {number} code Close code. / Код закрытия.
 * @param {string} reason Close reason. / Причина закрытия.
 * @returns {void}
 * @private
 */

/**
 * Dependencies owned by the WebSocket transport.
 * Зависимости, принадлежащие WebSocket-транспорту.
 *
 * @typedef {Object} WebSocketTransportDependencies
 * @property {WebSocketControllerRegistry} controllers Controller catalog. / Каталог.
 * @property {JobRunner} jobRunner Controller job runner. / Исполнитель задач.
 * @property {WebSocketErrorHandler} [onError] Error observer. / Наблюдатель ошибок.
 * @property {NormalizedWebSocketOptions} options Transport options. / Параметры транспорта.
 * @property {WebSocketSessionStore} sessionStore Active sessions. / Активные сессии.
 * @private
 */

/**
 * Minimal context retained while dispatching a WebSocket message.
 * Минимальный контекст при обработке WebSocket-сообщения.
 *
 * @typedef {Object} WebSocketSessionContext
 * @property {string} clientId Client identifier. / Идентификатор клиента.
 * @property {string} sessionId Session identifier. / Идентификатор сессии.
 * @property {AbortSignal} signal Session signal. / Сигнал сессии.
 * @property {Object<string, *>} state Mutable session state. / Изменяемое состояние сессии.
 * @private
 */
