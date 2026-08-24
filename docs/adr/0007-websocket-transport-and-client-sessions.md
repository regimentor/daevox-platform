---
status: superseded by ADR-0008
---

# WebSocket transport и клиентские сессии

WebSocket использует отдельный `WebSocketControllerBase` и `registerWebSocketController`, сохраняя принятую транспортную специализацию контроллеров. Один WebSocket-контроллер публикуется по собственному статическому `path` и реализует собственные lifecycle-методы `onConnect`, `onMessage` и `onDisconnect`; экземпляр создаётся для каждого соединения.

`onConnect` выполняет прикладную аутентификацию handshake и возвращает непустой стабильный `clientId`. Фреймворк назначает каждому соединению уникальный `sessionId`. Внутренний `WebSocketSessionStore` индексирует сессии по обоим идентификаторам, поэтому один WebSocket-клиент может одновременно владеть несколькими независимыми сессиями, например несколькими вкладками браузера.

Хранилище не входит в публичный интерфейс. WebSocket-контроллер получает узкий фасад `clientSessions` с групповыми операциями `send`, `count` и `close`; он не получает raw Node.js socket. Lifecycle-контексты содержат нормализованные handshake-данные, идентификаторы и `AbortSignal` сессии.

WebSocket upgrade обслуживается тем же `node:http` server, которым владеет `Application`. `Application.close()` сначала закрывает все WebSocket-сессии кодом `1001`, затем завершает HTTP server и остальные принадлежащие приложению ресурсы. Transport реализуется на встроенных Node.js API без runtime-зависимостей в соответствии с ADR 0001.
