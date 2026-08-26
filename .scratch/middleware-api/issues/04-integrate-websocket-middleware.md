Status: ready-for-agent
Blocked by: 02

# Интегрировать middleware в WebSocket transport

Добавить application-, controller- и event-level middleware в выполнение сообщений
WebSocket-протокола и связать состояние с lifecycle сессии согласно [`../spec.md`](../spec.md).

## Требования

- Работать через TDD и писать исходный код и тесты только в `.js`.
- Добавить строгую опцию `websocket.middleware` с проверкой и снимком массива при создании
  `Application`; `connectionMiddleware` не добавлять.
- Добавить необязательное `static middleware` в контракт WebSocket-контроллера и проверять его
  атомарно при регистрации.
- Расширить декларацию WebSocket-события необязательным `middleware`, сохранив строгую форму,
  атомарность и снимки метаданных.
- Создавать `ctx.state` с null prototype до `onConnect` и передавать одну ссылку в `onConnect`, все
  middleware и обработчики сообщений, error contexts известной сессии и `onDisconnect`.
- Добавить `controller` и `event` в контекст middleware и обработчика WebSocket-события.
- Выполнять цепочку в порядке application → controller → event → WebSocket handler.
- Выполнять окончательную проверку и кодирование результата один раз после завершения цепочки.
- Преобразовывать `WebSocketEventError` в адресуемый `body.error.code`, не вызывать
  `websocket.onError` и сохранять сессию открытой.
- Преобразовывать произвольную ошибку middleware в `HANDLER_ERROR`, передавать исходную ошибку в
  `websocket.onError` и продолжать очередь следующих сообщений.
- Обрабатывать `HttpError` из `onConnect` как ожидаемый отказ handshake с указанным HTTP-статусом,
  заголовками и телом; остальные ошибки `onConnect` сохраняют семантику `500` и `onError`.
- Добавить двуязычный JSDoc с `@public`/`@private` для всего изменённого production-кода.

## Критерии приёмки

- Integration-тесты доказывают порядок трёх уровней и обратное разворачивание цепочки.
- Middleware не вызываются для невалидного envelope, неизвестного контроллера или события.
- `state` сохраняется между сообщениями одной сессии и изолирован между разными сессиями.
- `onConnect` и `onDisconnect` вызываются по одному разу и получают тот же `state`.
- Ошибка middleware одного события не закрывает WebSocket-сессию, не останавливает её очередь и не
  влияет на другие сессии.
- `WebSocketEventError` возвращает прикладной код без `websocket.onError`.
- `HttpError(401)` из `onConnect` отклоняет handshake как `401`, а сессия не появляется в
  `WebSocketSessionStore`.
- `npm run docs:build` и WebSocket unit/integration-тесты завершаются успешно.

## Comments

