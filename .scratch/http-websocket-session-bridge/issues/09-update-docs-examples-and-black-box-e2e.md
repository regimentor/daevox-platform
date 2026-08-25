Type: task
Status: ready-for-agent
Blocked by: 07, 08

# Обновить документацию, examples и black-box e2e

Завершить пользовательскую поставку актуальной документацией и сквозной проверкой
HTTP → `AuthSession` → WebSocket server push через опубликованный public API.

## Требования

- Обновить README и examples: конфигурация Authentication, выбор scenario на каждом HTTP-маршруте и
  WebSocket endpoint, Origin allowlist, optional route, несколько вкладок, семантика send result и
  ограничения best-effort.
- Показать browser cookie flow и bearer → one-time ticket flow через готовые factories и
  пользовательские callbacks без framework-owned session store.
- Обновить API-документацию через `npm run docs:build`.
- Расширить внешний tarball consumer либо добавить равноценный black-box e2e, использующий только
  опубликованные импорты и реальные HTTP/WebSocket connections.
- В e2e подтвердить одну `AuthSession` через HTTP и два WebSocket-соединения, выполнить HTTP handler
  с `ctx.webSocket.send()` и получить push в обоих соединениях, но не в соединении другой session.
- Проверить rejection, Origin, expiry `4001`, `matched: 0` и полную очистку ресурсов после
  `Application.close()`.
- Оставить детерминированную проверку slow consumer `1013` на самом низком стабильном шве, выбранном
  задачей 04; black-box тест не должен зависеть от неконтролируемого заполнения kernel buffer.

## Критерии приёмки

- Документация и examples используют только реализованный public contract и запускаются указанными
  командами.
- README явно отличает `AuthSession`, `WebSocketSession` и `WebSocketClient`.
- Примеры не обещают authorization, distributed или durable delivery.
- Tarball consumer подтверждает отсутствие внутренних импортов и runtime-зависимостей.
- `npm run docs:build`, `npm test`, `npm run test:e2e` и `npm run check` проходят.

## Comments
