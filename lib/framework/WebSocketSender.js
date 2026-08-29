import {
  InvalidWebSocketSendError,
  WebSocketClientNotFoundError,
  WebSocketProtocolError,
} from './errors.js';
import { encodeWebSocketMessage } from './webSocketProtocol.js';

/**
 * Sends best-effort `daevox.v1` messages to active WebSocket sessions.
 * Отправляет best-effort сообщения `daevox.v1` в активные WebSocket-сессии.
 *
 * @public
 */
export class WebSocketSender {
  /** @type {number} Maximum encoded payload. / Максимальный размер кодированного сообщения. @private */
  #maxPayload;
  /** @type {WebSocketSessionStore} Active sessions. / Активные сессии. @private */
  #sessionStore;

  /** @param {WebSocketSessionStore} sessionStore Active sessions. / Активные сессии.
   * @param {number} maxPayload Maximum message size. / Максимальный размер сообщения. */
  constructor(sessionStore, maxPayload) {
    this.#sessionStore = sessionStore;
    this.#maxPayload = maxPayload;
  }

  /**
   * Sends one message to all or selected sessions of a client.
   * Отправляет сообщение всем или выбранным сессиям клиента.
   * @param {WebSocketSendTarget} target Delivery target. / Цель доставки.
   * @param {WebSocketSendMessage} message Outbound message. / Исходящее сообщение.
   * @returns {{sent: number, skipped: number}} Delivery counts. / Счётчики доставки.
   * @public
   */
  send(target, message) {
    const sessionIds = validateTarget(target);
    if (
      message === null ||
      typeof message !== 'object' ||
      Array.isArray(message) ||
      Reflect.ownKeys(message).some((key) => !['controller', 'event', 'body'].includes(key)) ||
      !Object.hasOwn(message, 'controller') ||
      !Object.hasOwn(message, 'event') ||
      !Object.hasOwn(message, 'body')
    )
      throw new InvalidWebSocketSendError('WebSocket send message is invalid');
    let encoded;
    try {
      encoded = encodeWebSocketMessage(
        message?.controller,
        message?.event,
        message?.body,
        this.#maxPayload,
      );
    } catch (error) {
      if (error instanceof WebSocketProtocolError) {
        throw new InvalidWebSocketSendError('WebSocket send message is invalid', { cause: error });
      }
      throw error;
    }
    const sessions = this.#sessionStore.sessionsFor(target.clientId);
    if (!sessions) throw new WebSocketClientNotFoundError('WebSocket client was not found');
    const selected = sessionIds === undefined ? undefined : new Set(sessionIds);
    let sent = 0;
    let skipped = 0;
    for (const session of sessions) {
      if (selected && !selected.has(session.sessionId)) continue;
      if (session.connection.send(encoded)) sent += 1;
      else skipped += 1;
    }
    if (selected) {
      skipped += [...selected].filter(
        (id) => !sessions.some((session) => session.sessionId === id),
      ).length;
    }
    return { sent, skipped };
  }
}

/**
 * Validates and normalizes a sender target. / Проверяет и нормализует цель sender.
 * @param {*} target Candidate target. / Проверяемая цель.
 * @returns {string[]|undefined} Unique session IDs. / Уникальные идентификаторы сессий.
 * @private
 */
function validateTarget(target) {
  if (
    target === null ||
    typeof target !== 'object' ||
    Array.isArray(target) ||
    !Object.hasOwn(target, 'clientId') ||
    typeof target.clientId !== 'string' ||
    target.clientId.length === 0 ||
    Reflect.ownKeys(target).some((key) => !['clientId', 'sessionIds'].includes(key)) ||
    (target.sessionIds !== undefined &&
      (!Array.isArray(target.sessionIds) ||
        target.sessionIds.some((id) => typeof id !== 'string' || id.length === 0)))
  )
    throw new InvalidWebSocketSendError('WebSocket send target is invalid');
  return target.sessionIds === undefined ? undefined : [...new Set(target.sessionIds)];
}

/** @typedef {{clientId: string, sessionIds?: string[]}} WebSocketSendTarget */
/** @typedef {{controller: string, event: string, body: Object}} WebSocketSendMessage */
