Status: ready-for-agent

# Реализовать отправку WebSocket-сообщений из HTTP-контроллера

## Question

Реализовать согласованный контракт server push из [`../spec.md`](../spec.md): HTTP-контроллер должен отправлять сообщение в одну или несколько активных WebSocket-сессий через узкий `this.websocket` без доступа к raw socket и `WebSocketSessionStore`.

## Требования

- Изменить контракт `websocket.onConnect(ctx)`:
  - принять `undefined` или непустую строку;
  - при `undefined` использовать сгенерированный `ctx.clientId`;
  - зарегистрировать итоговый `clientId` вместе с новым `sessionId`;
  - передавать итоговый `clientId` в WebSocket-контексты и `onDisconnect`;
  - некорректный результат отклонять HTTP 500 и передавать в `websocket.onError`.
- Расширить внутренний `WebSocketSessionStore` индексом `clientId → Set<sessionId>` с корректным удалением сессии при закрытии.
- Добавить узкий sender, инжектируемый только в HTTP-контроллеры как `this.websocket`.
- Реализовать синхронный интерфейс:

  ```js
  websocket.send({ clientId, sessionIds }, { controller, event, body }); // { sent, skipped }
  ```

- При отсутствии `sessionIds` отправлять во все активные сессии `clientId`.
- Пустой `sessionIds` трактовать как отправку в ноль сессий.
- Дедуплицировать `sessionIds`.
- Пропускать закрытые сессии и сессии, не принадлежащие указанному `clientId`.
- Неизвестный `clientId` отклонять публичным `WebSocketClientNotFoundError`.
- Удалять `clientId` из активного индекса после закрытия последней сессии; последующая отправка по нему должна считаться обращением к неизвестному клиенту.
- Неверный target или message отклонять публичным `InvalidWebSocketSendError`.
- Использовать существующий encoder `daevox.v1`, включая wire-валидацию, JSON-совместимость и `maxPayload`.
- Не требовать регистрации исходящего `controller/event` во входном каталоге WebSocket.
- Считать `socket.write() === false` принятым frame; асинхронные socket errors передавать в `websocket.onError`.
- Не добавлять sender в `Job` и не вводить гарантированный порядок между HTTP-отправками и WebSocket-ответами.

## Документация и архитектура

- Добавить следующий ADR с пересмотром положений ADR 0008 о server push и семантике `clientId`.
- Обновить определения `clientId`, `WebSocketSession`, `WebSocketSessionStore` и добавить термин sender в `CONTEXT.md`.
- Обновить README и `docs/API.md` фактическим публичным контрактом.
- Соблюсти двуязычный JSDoc для нового и изменённого production-кода в `lib/framework/*.js`.
- Выполнить `npm run docs:build`.

## Тесты

- `onConnect` с `undefined`, собственным `clientId` и некорректным результатом.
- Несколько сессий с одним `clientId`.
- Fan-out во все сессии.
- Отправка в выбранные сессии, дедупликация и `skipped` для чужих/закрытых сессий.
- Неизвестный `clientId` и некорректные target/message.
- Отправка исходящего события, отсутствующего во входном каталоге.
- Ограничение размера, backpressure и socket close race.
- Доступ sender из HTTP-контроллера и отсутствие sender у `Job`.
- Существующие тесты и `npm run check` должны завершаться успешно.

## Out of scope

- внешний `userId → clientId` store;
- разбор HTTP-session header и авторизация;
- межпроцессная доставка;
- retry, persistence, acknowledgements и отправка из `Job`.

## Comments

Архитектура согласована в grilling-сессии: фреймворк индексирует `clientId → Set<sessionId>`, а приложение самостоятельно поддерживает `userId → clientId`. Server push использует envelope `daevox.v1` и остаётся best-effort.
