import {
  InvalidWebSocketSendError,
  WebSocketClientNotFoundError,
  WebSocketProtocolError,
} from './errors.ts';
import { encodeWebSocketMessage } from './webSocketProtocol.ts';
import type { WebSocketSessionStore } from './WebSocketSessionStore.ts';

/** WebSocket delivery target. / Цель доставки WebSocket-сообщения. @public */
export interface WebSocketSendTarget {
  clientId: string;
  sessionIds?: string[];
}

/** Outbound WebSocket protocol message. / Исходящее сообщение WebSocket-протокола. @public */
export interface WebSocketSendMessage<Body extends object = Record<string, unknown>> {
  controller: string;
  event: string;
  body: Body;
}

/** WebSocket delivery counters. / Счётчики доставки WebSocket. @public */
export interface WebSocketSendResult {
  sent: number;
  skipped: number;
}

/**
 * Sends best-effort `daevox.v1` messages to active WebSocket sessions.
 * Отправляет best-effort сообщения `daevox.v1` в активные WebSocket-сессии.
 * @private
 */
export class WebSocketSender {
  /** Maximum encoded payload. / Максимальный размер кодированного сообщения. @private */
  #maxPayload: number;
  /** Active sessions. / Активные сессии. @private */
  #sessionStore: WebSocketSessionStore;

  /** @param sessionStore Active sessions. / Активные сессии.
   * @param maxPayload Maximum message size. / Максимальный размер сообщения. */
  constructor(sessionStore: WebSocketSessionStore, maxPayload: number) {
    this.#sessionStore = sessionStore;
    this.#maxPayload = maxPayload;
  }

  /**
   * Sends one message to all or selected sessions of a client.
   * Отправляет сообщение всем или выбранным сессиям клиента.
   * @param target Delivery target. / Цель доставки.
   * @param message Outbound message. / Исходящее сообщение.
   * @returns Delivery counts. / Счётчики доставки.
   * @public
   */
  send<Body extends object>(
    target: WebSocketSendTarget,
    message: WebSocketSendMessage<Body>,
  ): WebSocketSendResult {
    const sessionIds = validateTarget(target);
    if (
      message === null ||
      typeof message !== 'object' ||
      Array.isArray(message) ||
      Reflect.ownKeys(message).some(
        (key) => typeof key !== 'string' || !['controller', 'event', 'body'].includes(key),
      ) ||
      !Object.hasOwn(message, 'controller') ||
      !Object.hasOwn(message, 'event') ||
      !Object.hasOwn(message, 'body')
    )
      throw new InvalidWebSocketSendError('WebSocket send message is invalid');
    let encoded: string;
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
 * @param target Candidate target. / Проверяемая цель.
 * @returns Unique session IDs. / Уникальные идентификаторы сессий.
 * @private
 */
function validateTarget(target: WebSocketSendTarget): string[] | undefined {
  if (
    target === null ||
    typeof target !== 'object' ||
    Array.isArray(target) ||
    !Object.hasOwn(target, 'clientId') ||
    typeof target.clientId !== 'string' ||
    target.clientId.length === 0 ||
    Reflect.ownKeys(target).some(
      (key) => typeof key !== 'string' || !['clientId', 'sessionIds'].includes(key),
    ) ||
    (target.sessionIds !== undefined &&
      (!Array.isArray(target.sessionIds) ||
        target.sessionIds.some((id) => typeof id !== 'string' || id.length === 0)))
  )
    throw new InvalidWebSocketSendError('WebSocket send target is invalid');
  return target.sessionIds === undefined ? undefined : [...new Set(target.sessionIds)];
}
