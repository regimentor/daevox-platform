/**
 * Internal catalog of active WebSocket sessions. / Внутренний каталог активных WebSocket-сессий.
 *
 * @private
 */
export class WebSocketSessionStore {
  /**
   * @type {Map<string, WebSocketSessionRecord>} Sessions by identifier. / Сессии по идентификатору.
   * @private
   */
  #sessions = new Map();
  /**
   * @type {Map<string, Set<string>>} Active sessions by client. / Активные сессии по клиентам.
   * @private
   */
  #clientSessions = new Map();

  /**

   * Stores an active session. / Сохраняет активную сессию.

   *

   * @param {string} clientId Client identifier. / Идентификатор клиента.

   * @param {WebSocketConnection} connection Transport connection. / Транспортное соединение.

   * @param {string} sessionId Session identifier. / Идентификатор сессии.

   * @returns {string} Stored session identifier. / Сохранённый идентификатор.

   * @private

   */
  add(clientId, connection, sessionId) {
    const session = { clientId, connection, sessionId };
    this.#sessions.set(sessionId, session);
    let sessionIds = this.#clientSessions.get(clientId);
    if (!sessionIds) {
      sessionIds = new Set();
      this.#clientSessions.set(clientId, sessionIds);
    }
    sessionIds.add(sessionId);
    return sessionId;
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
    const sessionIds = this.#clientSessions.get(session.clientId);
    sessionIds?.delete(sessionId);
    if (sessionIds?.size === 0) this.#clientSessions.delete(session.clientId);
    return true;
  }

  /**
   * Returns a snapshot of a client's sessions. / Возвращает снимок сессий клиента.
   * @private
   */
  sessionsFor(clientId) {
    const sessionIds = this.#clientSessions.get(clientId);
    if (!sessionIds) return undefined;
    return [...sessionIds].map((id) => this.#sessions.get(id)).filter(Boolean);
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
 * @private
 */
