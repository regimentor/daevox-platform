import { InvalidWebSocketPushError, WebSocketPushPayloadTooLargeError } from './errors.js';
import { encodeWebSocketMessage, isWebSocketMessageBody } from './webSocketProtocol.js';

/**
 * Valid controller and event wire-name syntax.
 * Допустимый синтаксис сетевых имён контроллеров и событий.
 *
 * @type {RegExp}
 * @private
 */
const WIRE_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Tests whether a value is an exact push envelope with safe data properties.
 * Проверяет, является ли значение точным push envelope с безопасными data properties.
 *
 * @param {*} envelope Candidate envelope. / Проверяемый envelope.
 * @returns {boolean} Whether the outer envelope is valid. / Валиден ли внешний envelope.
 * @private
 */
function isExactPushEnvelope(envelope) {
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) return false;
  const prototype = Object.getPrototypeOf(envelope);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(envelope);
  if (
    keys.length !== 3 ||
    !keys.every((key) => typeof key === 'string' && ['body', 'controller', 'event'].includes(key))
  ) {
    return false;
  }
  const descriptors = Object.fromEntries(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(envelope, key)]),
  );
  return (
    keys.every((key) => descriptors[key]?.enumerable && 'value' in descriptors[key]) &&
    typeof descriptors.controller.value === 'string' &&
    WIRE_NAME.test(descriptors.controller.value) &&
    typeof descriptors.event.value === 'string' &&
    WIRE_NAME.test(descriptors.event.value)
  );
}

/**
 * Creates the request-scoped WebSocket server-push capability for one confirmed AuthSession.
 * Создаёт request-scoped capability WebSocket server push для одной подтверждённой AuthSession.
 *
 * @param {string} authSessionId Confirmed authentication-session identifier. / Идентификатор
 * подтверждённой сессии аутентификации.
 * @param {WebSocketSessionStore} sessionStore Application-owned session catalog. / Принадлежащий
 * приложению каталог сессий.
 * @param {number} maxPayload Maximum encoded message bytes. / Максимальный размер кодированного
 * сообщения в байтах.
 * @returns {HttpRequestWebSocketSender} Frozen request-scoped sender. / Замороженный
 * request-scoped sender.
 * @private
 */
export function createWebSocketRequestSender(authSessionId, sessionStore, maxPayload) {
  return Object.freeze({
    send(envelope) {
      if (!isExactPushEnvelope(envelope)) {
        throw new InvalidWebSocketPushError('WebSocket push envelope is invalid');
      }
      if (!isWebSocketMessageBody(envelope.body)) {
        throw new InvalidWebSocketPushError('WebSocket push envelope is invalid');
      }
      const text = encodeWebSocketMessage(envelope.controller, envelope.event, envelope.body);
      if (Buffer.byteLength(text) > maxPayload) {
        throw new WebSocketPushPayloadTooLargeError('WebSocket push payload is too large');
      }
      const connections = sessionStore.connectionsForAuthSession(authSessionId);
      let queued = 0;
      for (const connection of connections) {
        if (connection.send(text)) queued += 1;
      }
      return Object.freeze({
        matched: connections.length,
        queued,
        dropped: connections.length - queued,
      });
    },
  });
}

/**
 * Request-scoped WebSocket server-push capability.
 * Request-scoped capability WebSocket server push.
 *
 * @typedef {Object} HttpRequestWebSocketSender
 * @property {WebSocketPushSend} send Sends one protocol envelope to the current AuthSession. /
 * Отправляет один envelope протокола текущей AuthSession.
 * @public
 */

/**
 * Sends one WebSocket protocol envelope.
 * Отправляет один envelope WebSocket-протокола.
 *
 * @callback WebSocketPushSend
 * @param {WebSocketProtocolMessage} envelope Exact protocol envelope. / Точный envelope протокола.
 * @returns {WebSocketPushResult} Local enqueue result. / Результат локальной постановки в очередь.
 * @public
 */

/**
 * Local WebSocket server-push enqueue result.
 * Результат локальной постановки WebSocket server push в очередь.
 *
 * @typedef {Object} WebSocketPushResult
 * @property {number} matched Matched local connections. / Найденные локальные соединения.
 * @property {number} queued Connections that accepted the frame. / Соединения, принявшие frame.
 * @property {number} dropped Connections that rejected the frame. / Соединения, отклонившие frame.
 * @public
 */
