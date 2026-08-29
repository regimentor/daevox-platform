/**
 * Internal catalog of active WebSocket sessions. / Внутренний каталог активных WebSocket-сессий.
 * @private
 */
export class WebSocketSessionStore {
  /**
   * Sessions by identifier. / Сессии по идентификатору.
   * @private
   */
  #sessions = new Map<string, WebSocketSessionRecord>();
  /**
   * Active sessions by client. / Активные сессии по клиентам.
   * @private
   */
  #clientSessions = new Map<string, Set<string>>();

  /**

   * Stores an active session. / Сохраняет активную сессию.

   *
   * @param clientId Client identifier. / Идентификатор клиента.

   * @param connection Transport connection. / Транспортное соединение.

   * @param sessionId Session identifier. / Идентификатор сессии.

   * @returns Stored session identifier. / Сохранённый идентификатор.

   * @private

   */
  add(clientId: string, connection: WebSocketSessionConnection, sessionId: string): string {
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
   * @param sessionId Session identifier. / Идентификатор сессии.

   * @returns Whether a session was removed. / Была ли сессия удалена.

   * @private

   */
  remove(sessionId: string): boolean {
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
  sessionsFor(clientId: string): WebSocketSessionRecord[] | undefined {
    const sessionIds = this.#clientSessions.get(clientId);
    if (!sessionIds) return undefined;
    return [...sessionIds]
      .map((id) => this.#sessions.get(id))
      .filter((session): session is WebSocketSessionRecord => session !== undefined);
  }

  /**

   * Starts closing every active session. / Начинает закрытие всех активных сессий.

   *
   * @param [code=1001] Close code. / Код закрытия.

   * @param [reason='Server shutting down'] Close reason. / Причина закрытия.

   * @private

   */
  closeAll(code = 1001, reason = 'Server shutting down'): void {
    for (const session of this.#sessions.values()) {
      session.connection.close?.(code, reason);
    }
  }
}
/** Connection operations retained by the session store. / Операции соединения в хранилище сессий. @private */
export interface WebSocketSessionConnection {
  send(data: string): boolean;
  close?(code?: number, reason?: string): void;
}

/** Stored WebSocket session. / Сохранённая WebSocket-сессия. @private */
export interface WebSocketSessionRecord {
  clientId: string;
  connection: WebSocketSessionConnection;
  sessionId: string;
}
