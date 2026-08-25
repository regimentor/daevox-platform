# Связь HTTP-запроса и WebSocket-сессий через AuthSession

## Назначение

Добавить в Daevox единый модуль `Authentication`, который подтверждает общую `AuthSession` для
HTTP-запросов и WebSocket-соединений, и дать авторизованному HTTP-обработчику request-scoped
capability `ctx.webSocket.send()` для best-effort fan-out во все локальные WebSocket-сессии той же
`AuthSession`.

Спецификация следует [ADR 0009](../../docs/adr/0009-auth-session-websocket-server-push.md) и
[исследованию](research.md). Точный исполнимый public contract
должен быть завершён задачей 02 до изменения production-кода.

## Подтверждённые решения

- `AuthSession` отличается от транспортных `WebSocketSession` и `WebSocketClient`; связывающим
  ключом служит только подтверждённый strategy непрозрачный `authSessionId`.
- `Authentication` содержит именованные strategies и декларативные scenarios.
- Strategy получает нормализованные request/handshake-данные без `IncomingMessage`,
  `ServerResponse` и socket и возвращает `abstain`, `rejected` или `authenticated`.
- Scenario продолжает fallback только после `abstain`; `rejected` всегда завершает authentication.
  Custom scenario в первой версии отсутствует.
- HTTP-маршрут и WebSocket endpoint явно выбирают scenario либо явно отключают authentication.
- Required scenario без подтверждённой `AuthSession` отклоняет вход. Optional scenario после
  полного `abstain` продолжает обработку без `AuthSession` и без `ctx.webSocket`.
- HTTP authentication выполняется после сопоставления маршрута, но до чтения body.
- WebSocket transport проверяет handshake и exact Origin allowlist, затем выполняет authentication
  до ответа `101`.
- `onConnect` получает неизменную `AuthSession`; после успешного hook transport отвечает `101` и
  регистрирует membership.
- Application-owned hub хранит двусторонний локальный индекс `authSessionId <-> sessionId`; raw
  connection остаётся приватным.
- `ctx.webSocket.send({ controller, event, body })` адресует все активные WebSocket-сессии текущей
  `AuthSession` и возвращает `{ matched, queued, dropped }`.
- Push использует строгий envelope `daevox.v1`, общий encoder и `maxPayload`, имеет ephemeral
  best-effort семантику и не меняет HTTP status автоматически.
- Каждое соединение имеет ограниченную byte-based FIFO. Default равен `2 * maxPayload`;
  переполнение закрывает slow consumer кодом `1013`, а `socket.write() === false` приостанавливает
  запись до `drain`.
- Локально известный `expiresAt` закрывает WebSocket кодом `4001` с причиной
  `Authentication expired`; новая identity требует нового handshake.
- Первая версия использует только JavaScript `.js`, встроенные API Node.js и не добавляет
  runtime-зависимостей.

## Контракт, завершаемый до реализации

Задача 02 должна добавить сюда точные и проверяемые определения:

- форму конфигурации `Application`, `Authentication`, strategies и scenarios;
- exact-key форму HTTP-маршрута и правила проверки ссылок на scenario;
- полный нормализованный input strategy для HTTP и WebSocket;
- строгую форму `AuthSession` и каждого tagged result;
- HTTP/WS mapping `abstain`, `rejected`, challenge и ошибок strategy;
- названия и валидацию Origin allowlist и лимита исходящей очереди;
- точные connect/disconnect/error contexts и правила timers/cleanup;
- public errors и экспортируемые фабрики;
- callback-контракты `cookieSession`, `bearerToken` и `oneTimeWebSocketTicket`.

## Вне scope

- Authorization policy HTTP-маршрутов и WebSocket-событий.
- Guest sessions и неявно включённый authentication scenario.
- Stateful logout/revocation, generation/version, periodic revalidation и in-band re-authentication.
- Точная вкладка, конкретное соединение, account/device/principal-wide fan-out и глобальный sender.
- Multi-process/multi-node adapter, Redis и distributed invalidation.
- Durable delivery, outbox, acknowledgement, replay и атомарность с business state.

Полный отложенный scope хранится в
[`../../.plans/http-websocket-session-bridge-out-of-scope.md`](../../.plans/http-websocket-session-bridge-out-of-scope.md).

## Общие критерии поставки

- Поведение соответствует ADR 0009 и завершённой спецификации без изменения смысла `clientId` и
  `sessionId`.
- Новые и изменённые `lib/framework/*.js` имеют двуязычный JSDoc с `@public`/`@private`.
- Unit- и integration-тесты не используют фиксированный `sleep` как условие корректности и
  проверяют очистку listeners, timers, sockets и pending promises.
- README и API-документация описывают только фактически реализованный public contract.
- `npm run docs:build`, `npm test` и `npm run check` завершаются успешно.
