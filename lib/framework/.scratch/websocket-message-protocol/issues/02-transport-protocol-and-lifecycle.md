Status: resolved

# Реализовать transport протокола daevox.v1 и lifecycle hooks

Перевести WebSocket transport на единый endpoint, обязательный subprotocol и строгий JSON-envelope согласно [`../spec.md`](../spec.md).

## Требования

- Добавить `websocket.path`, `onConnect` и `onDisconnect` в строгую конфигурацию приложения.
- Реализовать handshake с обязательным `Sec-WebSocket-Protocol: daevox.v1`.
- Создавать разные UUID v4 `clientId/sessionId`, связывать их с принятой сессией и передавать hooks.
- Реализовать строгую рекурсивную JSON-валидацию без тихих преобразований.
- Реализовать необязательный реактивный ответ с исходными `controller/event`.
- Реализовать error envelopes, `WebSocketProtocolError`, close codes и двусторонний `maxPayload`.
- Сохранить последовательный порядок сообщений одной сессии и корректный shutdown.
- Покрыть handshake, hooks, сообщения, ошибки, лимиты и shutdown integration-тестами в `.js`.

## Критерии приёмки

- Transport принимает только text JSON-envelope точной формы и никогда не передаёт raw frame handler.
- Все стабильные error codes и close codes соответствуют спецификации и не раскрывают внутренние ошибки.
- Ошибка одного адресуемого сообщения не закрывает соединение и не останавливает очередь.
- Авторизация и server push не появляются в публичном API.
- `npm run check` завершается успешно.

## Comments

Реализовано через TDD: единый endpoint и `daevox.v1`, lifecycle hooks, UUID сессии и клиента, строгий JSON-envelope, последовательная диспетчеризация, error envelopes, close codes, двусторонний `maxPayload` и ожидание асинхронного `onDisconnect` при shutdown.
