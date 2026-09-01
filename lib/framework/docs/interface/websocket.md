# WebSocket

WebSocket module обслуживает единый endpoint и протокол `daevox.v1`; контроллеры работают с
нормализованными сообщениями и не получают raw socket.

## Interface

- Generated types: [WebSocket types](../api/Application.md),
  [`WebSocketControllerBase`](../api/WebSocketControllerBase.md),
  [`WebSocketSenderCapability`](../api/capabilities.md#websocketsendercapability),
  [WebSocket message types](../api/WebSocketSender.md), [WebSocket errors](../api/errors.md).
- Пользовательское назначение: [README — протокол daevox.v1](../../README.md#websocket-протокол-daevoxv1).
- Пример: [`examples/websocket/`](../../examples/websocket).

## Сводка из ADR

<!-- adr-contract:websocket.protocol -->

ADR 0007 заменяется встроенным версионированным протоколом `daevox.v1`: все WebSocket-контроллеры публикуются через единый endpoint приложения, а текстовые JSON-сообщения маршрутизируются по обязательной паре `controller` и `event`. Контроллеры объявляют статические `name` и `events`, lifecycle hooks принадлежат конфигурации `Application`, а экземпляр найденного контроллера создаётся для каждого сообщения. Это отказывается от конкурирующей path-based адресации, raw-сообщений и lifecycle-контроллеров в пользу единственного коробочного контракта фреймворка.

## Минимальный runnable пример

```ts
import { Application, WebSocketControllerBase } from '@daevox/framework';

class AppState {
  readonly prefix = 'echo';
}

class EchoController extends WebSocketControllerBase {
  static name = 'echo';
  static events = [{ name: 'message', handler: 'message' }] as const;

  message(appState: AppState, ctx: { body: object }) {
    return { source: appState.prefix, ...ctx.body };
  }
}

const application = new Application({ appState: AppState }).registerWebSocketController(
  EchoController,
);
const address = await application.listen({ host: '127.0.0.1', port: 3000 });
console.log(`ws://${address.address}:${address.port}/ws (subprotocol: daevox.v1)`);
```

Полный black-box запуск клиента и сервера завершается автоматически:

```sh
npm run example:websocket:test
```

## Инварианты

- Клиент согласует subprotocol `daevox.v1`; text envelope имеет точную форму
  `{ controller, event, body }`, binary payload не поддерживается.
- WebSocket-контроллер напрямую наследует `WebSocketControllerBase` и объявляет собственные `name`
  и `events` с `as const`; новый экземпляр создаётся для каждого сообщения после middleware.
- Регистрация статически связывает literal `handler` с instance-методом и проверяет его AppState,
  `WebSocketHandlerContext` и необязательный object-result.
- `registerRuntimeWebSocketController()` публикует новый controller и его события для следующего
  сообщения уже существующей либо новой WebSocket-сессии после успешного startup.
- Сообщения одной сессии выполняются последовательно, разные сессии могут выполняться параллельно.
- `onConnect` может заменить сгенерированный `clientId`; одна ссылка `ctx.state` живёт до
  `onDisconnect`.
- Ответ handler необязателен, наследует адрес входящего сообщения и не имеет correlation ID.
- Server push синхронен и best-effort; `{ sent, skipped }` описывает локальное принятие frame.
- Ожидаемые `WebSocketEventError` сохраняют сессию; неожиданные ошибки наблюдаются через
  `websocket.onError` и изолируются как `HANDLER_ERROR`.

## Авторитетные решения

- [ADR 0008 — протокол сообщений](../adr/0008-websocket-message-protocol.md).
- [ADR 0009 — middleware и состояние сессии](../adr/0009-handler-middleware.md).
- [ADR 0010 — server push](../adr/0010-websocket-server-push.md).
- [ADR 0011 — transport settlement при shutdown](../adr/0011-addressed-application-events.md).

## Проверка через seam

- [`test/unit/websocket-message-transport.test.ts`](../../test/unit/websocket-message-transport.test.ts)
  — handshake, lifecycle, routing, middleware, протокол и shutdown.
- [`test/unit/websocket-protocol.test.ts`](../../test/unit/websocket-protocol.test.ts) — строгий
  envelope и кодирование.
- [`test/unit/websocket-sender.test.ts`](../../test/unit/websocket-sender.test.ts) — server push.
- [`examples/websocket/application.test.ts`](../../examples/websocket/application.test.ts) —
  black-box пример.
