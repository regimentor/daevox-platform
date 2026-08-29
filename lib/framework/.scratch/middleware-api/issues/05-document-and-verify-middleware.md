Status: resolved
Blocked by: 03, 04

# Документировать и проверить middleware end-to-end

Завершить публичную документацию и сквозную проверку реализованного middleware-контракта согласно
[`../spec.md`](../spec.md).

## Требования

- Обновить `README.md`: application-, controller- и handler-level примеры для обоих транспортов,
  порядок выполнения, short-circuit и error modes.
- Документировать `ctx.state`, `ctx.route`, `ctx.controller` и `ctx.event`, включая различное время
  жизни HTTP- и WebSocket-state.
- Документировать JWT-подобную аутентификацию WebSocket через единственный глобальный `onConnect`,
  не добавляя runtime-зависимость или встроенную JWT-реализацию.
- Документировать `MiddlewareExecutionError`, `WebSocketEventError` и применение `HttpError` в
  `onConnect`.
- Обновить HTTP- и WebSocket-примеры минимальными middleware-сценариями без server push и индекса
  пользовательских сессий.
- Добавить или расширить black-box проверку публичных импортов и поведения через реальные HTTP- и
  WebSocket-соединения.
- Убедиться, что сгенерированная документация соответствует двуязычному JSDoc production-кода.

## Критерии приёмки

- Пользователь может реализовать application-, controller- и handler-level middleware только по
  README и публичным импортам.
- Сквозной тест подтверждает short-circuit и изоляцию произвольных ошибок для HTTP и WebSocket.
- Сквозной тест подтверждает сохранение WebSocket-сессии после `HANDLER_ERROR`.
- Документация не обещает server push, поиск пользователя или распределённое хранение сессий.
- Все исходные и тестовые файлы имеют расширение `.js`; runtime-зависимости не добавлены.
- `npm run docs:build` и полный `npm run check` завершаются успешно.

## Comments

README, примеры, публичные импорты и сквозные HTTP/WebSocket-сценарии обновлены. Markdown/HTML API,
`npm run check` и полный `npm test` успешно проверены перед передачей на человеческое ревью.
