import { createHash, randomUUID } from 'node:crypto';
import { AuthenticationAbortedError, WebSocketProtocolError } from './errors.js';
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
 * Maximum delay supported by Node.js timers. / Максимальная задержка таймеров Node.js.
 *
 * @type {number}
 * @private
 */
const MAX_TIMER_DELAY = 2_147_483_647;

/**
 * Writes and closes a JSON HTTP handshake refusal.
 * Записывает и закрывает JSON-отказ HTTP handshake.
 *
 * @param {Socket} socket Handshake socket. / Socket handshake.
 * @param {number} status HTTP status. / HTTP-статус.
 * @param {string} reason HTTP reason phrase. / Reason phrase HTTP.
 * @param {string} code Public error code. / Публичный код ошибки.
 * @param {string} [challenge] WWW-Authenticate challenge. / Challenge WWW-Authenticate.
 * @returns {void}
 * @private
 */
function rejectHandshake(socket, status, reason, code, challenge) {
  const body = Buffer.from(JSON.stringify({ error: { code } }));
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${body.byteLength}\r\n${challenge ? `WWW-Authenticate: ${challenge}\r\n` : ''}Connection: close\r\n\r\n${body}`,
  );
}

/**
 * Validates an optional exact Origin header against the configured allowlist.
 * Проверяет необязательный точный заголовок Origin по настроенному allowlist.
 *
 * @param {IncomingMessage} request Upgrade request. / Upgrade-запрос.
 * @param {string[]} allowedOrigins Allowed canonical origins. / Разрешённые canonical origins.
 * @returns {{allowed: boolean, origin?: string}} Origin outcome. / Результат проверки Origin.
 * @private
 */
function validateOrigin(request, allowedOrigins) {
  const values =
    request.headersDistinct?.origin ??
    (request.headers.origin === undefined ? undefined : [request.headers.origin]);
  if (values === undefined) return { allowed: true };
  if (!Array.isArray(values) || values.length !== 1) return { allowed: false };
  const origin = values[0];
  if (typeof origin !== 'string' || origin === '' || origin === 'null') {
    return { allowed: false };
  }
  let url;
  try {
    url = new URL(origin);
  } catch {
    return { allowed: false };
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.origin !== origin ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !allowedOrigins.includes(origin)
  ) {
    return { allowed: false };
  }
  return { allowed: true, origin };
}

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
export class WebSocketConnection {
  /**
   * Whether socket backpressure blocks the next frame.
   * Блокирует ли backpressure socket передачу следующего frame.
   *
   * @type {boolean}
   * @private
   */
  #blocked = false;
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
   * Maximum fully serialized bytes waiting in the framework queue.
   * Максимальное число полностью сериализованных байтов в очереди framework.
   *
   * @type {number}
   * @private
   */
  #maxWriteQueueBytes;
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
  /**
   * @type {Socket} Upgraded TCP socket. / Upgraded TCP-сокет.
   * @private
   */
  #socket;
  /**
   * Stable transport listeners removed at the terminal socket event.
   * Стабильные transport listeners, удаляемые при терминальном событии socket.
   *
   * @type {WebSocketSocketListeners}
   * @private
   */
  #socketListeners;
  /**
   * Fully serialized frames waiting for `drain`.
   * Полностью сериализованные frames, ожидающие `drain`.
   *
   * @type {Buffer[]}
   * @private
   */
  #writeQueue = [];
  /**
   * Fully serialized bytes currently waiting in the framework queue.
   * Число полностью сериализованных байтов, ожидающих в очереди framework.
   *
   * @type {number}
   * @private
   */
  #writeQueueBytes = 0;
  /**
   * Resumes the write queue after socket backpressure.
   * Возобновляет write queue после backpressure socket.
   *
   * @type {Function}
   * @private
   */
  #onDrain = () => {
    this.#blocked = false;
    this.#flush();
  };

  /**

   * Creates a connection parser around an upgraded socket. / Создаёт парсер соединения вокруг upgraded-сокета.

   *

   * @param {Socket} socket Upgraded socket. / Upgraded-сокет.

   * @param {WebSocketConnectionOptions} options Parser callbacks and limit. / Callbacks и ограничение парсера.

   * @private

   */
  constructor(socket, { maxPayload, maxWriteQueueBytes, onClose, onMessage, onProtocolError }) {
    this.#socket = socket;
    this.#maxPayload = maxPayload;
    this.#maxWriteQueueBytes = maxWriteQueueBytes;
    this.#onClose = onClose;
    this.#onMessage = onMessage;
    this.#onProtocolError = onProtocolError;
    this.#socketListeners = Object.freeze({
      data: (chunk) => this.#read(chunk),
      error: () => this.#terminate(false),
      end: () => this.#terminate(true),
      close: () => this.#terminate(false),
    });
    for (const [event, listener] of Object.entries(this.#socketListeners)) {
      socket.on(event, listener);
    }
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
    return this.#enqueue(frame(message.opcode, message.payload));
  }

  /**
   * Accepts one fully serialized frame for ordered writing.
   * Принимает один полностью сериализованный frame для упорядоченной записи.
   *
   * @param {Buffer} serializedFrame Fully serialized frame. / Полностью сериализованный frame.
   * @returns {boolean} Whether the frame was accepted. / Был ли frame принят.
   * @private
   */
  #enqueue(serializedFrame) {
    if (this.#closed || !this.#socket.writable) return false;
    if (this.#blocked) {
      if (this.#writeQueueBytes + serializedFrame.byteLength > this.#maxWriteQueueBytes) {
        this.close(1013, 'Write queue overflow');
        return false;
      }
      this.#writeQueue.push(serializedFrame);
      this.#writeQueueBytes += serializedFrame.byteLength;
      return true;
    }
    this.#write(serializedFrame);
    return true;
  }

  /**
   * Writes queued frames until backpressure resumes.
   * Записывает frames из очереди до нового backpressure.
   *
   * @returns {void}
   * @private
   */
  #flush() {
    while (!this.#closed && this.#socket.writable && !this.#blocked) {
      const serializedFrame = this.#writeQueue.shift();
      if (!serializedFrame) return;
      this.#writeQueueBytes -= serializedFrame.byteLength;
      this.#write(serializedFrame);
    }
  }

  /**
   * Hands one frame to the socket and observes backpressure.
   * Передаёт один frame socket и учитывает backpressure.
   *
   * @param {Buffer} serializedFrame Fully serialized frame. / Полностью сериализованный frame.
   * @returns {void}
   * @private
   */
  #write(serializedFrame) {
    if (this.#socket.write(serializedFrame)) return;
    this.#blocked = true;
    this.#socket.once('drain', this.#onDrain);
  }

  /**
   * Finishes state and removes listeners after a terminal socket event.
   * Завершает состояние и удаляет listeners после терминального события socket.
   *
   * @param {boolean} destroy Whether an ended socket must be destroyed. / Нужно ли уничтожить
   * завершившийся socket.
   * @returns {void}
   * @private
   */
  #terminate(destroy) {
    this.#finish(1006, '');
    for (const [event, listener] of Object.entries(this.#socketListeners)) {
      this.#socket.removeListener(event, listener);
    }
    if (destroy) this.#socket.destroy();
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
    this.#finish(code, reason);
    this.#socket.end(frame(8, payload));
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
        if (!this.#closed) {
          this.#finish(code, reason);
          this.#socket.end(frame(8, payload));
        }
        return;
      }
      if (opcode === 9) {
        this.#enqueue(frame(10, payload));
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
    this.#socket.removeListener('drain', this.#onDrain);
    this.#blocked = false;
    this.#writeQueue = [];
    this.#writeQueueBytes = 0;
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
   * Shared Authentication module. / Общий модуль Authentication.
   *
   * @type {Authentication}
   * @private
   */
  #authentication;
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
  constructor({ authentication, controllers, jobRunner, onError, options, sessionStore }) {
    this.#authentication = authentication;
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

    const originResult = validateOrigin(request, this.#options.allowedOrigins);
    if (!originResult.allowed) {
      rejectHandshake(socket, 403, 'Forbidden', 'ORIGIN_NOT_ALLOWED');
      return;
    }

    const abortController = new AbortController();
    const abortHandshake = () => abortController.abort();
    for (const event of ['error', 'end', 'close']) socket.once(event, abortHandshake);
    const finishHandshake = () => {
      for (const event of ['error', 'end', 'close']) {
        socket.removeListener(event, abortHandshake);
      }
    };

    let authSession;
    const scenario = this.#options.authentication;
    if (typeof scenario === 'string') {
      try {
        const result = await this.#authentication.authenticate(scenario, {
          transport: 'websocket',
          method: 'GET',
          path: url.pathname,
          headers: new Headers(request.headers),
          query: new URLSearchParams(url.searchParams),
          ...(originResult.origin ? { origin: originResult.origin } : {}),
          signal: abortController.signal,
        });
        if (result.status === 'rejected') {
          finishHandshake();
          abortController.abort();
          rejectHandshake(socket, 401, 'Unauthorized', result.code, result.challenge);
          return;
        }
        if (result.status === 'authenticated') authSession = result.session;
      } catch (error) {
        finishHandshake();
        if (error instanceof AuthenticationAbortedError) return;
        this.#report(
          error,
          Object.freeze({
            phase: 'handshake',
            path: url.pathname,
            scenario,
            signal: abortController.signal,
          }),
        );
        abortController.abort();
        rejectHandshake(socket, 500, 'Internal Server Error', 'INTERNAL_SERVER_ERROR');
        return;
      }
    }

    const clientId = randomUUID();
    const sessionId = randomUUID();
    const connectContext = Object.freeze({
      clientId,
      path: url.pathname,
      ...(originResult.origin ? { origin: originResult.origin } : {}),
      sessionId,
      signal: abortController.signal,
      ...(authSession ? { authSession } : {}),
    });
    try {
      await this.#options.onConnect?.(connectContext);
    } catch (error) {
      finishHandshake();
      abortController.abort();
      this.#report(
        error,
        Object.freeze({
          phase: 'connect',
          clientId,
          sessionId,
          path: url.pathname,
          signal: abortController.signal,
          ...(authSession ? { authSession } : {}),
        }),
      );
      socket.end('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      return;
    }

    if (abortController.signal.aborted) {
      finishHandshake();
      return;
    }

    if (authSession?.expiresAt <= Date.now()) {
      finishHandshake();
      abortController.abort();
      rejectHandshake(socket, 401, 'Unauthorized', 'AUTHENTICATION_EXPIRED');
      return;
    }

    finishHandshake();

    const accept = createHash('sha1')
      .update(key + GUID)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: daevox.v1\r\n\r\n`,
    );
    let messageChain = Promise.resolve();
    let expiryTimer;
    const sessionContext = Object.freeze({
      phase: 'session',
      clientId,
      sessionId,
      signal: abortController.signal,
      ...(authSession ? { authSession } : {}),
    });
    const connection = new WebSocketConnection(socket, {
      maxPayload: this.#options.maxPayload,
      maxWriteQueueBytes: this.#options.maxWriteQueueBytes,
      onProtocolError: () => {
        const error = new WebSocketProtocolError('INVALID_MESSAGE', { fatal: true });
        this.#report(error, sessionContext);
      },
      onMessage: (data) => {
        if (Buffer.isBuffer(data)) {
          const error = new WebSocketProtocolError('INVALID_MESSAGE', { fatal: true });
          this.#report(error, sessionContext);
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
                  ...sessionContext,
                  controller: message.controller,
                  event: message.event,
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
                  ...sessionContext,
                  controller: message.controller,
                  event: message.event,
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
                  ...sessionContext,
                  controller: message.controller,
                  event: message.event,
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
              ...sessionContext,
            }),
          );
      },
      onClose: (code, reason) => {
        clearTimeout(expiryTimer);
        abortController.abort();
        this.#sessionStore.remove(sessionId);
        const disconnectContext = Object.freeze({
          clientId,
          sessionId,
          code,
          reason,
          signal: abortController.signal,
          ...(authSession ? { authSession } : {}),
        });
        const disconnectPromise = Promise.resolve()
          .then(() => this.#options.onDisconnect?.(disconnectContext))
          .catch((error) =>
            this.#report(
              error,
              Object.freeze({
                phase: 'disconnect',
                clientId,
                sessionId,
                signal: abortController.signal,
                ...(authSession ? { authSession } : {}),
              }),
            ),
          )
          .finally(() => this.#disconnectPromises.delete(disconnectPromise));
        this.#disconnectPromises.add(disconnectPromise);
      },
    });
    this.#sessionStore.add(clientId, connection, sessionId, authSession);
    if (authSession?.expiresAt) {
      const expire = () => {
        const remaining = authSession.expiresAt - Date.now();
        if (remaining <= 0) {
          connection.close(4001, 'Authentication expired');
          return;
        }
        expiryTimer = setTimeout(expire, Math.min(remaining, MAX_TIMER_DELAY));
        expiryTimer.unref();
      };
      expire();
    }
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
 * @property {number} maxWriteQueueBytes Maximum pending framed bytes. / Максимальный размер
 * ожидающих frames в байтах.
 * @property {WebSocketCloseListener} onClose Close listener. / Обработчик закрытия.
 * @property {WebSocketMessageListener} onMessage Message listener. / Обработчик сообщения.
 * @property {WebSocketProtocolFailureListener} onProtocolError Protocol listener. / Обработчик.
 * @private
 */

/**
 * Stable socket listeners owned by one WebSocket connection.
 * Стабильные listeners socket, принадлежащие одному WebSocket-соединению.
 *
 * @typedef {Object} WebSocketSocketListeners
 * @property {Function} data Inbound-data listener. / Listener входящих данных.
 * @property {Function} error Socket-error listener. / Listener ошибки socket.
 * @property {Function} end Socket-end listener. / Listener завершения socket.
 * @property {Function} close Socket-close listener. / Listener закрытия socket.
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
 * @property {Authentication} [authentication] Shared Authentication module. / Общий модуль
 * Authentication.
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
 * @property {'session'} phase Error phase. / Фаза ошибки.
 * @property {string} clientId Client identifier. / Идентификатор клиента.
 * @property {string} sessionId Session identifier. / Идентификатор сессии.
 * @property {AbortSignal} signal Session signal. / Сигнал сессии.
 * @property {AuthSession} [authSession] Confirmed authentication session. / Подтверждённая сессия
 * аутентификации.
 * @private
 */
