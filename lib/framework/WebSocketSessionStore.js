export class WebSocketSessionStore {
  #sessions = new Map();

  add(clientId, connection, sessionId) {
    const session = { clientId, connection, sessionId };
    this.#sessions.set(sessionId, session);
    return sessionId;
  }

  remove(sessionId) {
    const session = this.#sessions.get(sessionId);
    if (!session) return false;
    this.#sessions.delete(sessionId);
    return true;
  }

  closeAll(code = 1001, reason = 'Server shutting down') {
    for (const session of this.#sessions.values()) {
      session.connection.close(code, reason);
    }
  }
}
