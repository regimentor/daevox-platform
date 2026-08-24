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
 * @private
 */
