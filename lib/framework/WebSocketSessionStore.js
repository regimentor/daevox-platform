/**
 * Internal catalog of active WebSocket sessions. / Внутренний каталог активных WebSocket-сессий.
 *
 * @private
 */
export class WebSocketSessionStore {
  /**
   * Session identifiers grouped by confirmed AuthSession.
   * Идентификаторы сессий, сгруппированные по подтверждённой AuthSession.
   *
   * @type {Map<string, Set<string>>}
   * @private
   */
  #authSessionMembership = new Map();
  /**
   * @type {Map<string, WebSocketSessionRecord>} Sessions by identifier. / Сессии по идентификатору.
   * @private
   */
  #sessions = new Map();

  /**

   * Stores an active session. / Сохраняет активную сессию.

   *

   * @param {string} clientId Client identifier. / Идентификатор клиента.

   * @param {WebSocketConnection} connection Transport connection. / Транспортное соединение.

   * @param {string} sessionId Session identifier. / Идентификатор сессии.

   * @param {AuthSession} [authSession] Confirmed authentication session. / Подтверждённая сессия
   * аутентификации.

   * @returns {string} Stored session identifier. / Сохранённый идентификатор.

   * @private

   */
  add(clientId, connection, sessionId, authSession) {
    if (this.#sessions.has(sessionId)) this.remove(sessionId);
    const session = {
      clientId,
      connection,
      sessionId,
      ...(authSession ? { authSession } : {}),
    };
    this.#sessions.set(sessionId, session);
    if (authSession) {
      let membership = this.#authSessionMembership.get(authSession.authSessionId);
      if (!membership) {
        membership = new Set();
        this.#authSessionMembership.set(authSession.authSessionId, membership);
      }
      membership.add(sessionId);
    }
    return sessionId;
  }

  /**
   * Returns a stable snapshot of connections for one exact AuthSession identifier.
   * Возвращает стабильный snapshot соединений точной AuthSession.
   *
   * @param {string} authSessionId Authentication-session identifier. / Идентификатор AuthSession.
   * @returns {WebSocketConnection[]} Frozen connection snapshot. / Замороженный snapshot соединений.
   * @private
   */
  connectionsForAuthSession(authSessionId) {
    const membership = this.#authSessionMembership.get(authSessionId);
    if (!membership) return Object.freeze([]);
    return Object.freeze(
      [...membership]
        .map((sessionId) => this.#sessions.get(sessionId)?.connection)
        .filter((connection) => connection !== undefined),
    );
  }

  /**
   * Returns the confirmed AuthSession attached to a transport session.
   * Возвращает подтверждённую AuthSession транспортной сессии.
   *
   * @param {string} sessionId Transport-session identifier. / Идентификатор транспортной сессии.
   * @returns {AuthSession|undefined} Attached session. / Связанная сессия.
   * @private
   */
  authSessionForSession(sessionId) {
    return this.#sessions.get(sessionId)?.authSession;
  }

  /**

   * Removes a session. / Удаляет сессию.

   *

   * @param {string} sessionId Session identifier. / Идентификатор сессии.

   * @returns {boolean} Whether a session was removed. / Была ли сессия удалена.

   * @private

   */
  remove(sessionId) {
    const session = this.#sessions.get(sessionId);
    if (!session) return false;
    this.#sessions.delete(sessionId);
    if (session.authSession) {
      const membership = this.#authSessionMembership.get(session.authSession.authSessionId);
      membership?.delete(sessionId);
      if (membership?.size === 0) {
        this.#authSessionMembership.delete(session.authSession.authSessionId);
      }
    }
    return true;
  }

  /**

   * Starts closing every active session. / Начинает закрытие всех активных сессий.

   *

   * @param {number} [code=1001] Close code. / Код закрытия.

   * @param {string} [reason='Server shutting down'] Close reason. / Причина закрытия.

   * @returns {void}

   * @private

   */
  closeAll(code = 1001, reason = 'Server shutting down') {
    for (const session of this.#sessions.values()) {
      session.connection.close(code, reason);
    }
  }
}

/**
 * Active WebSocket-session record.
 * Запись активной WebSocket-сессии.
 *
 * @typedef {Object} WebSocketSessionRecord
 * @property {string} clientId Client identifier. / Идентификатор клиента.
 * @property {string} sessionId Session identifier. / Идентификатор сессии.
 * @property {WebSocketConnection} connection Transport connection. / Транспортное соединение.
 * @property {AuthSession} [authSession] Confirmed authentication session. / Подтверждённая сессия
 * аутентификации.
 * @private
 */
