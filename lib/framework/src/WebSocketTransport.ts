import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';
import type {
  AppStateInstance,
  NormalizedWebSocketOptions,
  WebSocketHandlerContext,
  WebSocketLifecycleContext,
} from './Application.ts';
import type { EventSender } from './EventSender.ts';
import type { JobRunner } from './JobRunner.ts';
import type { WebSocketControllerRegistry } from './WebSocketControllerRegistry.ts';
import type { WebSocketSessionStore } from './WebSocketSessionStore.ts';
import { HttpError, WebSocketEventError, WebSocketProtocolError } from './errors.ts';
import { composeMiddleware } from './middleware.ts';
import {
  decodeWebSocketMessage,
  encodeWebSocketError,
  encodeWebSocketMessage,
} from './webSocketProtocol.ts';

/** Encoded outbound WebSocket frame data. / Данные кодированного исходящего WebSocket frame. @private */
interface WebSocketOutboundMessage {
  opcode: number;
  payload: Buffer;
}

/** Connection-close callback. / Callback закрытия соединения. @private */
type WebSocketCloseListener = (code: number, reason: string) => void;
/** Complete-message callback. / Callback полного сообщения. @private */
type WebSocketMessageListener = (data: string | Buffer) => void;
/** Frame-protocol failure callback. / Callback ошибки frame-протокола. @private */
type WebSocketProtocolFailureListener = (code: number, reason: string) => void;

/** Connection parser options. / Параметры парсера соединения. @private */
interface WebSocketConnectionOptions {
  maxPayload: number;
  onClose: WebSocketCloseListener;
  onMessage: WebSocketMessageListener;
  onProtocolError: WebSocketProtocolFailureListener;
  onSocketError?: (error: Error) => void;
  onTransportClose: () => void;
}

/** Dependencies owned by the WebSocket transport. / Зависимости WebSocket-транспорта. @private */
interface WebSocketTransportDependencies {
  appState: AppStateInstance;
  controllers: WebSocketControllerRegistry;
  events: EventSender;
  jobRunner: JobRunner;
  onError?: NormalizedWebSocketOptions['onError'];
  options: NormalizedWebSocketOptions;
  sessionStore: WebSocketSessionStore;
}

/** Context retained for one WebSocket session. / Контекст одной WebSocket-сессии. @private */
interface WebSocketSessionContext {
  clientId: string;
  sessionId: string;
  signal: AbortSignal;
  state: Record<string, unknown>;
}

/**

 * RFC 6455 handshake GUID. / GUID handshake из RFC 6455.

 *
 * @private

 */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/**
 * Strict UTF-8 decoder for text frames and close reasons. / Строгий декодер UTF-8 для text frames и причин закрытия.
 * @private
 */
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

/**

 * Serializes application text into an outbound message descriptor. / Сериализует прикладной текст в описание исходящего сообщения.

 *
 * @param data Text data. / Текстовые данные.

 * @returns Message descriptor. / Описание сообщения.

 * @private

 */
function serialize(data: string): WebSocketOutboundMessage {
  return { opcode: 1, payload: Buffer.from(data) };
}

/**

 * Builds one unmasked server-to-client WebSocket frame. / Формирует один немаскированный WebSocket frame от сервера клиенту.

 *
 * @param opcode Frame opcode. / Opcode frame.

 * @param [payload] Frame payload. / Payload frame.

 * @returns Encoded frame. / Кодированный frame.

 * @private

 */
