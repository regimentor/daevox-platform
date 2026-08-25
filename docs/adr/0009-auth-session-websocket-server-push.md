---
status: accepted
---

# Сессия аутентификации и адресный WebSocket server push

HTTP-запрос и WebSocket-соединения связываются отдельной `AuthSession`, подтверждённой одним
пользовательским модулем `Authentication`. Это решение расширяет exact-key декларацию HTTP-маршрута
из ADR 0002 полем `authentication` и заменяет ограничения ADR 0008, исключавшие authentication,
объединение WebSocket-сессий и server push; остальные решения ADR 0002 и ADR 0008 сохраняются.

`Authentication` содержит именованные strategies и scenarios. HTTP-маршрут явно выбирает scenario
полем `authentication`, а WebSocket endpoint — одноимённой настройкой. Strategy получает только
нормализованные handshake/request-данные и возвращает один из результатов `abstain`, `rejected` или
`authenticated`. Scenario продолжает fallback только после `abstain`; `rejected` завершает
authentication. Первая версия не определяет custom scenario, способный изменить это правило.
Результат `authenticated` содержит `AuthSession` со стабильным непрозрачным `authSessionId`,
`principal` и опциональным `expiresAt`.

Framework не поставляет authoritative session store, `AuthSessionAuthority`, stateful revalidation
или distributed revocation. Stateful-аутентификацию пользователь реализует внутри собственной
strategy. Framework также не создаёт guest sessions: если optional scenario завершился `abstain`
или маршрут отключил authentication, `ctx.webSocket` отсутствует.

Авторизованный `HttpRequestContext` получает request-scoped capability `ctx.webSocket`. Её `send()`
принимает envelope `daevox.v1` `{ controller, event, body }` и адресует все активные
`WebSocketSession` той же `AuthSession`; обработчик не передаёт `authSessionId` и не выбирает
конкретное соединение. Application-owned hub хранит двусторонний локальный индекс между
`authSessionId` и `sessionId`, а raw connections остаются приватными. Первая версия выполняет fan-out
только внутри одного экземпляра `Application`.

`send()` имеет ephemeral best-effort семантику и возвращает `{ matched, queued, dropped }`.
`matched: 0` и частичная постановка не меняют HTTP status автоматически, а `queued` не обещает
доставку или обработку браузером. Push не атомарен с изменением business state. Per-connection
byte-based FIFO ограничена настройкой с default `2 * maxPayload`; после `socket.write() === false`
отправка продолжается по `drain`, а переполнение закрывает slow consumer кодом `1013` и учитывает
непоставленное событие в `dropped`.

WebSocket transport проверяет endpoint, Upgrade, subprotocol и exact `Origin` allowlist, затем
выполняет authentication до `101`. После успешной authentication он создаёт connect context с
неизменной `AuthSession`, вызывает `onConnect`, отвечает `101` и только затем регистрирует membership.
`onConnect` не выполняет authentication. Если задан `expiresAt`, framework локально закрывает
соединение кодом `4001` с причиной `Authentication expired`; повторная authentication требует нового
handshake.

## Последствия

- `clientId` и `sessionId` сохраняют транспортный смысл одного соединения и не становятся
  идентичностью пользователя или credential.
- Точная вкладка, account/device/principal-wide fan-out, distributed adapter, durable delivery,
  outbox, periodic revalidation и in-band re-authentication требуют отдельных решений.
- Server push следует использовать как сигнал перечитать authoritative business state, а не как
  единственный источник данных.
