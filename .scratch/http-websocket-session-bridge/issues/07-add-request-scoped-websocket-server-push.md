Type: task
Status: ready-for-agent
Blocked by: 05, 06

# Добавить request-scoped WebSocket server push

Дать авторизованному HTTP-обработчику `ctx.webSocket.send()`, который отправляет один envelope всем
активным локальным WebSocket-сессиям той же `AuthSession`.

## Требования

- Создавать immutable `ctx.webSocket` только для HTTP-запроса с подтверждённой `AuthSession`.
- Не принимать `authSessionId`, `sessionId`, `clientId` или иной адрес получателя в public sender.
- Принимать точный `{ controller, event, body }`, валидировать и сериализовать его общим encoder
  `daevox.v1` до начала fan-out с тем же `maxPayload`.
- Выполнять snapshot/итерацию membership безопасно при конкурентном close и не удерживать закрытые
  connections.
- Отправлять во все активные соединения текущего `authSessionId`, включая несколько вкладок, и ни в
  одно соединение другой session.
- Возвращать точный `{ matched, queued, dropped }`; `matched: 0` считать штатным исходом.
- Считать результат только постановкой в локальную очередь, не обещать browser delivery и не менять
  HTTP status автоматически.
- Гарантировать, что invalid envelope не приводит к частичному fan-out.
- Не добавлять глобальный sender, выбор конкретной вкладки, distributed adapter, retries или durable
  delivery.
- Добавить unit- и integration-тесты на ноль/одно/несколько соединений, изоляцию sessions,
  частичный close, queue overflow, invalid/oversized envelope и конкурентные send/close.

## Критерии приёмки

- Capability одного HTTP-запроса технически не может адресовать чужой `authSessionId`.
- Все matched connections получают одинаково сериализованный envelope в своей FIFO.
- `queued` и `dropped` отражают enqueue, а не сетевую или browser delivery.
- Ошибка валидации возникает до первой постановки; частичный результат возможен только из-за
  состояния отдельных connection queues.
- Production-код имеет двуязычный JSDoc; `npm run docs:build`, `npm test` и `npm run check` проходят.

## Comments