function frame(opcode: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const length = payload.byteLength;
  let header: Buffer;
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
   * Unparsed inbound bytes. / Неразобранные входящие байты.
   * @private
   */
  #buffer = Buffer.alloc(0);
  /**
   * Whether the connection finished. / Завершено ли соединение.
   * @private
   */
  #closed = false;
  /**
   * Fragments of the current message. / Фрагменты текущего сообщения.
   * @private
   */
  #fragmentedChunks: Buffer[] = [];
  /**
   * Accumulated fragmented message bytes. / Накопленный размер фрагментов.
   * @private
   */
  #fragmentedLength = 0;
  /**
   * Opcode of the fragmented message. / Opcode фрагментированного сообщения.
   * @private
   */
  #fragmentedOpcode: number | undefined;
  /**
   * Maximum inbound message bytes. / Максимальный размер входящего сообщения.
   * @private
   */
  #maxPayload: number;
  /**
   * Close listener. / Обработчик закрытия.
   * @private
   */
  #onClose: WebSocketCloseListener;
  /**
   * Message listener. / Обработчик сообщения.
   * @private
   */
  #onMessage: WebSocketMessageListener;
  /**
   * Frame-protocol listener. / Обработчик ошибки frame-протокола.
   * @private
   */
  #onProtocolError: WebSocketProtocolFailureListener;
  /** Socket error listener. / Обработчик ошибки socket. */
  #onSocketError: ((error: Error) => void) | undefined;
  /**
   * Physical socket-close listener. / Обработчик физического закрытия socket.
   * @private
   */
  #onTransportClose: () => void;
  /**
   * Upgraded TCP socket. / Upgraded TCP-сокет.
   * @private
   */
  #socket: Socket;

  /**

   * Creates a connection parser around an upgraded socket. / Создаёт парсер соединения вокруг upgraded-сокета.

   *
   * @param socket Upgraded socket. / Upgraded-сокет.

   * @param options Parser callbacks and limit. / Callbacks и ограничение парсера.

   * @private

   */
  constructor(
    socket: Socket,
    {
      maxPayload,
      onClose,
      onMessage,
      onProtocolError,
      onSocketError,
      onTransportClose,
    }: WebSocketConnectionOptions,
  ) {
    this.#socket = socket;
    this.#maxPayload = maxPayload;
    this.#onClose = onClose;
    this.#onMessage = onMessage;
    this.#onProtocolError = onProtocolError;
    this.#onSocketError = onSocketError;
    this.#onTransportClose = onTransportClose;
    socket.on('data', (chunk) => this.#read(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    socket.on('error', (error) => {
      this.#onSocketError?.(error);
      this.#finish(1006, '');
    });
    socket.on('end', () => {
      this.#finish(1006, '');
      socket.destroy();
    });
    socket.on('close', () => {
      this.#finish(1006, '');
      this.#onTransportClose();
    });
  }

  /**

   * Feeds bytes already read after the HTTP upgrade request. / Передаёт байты, уже прочитанные после HTTP upgrade-запроса.

   *
   * @param head Buffered bytes. / Буферизованные байты.

   * @private

   */
  start(head: Buffer): void {
    if (head.byteLength > 0) this.#read(head);
  }

  /**

   * Sends one protocol text message. / Отправляет одно текстовое сообщение протокола.

   *
   * @param data Encoded message. / Кодированное сообщение.

   * @returns Whether the frame was accepted for writing. / Был ли frame принят для записи.

   * @private

   */
  send(data: string): boolean {
    if (this.#closed || !this.#socket.writable) return false;
    const message = serialize(data);
    this.#socket.write(frame(message.opcode, message.payload));
    return true;
  }

  /**

   * Starts a WebSocket closing handshake and finishes local state. / Начинает WebSocket closing handshake и завершает локальное состояние.

   *
   * @param [code=1000] Close code. / Код закрытия.

   * @param [reason=''] Close reason. / Причина закрытия.

   * @private

   */
  close(code = 1000, reason = ''): void {
    if (this.#closed) return;
    const reasonBytes = Buffer.from(reason);
    const payload = Buffer.alloc(2 + Math.min(reasonBytes.byteLength, 123));
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2, 0, payload.byteLength - 2);
    this.#socket.end(frame(8, payload));
    this.#finish(code, reason);
  }

  /**
   * Immediately destroys the transport connection during forced shutdown.
   * Немедленно уничтожает транспортное соединение при принудительном shutdown.
   * @private
   */
  terminate(): void {
    if (this.#socket.destroyed) return;
    this.#socket.destroy();
    this.#finish(1006, '');
  }

  /**

   * Reports a frame-protocol failure and destroys the socket after close. / Сообщает об ошибке frame-протокола и уничтожает сокет после закрытия.

   *
   * @param code Close code. / Код закрытия.

   * @param reason Close reason. / Причина закрытия.

   * @private

   */
  #fail(code: number, reason: string): void {
    this.#onProtocolError(code, reason);
    this.close(code, reason);
    this.#socket.destroySoon();
  }

  /**

   * Incrementally parses masked client frames. / Инкрементально разбирает маскированные клиентские frames.

   *
   * @param chunk Inbound bytes. / Входящие байты.

   * @private

   */
  #read(chunk: Buffer): void {
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
        let reason: string;
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
          this.#deliverMessage(messageOpcode!, messagePayload);
        }
      }
    }
  }

  /**

   * Decodes and delivers one complete data message. / Декодирует и передаёт одно полное data-сообщение.

   *
   * @param opcode Message opcode. / Opcode сообщения.

   * @param payload Message bytes. / Байты сообщения.

   * @private

   */
  #deliverMessage(opcode: number, payload: Buffer): void {
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
   * @param code Close code. / Код закрытия.

   * @returns Validation result. / Результат проверки.

   * @private

   */
  #isValidCloseCode(code: number): boolean {
    return (
      (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
      (code >= 3000 && code <= 4999)
    );
  }

  /**

   * Completes local connection state exactly once. / Однократно завершает локальное состояние соединения.

   *
   * @param code Close code. / Код закрытия.

   * @param reason Close reason. / Причина закрытия.

   * @private

   */
  #finish(code: number, reason: string): void {
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
   * Physical transport connections. / Физические транспортные соединения.
   * @private
   */
  #connections = new Set<WebSocketConnection>();
  /**
   * Controller catalog. / Каталог контроллеров.
   * @private
   */
  #controllers: WebSocketControllerRegistry;
  /**
   * Pending disconnect hooks. / Незавершённые hooks отключения.
   * @private
   */
  #disconnectPromises = new Set<Promise<unknown>>();
  /**
   * Unsettled transport user operations. / Незавершённые transport-операции.
   * @private
   */
  #operations = new Set<Promise<unknown>>();
  /**
   * Operation settlement waiters. / Ожидающие settlement операций.
   * @private
   */
  #operationWaiters = new Set<() => void>();
  /**
   * Pending handshake sockets. / Ожидающие handshake socket.
   * @private
   */
  #pendingUpgrades = new Map<AbortController, Socket>();
  /**
   * Controller event sender. / Sender внутренних событий контроллеров.
   * @private
   */
  #events: EventSender;
  /**
   * Controller job runner. / Исполнитель задач контроллеров.
   * @private
   */
  #jobRunner: JobRunner;
  /**
   * Error observer. / Наблюдатель ошибок.
   * @private
   */
  #onError: NormalizedWebSocketOptions['onError'];
  /**
   * Transport options. / Параметры транспорта.
   * @private
   */
  #options: NormalizedWebSocketOptions;
  /**
   * Active sessions. / Активные сессии.
   * @private
   */
  #sessionStore: WebSocketSessionStore;
  /** Shared application state. / Общее состояние приложения. @private */
  #appState: AppStateInstance;

  /**

   * Creates the application-owned WebSocket transport. / Создаёт принадлежащий приложению WebSocket-транспорт.

   *
   * @param dependencies Owned dependencies. / Принадлежащие зависимости.

   * @private

   */
  constructor({
    appState,
    controllers,
    events,
    jobRunner,
    onError,
    options,
    sessionStore,
  }: WebSocketTransportDependencies) {
    this.#controllers = controllers;
    this.#events = events;
    this.#jobRunner = jobRunner;
    this.#onError = onError;
    this.#options = options;
    this.#sessionStore = sessionStore;
    this.#appState = appState;
  }

  /**

   * Attaches WebSocket upgrade handling to the shared HTTP server. / Подключает обработку WebSocket upgrade к общему HTTP-серверу.

   *
   * @param server Shared server. / Общий сервер.

   * @private

   */
  attach(server: Server): void {
    server.on('upgrade', (request, socket, head) => {
      const operation = this.#upgrade(request, socket as Socket, head);
      this.#track(operation);
      operation.catch((error: unknown) => {
        this.#report(error, undefined);
        if (socket.writable) socket.end('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      });
    });
  }

  /**

   * Validates and upgrades one handshake, then dispatches its messages serially. / Проверяет и выполняет upgrade одного handshake, затем последовательно обрабатывает сообщения.

   *
   * @param request Upgrade request. / Upgrade-запрос.

   * @param socket TCP socket. / TCP-сокет.

   * @param head Buffered bytes. / Буферизованные байты.

   * @returns Upgrade completion. / Завершение upgrade.

   * @private

   */
  async #upgrade(request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    let url: URL;
    try {
      url = new URL(request.url ?? '', 'http://localhost');
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
    let clientId: string;
    const sessionId = randomUUID();
    const state = Object.create(null);
    const connectContext = Object.freeze({
      clientId: generatedClientId,
      path: url.pathname,
      query: new URLSearchParams(url.searchParams),
      headers: new Headers(request.headers as unknown as HeadersInit),
      sessionId,
      signal: abortController.signal,
      state,
    });
    this.#pendingUpgrades.set(abortController, socket);
    try {
      const onConnect = this.#options.onConnect;
      const result = await (onConnect ? onConnect(this.#appState, connectContext) : undefined);
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
    } finally {
      this.#pendingUpgrades.delete(abortController);
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
      onTransportClose: () => this.#connections.delete(connection),
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
            const handler = route.handler;
            const handlerContext = Object.freeze({
              body: message.body,
              clientId,
              controller: message.controller,
              event: message.event,
              sessionId,
              signal: abortController.signal,
              state,
            });
            let result: unknown;
            try {
              const execute = composeMiddleware(
                [
                  ...this.#options.middleware,
                  ...(route.controllerMiddleware ?? []),
                  ...(route.eventMiddleware ?? []),
                ],
                () => {
                  const controller = new route.controller({
                    jobRunner: this.#jobRunner,
                    events: this.#events,
                  });
                  const method = (
                    controller as unknown as Record<string, (...args: unknown[]) => unknown>
                  )[handler];
                  return method.call(controller, this.#appState, handlerContext);
                },
              );
              result = await execute(this.#appState, handlerContext);
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
                  result as object,
                  this.#options.maxPayload,
                ),
              );
            }
          })
          .catch((error: unknown) =>
            this.#handleMessageError(error, connection, {
              clientId,
              sessionId,
              signal: abortController.signal,
              state,
            }),
          );
        this.#track(messageChain);
      },
      onClose: (code, reason) => {
        abortController.abort();
        this.#sessionStore.remove(sessionId);
        const disconnectPromise = Promise.resolve()
          .then(() =>
            this.#options.onDisconnect
              ? this.#options.onDisconnect(
                  this.#appState,
                  Object.freeze({ ...finalConnectContext, code, reason }),
                )
              : undefined,
          )
          .catch((error: unknown) => this.#report(error, finalConnectContext))
          .finally(() => this.#disconnectPromises.delete(disconnectPromise));
        this.#disconnectPromises.add(disconnectPromise);
        this.#track(disconnectPromise);
      },
    });
    this.#connections.add(connection);
    this.#sessionStore.add(clientId, connection, sessionId);
    connection.start(head);
  }

  /**
   * Waits for server closure and all user WebSocket operations within one grace budget.
   * Ждёт закрытия сервера и всех пользовательских WebSocket-операций в пределах одного бюджета.
   * @param serverClosing Shared server close operation. / Закрытие общего сервера.
   * @param timeout Grace timeout in milliseconds. / Тайм-аут grace-периода.
   * @returns Settlement or forced cutoff. / Settlement или forced cutoff.
   * @private
   */
  async waitForSettlement(serverClosing: Promise<unknown>, timeout: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const graceful = (async () => {
      await serverClosing;
      await this.#waitForOperations();
      return 'settled';
    })();
    const result = await Promise.race([
      graceful,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(resolve, timeout, 'timeout');
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (result !== 'timeout') return;
    for (const [abortController, socket] of this.#pendingUpgrades) {
      abortController.abort();
      socket.destroy();
    }
    for (const connection of this.#connections) connection.terminate();
  }

  /**
   * Tracks one user operation without changing its settlement.
   * Отслеживает одну пользовательскую операцию без изменения её settlement.
   * @param operation Tracked operation. / Отслеживаемая операция.
   * @private
   */
  #track(operation: Promise<unknown>): void {
    this.#operations.add(operation);
    const settled = () => {
      this.#operations.delete(operation);
      if (this.#operations.size === 0) {
        for (const resolve of this.#operationWaiters) resolve();
        this.#operationWaiters.clear();
      }
    };
    operation.then(settled, settled);
  }

  /**
   * Waits until all currently tracked operations settle.
   * Ждёт settlement всех отслеживаемых операций.
   * @returns Completion. / Завершение ожидания.
   * @private
   */
  #waitForOperations(): Promise<void> {
    if (this.#operations.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.#operationWaiters.add(resolve));
  }

  /**

   * Reports an error without letting observer failures affect transport. / Сообщает об ошибке, не позволяя сбою наблюдателя повлиять на транспорт.

   *
   * @param error Reported error. / Ошибка.

   * @param [ctx] Available context. / Доступный контекст.

   * @private

   */
  #report(
    error: unknown,
    ctx?: Partial<WebSocketHandlerContext> | WebSocketLifecycleContext,
  ): void {
    if (!this.#onError) return;
    try {
      Promise.resolve(this.#onError(this.#appState, error, ctx)).catch(console.error);
    } catch (reportingError) {
      console.error(reportingError);
    }
  }

  /**
   * Rejects a WebSocket handshake with an expected HTTP response.
   * Отклоняет WebSocket handshake ожидаемым HTTP-ответом.
   * @param socket Handshake socket. / Socket handshake.
   * @param error Expected HTTP failure. / Ожидаемая HTTP-ошибка.
   * @private
   */
  #rejectHandshake(socket: Socket, error: HttpError): void {
    const headers: Record<string, string> = Object.fromEntries(error.headers ?? []);
    let body: Buffer;
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
   * @param error Processing error. / Ошибка обработки.

   * @param connection Active connection. / Активное соединение.

   * @param sessionContext Session identifiers and signal. / Идентификаторы и сигнал сессии.

   * @private

   */
  #handleMessageError(
    error: unknown,
    connection: WebSocketConnection,
    sessionContext: WebSocketSessionContext,
  ): void {
    const address =
      error !== null && typeof error === 'object'
        ? (error as { controller?: unknown; event?: unknown })
        : {};
    const ctx = Object.freeze({
      ...sessionContext,
      ...(typeof address.controller === 'string' ? { controller: address.controller } : {}),
      ...(typeof address.event === 'string' ? { event: address.event } : {}),
    });
    this.#report(error, ctx);
    if (!(error instanceof WebSocketProtocolError)) return;
    if (error.fatal) {
      connection.close(1007, 'Invalid message');
      return;
    }
    try {
      connection.send(
        encodeWebSocketError(error.controller!, error.event!, error.code, this.#options.maxPayload),
      );
    } catch {
      connection.close(1011, 'Internal error');
    }
  }
}
