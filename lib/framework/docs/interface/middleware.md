# Middleware handler

Middleware module компонует transport-specific функции `(ctx, next)` вокруг найденного HTTP-handler
или handler WebSocket-события.

## Interface

- Generated types: [`HttpMiddleware`](../api/Application.md#httpmiddleware),
  [`WebSocketMessageMiddleware`](../api/Application.md#websocketmessagemiddleware),
  [`MiddlewareExecutionError`](../api/errors.md#middlewareexecutionerror).
- Пользовательское назначение: [README — middleware](../../README.md#middleware-обработчиков).
- Пример: [`examples/middleware-auth/`](../../examples/middleware-auth).

## Сводка из ADR

<!-- adr-contract:middleware.handler-chain -->

`Application` поддерживает единый контракт middleware `(ctx, next)` для выполнения найденных
HTTP-обработчиков и обработчиков WebSocket-событий. Middleware может выполнить действия до и после
`await next()`, завершить цепочку без вызова `next()` и вернуть результат того же контракта, что и
соответствующий обработчик. Один переданный вызову middleware `next()` разрешено вызвать не более
одного раза; нарушение представлено публичным `MiddlewareExecutionError`. Общий внутренний модуль
композиции возвращает окончательный результат без транспортной нормализации и не перехватывает
ошибки окончательно.

## Минимальный runnable пример

```ts
import { Application, type HttpMiddleware } from '@daevox/framework';

class AppState {}

const requireToken: HttpMiddleware<AppState> = (_appState, ctx, next) => {
  if (ctx.headers.get('authorization') !== 'Bearer demo') {
    return { status: 401, body: { error: 'Unauthorized' } };
  }
  return next();
};

const application = new Application({
  appState: AppState,
  http: { middleware: [requireToken] },
});
```

Полный black-box пример:

```sh
npm run example:middleware-auth:test
```

## Инварианты

- `next()` не принимает аргументов и вызывается не более одного раза одним middleware.
- Middleware может выполнить работу до/после `next()`, short-circuit без handler или заменить
  возвращаемый результат.
- Порядок уровней: application transport → controller → handler declaration → handler; после
  `next()` цепочка разворачивается обратно.
- HTTP- и WebSocket-массивы независимы, проверяются и копируются при конфигурации или регистрации.
- Generic middleware получает конкретный AppState, выведенный `Application`; middleware с default
  `AppStateInstance` остаётся применимо к конкретному прикладному состоянию.
- Middleware запускается только после успешной transport-маршрутизации; инфраструктурные ошибки до
  seam через него не проходят.
- HTTP `ctx.state` живёт один запрос; WebSocket `ctx.state` — одну сессию от `onConnect` до
  `onDisconnect`.
- HTTP unexpected error становится `500`; WebSocket unexpected error становится `HANDLER_ERROR` и
  сохраняет очередь сессии.
- Connection middleware, Job middleware и EventListener middleware отсутствуют.

## Авторитетное решение

- [ADR 0009 — middleware HTTP- и WebSocket-handler](../adr/0009-handler-middleware.md).

## Проверка через seam

- [`test/unit/middleware.test.ts`](../../test/unit/middleware.test.ts) — композиция и вызов `next()`.
- [`test/unit/http-transport.test.ts`](../../test/unit/http-transport.test.ts) — HTTP-уровни,
  short-circuit, state и ошибки.
- [`test/unit/websocket-message-transport.test.ts`](../../test/unit/websocket-message-transport.test.ts)
  — WebSocket-уровни, session state и error isolation.
- [`examples/middleware-auth/authorization.test.ts`](../../examples/middleware-auth/authorization.test.ts)
  — black-box авторизация.
