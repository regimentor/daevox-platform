# HTTP

HTTP module публикует декларативные HTTP-маршруты через `HttpControllerBase`; transport objects
Node.js остаются внутри implementation.

## Interface

- Generated types: [`Application` HTTP types](../api/Application.md),
  [`HttpControllerBase`](../api/HttpControllerBase.md),
  [injected capabilities](../api/capabilities.md), [HTTP errors](../api/errors.md).
- Пользовательское назначение: [README — HTTP-контроллеры и маршруты](../../README.md#http-контроллеры-и-маршруты).
- Пример: [`examples/jobs-http/`](../../examples/jobs-http).

## Сводка из ADR

<!-- adr-contract:http.controller-boundary -->

HTTP-контроллеры публикуют статические декларативные метаданные HTTP-маршрутов, доступные без создания экземпляра. HTTP-маршрут ссылается на HTTP-обработчик по имени метода и не содержит `execution`, `moduleUrl`, `exportName` или иных worker metadata; экземпляр HTTP-контроллера создаётся только после нахождения HTTP-маршрута. `HttpRouter` только регистрирует и сопоставляет HTTP-маршруты: он не выполняет HTTP-обработчик и не записывает HTTP-ответ.

## Минимальный runnable пример

```ts
import { Application, HttpControllerBase } from '@daevox/framework';

class HealthController extends HttpControllerBase {
  static prefix = '/api';
  static routes = [{ method: 'GET', path: '/health', handler: 'health' }];

  health() {
    return { status: 200, body: { ok: true } };
  }
}

const application = new Application().registerHttpController(HealthController);
const address = await application.listen({ host: '127.0.0.1', port: 0 });
console.log(await (await fetch(`http://${address.address}:${address.port}/api/health`)).json());
await application.close();
```

```sh
node example.ts
```

## Инварианты

- HTTP-контроллер напрямую наследует `HttpControllerBase` и объявляет собственные `prefix`,
  `routes` и, при необходимости, `middleware`.
- Регистрация строго и атомарно проверяет метаданные, копирует middleware и замораживает каталог до
  начала `listen()`.
- Новый экземпляр HTTP-контроллера создаётся только после успешного сопоставления HTTP-маршрута и
  только если middleware-цепочка дошла до HTTP-обработчика.
- `HttpRequestContext` не раскрывает `IncomingMessage`, `ServerResponse` или socket.
- Результат handler или short-circuit проходит единственную transport-нормализацию `HttpResponse`.
- `HttpError` является ожидаемым отказом; прочие ошибки наблюдаются через `http.onError` и дают
  безопасный `500`.

## Авторитетные решения

- [ADR 0002 — seam HTTP-контроллера и HTTP-маршрутизатора](../adr/0002-controller-and-routing-boundaries.md).
- [ADR 0003 — выполнение handler и lifecycle](../adr/0003-request-execution-and-lifecycle.md).
- [ADR 0005 — транспортно-специализированные контроллеры](../adr/0005-transport-specific-controllers.md).
- [ADR 0009 — middleware handler](../adr/0009-handler-middleware.md).

## Проверка через seam

- [`test/unit/application.test.ts`](../../test/unit/application.test.ts) — контракт регистрации.
- [`test/unit/http-transport.test.ts`](../../test/unit/http-transport.test.ts) — реальные HTTP-запросы,
  body, ответы, ошибки и shutdown.
- [`test/unit/http-error.test.ts`](../../test/unit/http-error.test.ts) — публичный `HttpError`.
- [`test/unit/controller-static-types.test.ts`](../../test/unit/controller-static-types.test.ts) —
  статический TypeScript-контракт контроллера.
