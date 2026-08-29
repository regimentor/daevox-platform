---
status: accepted
---

# WebSocket server push из HTTP-контроллеров

HTTP-контроллеры получают узкий application-wide `this.websocket` sender. Он отправляет
сообщения envelope `daevox.v1` по активным WebSocket-сессиям, не раскрывая raw socket или
`WebSocketSessionStore`.

Фреймворк назначает сессии сгенерированный `clientId`, а `onConnect` может вернуть непустую строку
для стабильного прикладного `clientId`. Активный индекс имеет вид `clientId → Set<sessionId>`;
связь с пользовательским `userId` остаётся ответственностью приложения.

`send({ clientId, sessionIds }, { controller, event, body })` синхронен и best-effort. Он возвращает
`{ sent, skipped }`, считает `socket.write() === false` принятой отправкой, дедуплицирует выбранные
сессии и пропускает закрытые или чужие сессии. Неизвестный клиент вызывает
`WebSocketClientNotFoundError`, ошибки target/message — `InvalidWebSocketSendError`. Encoder
проверяет wire-имена, строгую JSON-совместимость и `maxPayload`.

Retry, persistence, acknowledgements, межпроцессная маршрутизация и sender в `Job` не входят в
решение. Асинхронные ошибки socket наблюдаются через `websocket.onError`.
