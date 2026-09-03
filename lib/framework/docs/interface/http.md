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

class AppState {
  healthStatus() {
    return 'ok';
  }
}

class HealthController extends HttpControllerBase {
  static prefix = '/api';
  static routes = [{ method: 'GET', path: '/health', handler: 'health' }] as const;

  health(appState: AppState) {
    return { status: 200, body: { status: appState.healthStatus() } };
  }
}

const application = new Application({ appState: AppState }).registerHttpController(
  HealthController,
);
const address = await application.listen({ host: '127.0.0.1', port: 0 });
console.log(await (await fetch(`http://${address.address}:${address.port}/api/health`)).json());
await application.close();
```

```sh
node example.ts
```

## Инварианты

- HTTP-контроллер напрямую наследует `HttpControllerBase` и объявляет собственные `prefix`,
  `routes` с `as const` и, при необходимости, `middleware`.
- Регистрация статически связывает literal `handler` с instance-методом и проверяет его AppState,
  `HttpRequestContext` и `HttpResponse`.
- Регистрация строго и атомарно проверяет метаданные, копирует middleware и замораживает каталог до
  начала `listen()`.
- `registerRuntimeHttpController()` применяет те же проверки после успешного запуска приложения и
  публикует маршрут для следующего ingress без перезапуска transport.
- Новый экземпляр HTTP-контроллера создаётся только после успешного сопоставления HTTP-маршрута и
  только если middleware-цепочка дошла до HTTP-обработчика.
- `HttpRequestContext` не раскрывает `IncomingMessage`, `ServerResponse` или socket.
- `ctx.requestBody` предоставляет однократные асинхронные `json()`, `text()`, `bytes()` и
  `formData()`; JSON generic распространяется из `HttpRequestContext<JsonBody, State>`.
- HTTP-маршрут может объявить `body: BodyClass`; собственная `static schema` класса проверяется и
  компилируется атомарно при регистрации, а contract-aware `json()` возвращает точный экземпляр.
- Contract descriptors поддерживают primitives, `null`, вложенные классы, массивы и
  `bodyClass()` для циклов; field/root validators выполняются фазами до materialization.
- Невалидный input даёт ordered RFC 6901 violations в безопасном `400`; malformed validators и
  constructor/property failures остаются наблюдаемыми application bugs `500`.
- Aggregate body limit применяется до middleware, а выбор и разбор representation выполняются
  лениво внутри общей middleware/handler цепочки.
- Формы используют нативные in-memory `FormData`/`File`; `File.name` остаётся недоверенным вводом.
- Результат handler или short-circuit проходит единственную transport-нормализацию `HttpResponse`.
- `HttpError` и `HttpRequestBodyError` являются ожидаемыми отказами; прочие ошибки наблюдаются через
  `http.onError` и дают безопасный `500`.

## Авторитетные решения

- [ADR 0002 — seam HTTP-контроллера и HTTP-маршрутизатора](../adr/0002-controller-and-routing-boundaries.md).
- [ADR 0003 — выполнение handler и lifecycle](../adr/0003-request-execution-and-lifecycle.md).
- [ADR 0005 — транспортно-специализированные контроллеры](../adr/0005-transport-specific-controllers.md).
- [ADR 0009 — middleware handler](../adr/0009-handler-middleware.md).
- [ADR 0016 — классовый контракт JSON-тела](../adr/0016-http-route-json-body-contract.md).

## Проверка через seam

- [`test/unit/application.test.ts`](../../test/unit/application.test.ts) — контракт регистрации.
- [`test/unit/http-transport.test.ts`](../../test/unit/http-transport.test.ts) — реальные HTTP-запросы,
  body, ответы, ошибки и shutdown.
- [`test/unit/http-error.test.ts`](../../test/unit/http-error.test.ts) — публичный `HttpError`.
- [`test/unit/controller-static-types.test.ts`](../../test/unit/controller-static-types.test.ts) —
  статический TypeScript-контракт контроллера.
- [`test/unit/http-route-json-body-contract.test.ts`](../../test/unit/http-route-json-body-contract.test.ts)
  — schema, validators, materialization, limits и reader cache через public seam.
