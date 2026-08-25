# Daevox Node Framework

Небольшой транспортный фреймворк для Node.js 26 без runtime-зависимостей. Он объединяет декларативные HTTP- и WebSocket-контроллеры, нормализацию HTTP-запросов и ответов и выполнение фоновых задач в пуле `worker_threads`.

## Возможности

- HTTP runtime на `node:http`.
- Встроенный WebSocket-протокол `daevox.v1` с декларативными контроллерами и событиями.
- Декларативная регистрация HTTP-контроллеров и параметризованных HTTP-маршрутов.
- JSON-запросы и нормализованные JSON, текстовые и бинарные HTTP-ответы.
- Отмена операций через `AbortSignal`.
- Ограничение размера тела запроса и корректное завершение работы.
- Фоновые задачи с очередью, тайм-аутами и изоляцией в Worker.
- Нулевые runtime-зависимости.

Проект должен оставаться понятным: прямой код и небольшие модули предпочтительнее универсальных слоёв абстракций.

## Требования

- Node.js 26 или новее.
- npm 12 или новее.

## Быстрый старт

```js
import { Application } from './lib/framework/Application.js';
import { HttpControllerBase } from './lib/framework/HttpControllerBase.js';

class UsersController extends HttpControllerBase {
  static prefix = '/users';

  static routes = [
    { method: 'GET', path: '/', handler: 'list', authentication: false },
    { method: 'GET', path: '/:id', handler: 'getById', authentication: false },
  ];

  async list() {
    return { status: 200, body: { users: [] } };
  }

  async getById(ctx) {
    return { status: 200, body: { id: ctx.params.id } };
  }
}

const application = new Application({
  http: {
    bodyLimit: 1024 * 1024,
    shutdownTimeout: 30_000,
  },
  websocket: { authentication: false },
});

application.registerHttpController(UsersController);
const address = await application.listen({ port: 3000 });
console.log(`Listening on http://${address.address}:${address.port}`);
```

До появления библиотечной точки входа классы публичного API импортируются напрямую из `lib/framework/`.
Подробные контракты публичных и внутренних сущностей собраны в [API-документации](docs/API.md);
HTML-версия находится в [`docs/api/`](docs/api/).

## HTTP-контроллеры и маршруты

`Application.registerHttpController()` принимает класс, напрямую наследующий `HttpControllerBase`. Класс объявляет собственные статические поля `prefix` и `routes`, а каждый указанный HTTP-обработчик должен быть собственным методом его прототипа.

Объявление HTTP-маршрута содержит ровно четыре поля. `authentication` явно выбирает scenario либо отключает Authentication:

```js
{ method: 'GET', path: '/:id', handler: 'getById', authentication: false }
```

После регистрации оно нормализуется с учётом префикса HTTP-контроллера:

```js
{
  method: 'GET',
  path: '/users/:id',
  handler: 'getById',
  controller: UsersController,
  authentication: false,
}
```

HTTP-контроллеры можно регистрировать только до вызова `listen()`. Для каждого найденного HTTP-маршрута приложение создаёт новый экземпляр HTTP-контроллера.

### Контекст HTTP-запроса

HTTP-обработчик получает объект `ctx`:

```js
{
  method,  // HTTP-метод
  path,    // путь запроса
  params,  // параметры HTTP-маршрута
  query,   // URLSearchParams
  headers, // WHATWG Headers
  body,    // разобранное JSON-тело или undefined
  signal,  // AbortSignal запроса
}
```

Непустое тело запроса должно иметь media type `application/json` или `*+json` и кодировку UTF-8. Максимальный размер задаётся опцией `http.bodyLimit`.

### HTTP-ответы и ошибки

HTTP-обработчик возвращает объект со статусом и необязательными WHATWG-заголовками и телом:

```js
return {
  status: 200,
  headers: new Headers({ 'x-result': 'success' }),
  body: { ok: true },
};
```

Поддерживаются JSON-совместимые значения, строки, `Buffer` и `Uint8Array`. Заголовок `content-type` выбирается автоматически, если HTTP-обработчик не указал его явно. Заголовки `content-length`, `transfer-encoding` и `connection` устанавливаются транспортом и не могут быть заданы HTTP-обработчиком.

Для ожидаемой ошибки HTTP-обработчик может выбросить `HttpError`:

```js
import { HttpError } from './lib/framework/errors.js';

throw new HttpError(422, {
  body: { error: 'email is required' },
});
```

Неожиданные ошибки преобразуются в ответ `500`. Опция `http.onError(error, ctx)` позволяет записать их в журнал, не раскрывая детали клиенту.

## Authentication strategies

`createAuthentication()` объединяет именованные strategies в required или optional scenarios. Каждый HTTP-маршрут и WebSocket endpoint явно выбирает scenario либо значение `false`. Required scenario отклоняет полный `abstain`; optional scenario продолжает обработку без `ctx.authSession` и `ctx.webSocket`.

Готовые factories только извлекают credential и делегируют его разрешение пользовательскому callback. Framework не хранит authoritative session state, не проверяет JWT/OIDC и не выдаёт одноразовые ticket.

```js
import { createAuthentication } from './lib/framework/Authentication.js';
import {
  bearerToken,
  cookieSession,
  oneTimeWebSocketTicket,
} from './lib/framework/authenticationStrategies.js';

const authentication = createAuthentication({
  strategies: {
    browserSession: cookieSession({
      cookie: { name: '__Host-session' },
      resolve: (value, { transport, signal }) => sessionStore.resolve(value, { transport, signal }),
    }),
    apiToken: bearerToken({
      verify: (token, { transport, signal }) => tokenProvider.verify(token, { transport, signal }),
    }),
    webSocketTicket: oneTimeWebSocketTicket({
      consume: (ticket, { origin, signal }) => ticketStore.consume(ticket, { origin, signal }),
    }),
  },
  scenarios: {
    browser: { use: ['browserSession'], required: true },
    browserOptional: { use: ['browserSession'], required: false },
    api: { use: ['apiToken'], required: true },
    webSocket: { use: ['webSocketTicket'], required: true },
  },
});

const application = new Application({
  authentication,
  websocket: {
    authentication: 'webSocket',
    allowedOrigins: ['https://app.example.com'],
  },
});
```

Selector каждого HTTP-маршрута также явный:

```js
static routes = [
  {
    method: 'GET',
    path: '/session',
    handler: 'session',
    authentication: 'browserOptional',
  },
  { method: 'GET', path: '/public', handler: 'public', authentication: false },
];
```

`cookieSession` и `bearerToken` работают для HTTP-запросов и WebSocket-handshake. `oneTimeWebSocketTicket` читает только единственный query parameter `ticket` WebSocket-handshake; его однократное атомарное погашение выполняет callback `consume`. Отсутствующий credential даёт `abstain`, а malformed, неизвестный, истёкший или уже использованный credential — `rejected`.

`AuthSession` — подтверждённая общая identity с непрозрачным `authSessionId`. Она не совпадает с `WebSocketSession`, обозначающей одно физическое соединение, и с `WebSocketClient`, являющимся технической стороной этого соединения. Поэтому две вкладки могут иметь разные `sessionId` и `clientId`, но одну `AuthSession`.

### Browser cookie flow и server push

Запустите пример:

```sh
npm run example:websocket
```

Откройте `http://127.0.0.1:3000` в нескольких вкладках и создайте demo session. Пример использует browser cookie для HTTP и WebSocket, optional-маршрут `/session`, required-маршрут `/push/browser` и exact Origin allowlist `http://127.0.0.1:3000`.

Авторизованный HTTP-обработчик получает request-scoped capability:

```js
const result = ctx.webSocket.send({
  controller: 'events',
  event: 'changed',
  body: { revision: 7 },
});
// { matched: 2, queued: 2, dropped: 0 }
```

`matched` — число локальных WebSocket-соединений той же `AuthSession`, `queued` — число принявших frame очередей, `dropped` — число отказавших очередей. `{ matched: 0, queued: 0, dropped: 0 }` является штатным успехом. Результат подтверждает только локальный enqueue: он не обещает доставку или обработку браузером и не меняет HTTP status автоматически.

### Bearer → one-time ticket flow

Тот же пример предоставляет пользовательский issuance-маршрут `/tickets`. Framework проверяет Bearer credential, но ticket создаёт и хранит код приложения:

```js
const response = await fetch('http://127.0.0.1:3000/tickets', {
  method: 'POST',
  headers: { authorization: 'Bearer demo-api-token' },
});
const { ticket } = await response.json();

const socket = new WebSocket(
  `ws://127.0.0.1:3000/websocket?ticket=${encodeURIComponent(ticket)}`,
  'daevox.v1',
);
```

`consume` обязан атомарно удалить ticket; replay и expiry возвращают `rejected`. Server push остаётся локальным, ephemeral и best-effort: authorization policy, distributed fan-out, retries, durable delivery и acknowledgements приложение реализует отдельно.

## WebSocket-протокол daevox.v1

Все WebSocket-соединения используют единый endpoint `/websocket` и обязаны предложить subprotocol `daevox.v1`. Каждое text-сообщение является точным JSON-envelope `{ controller, event, body }`; binary-сообщения не поддерживаются.

`Application.registerWebSocketController()` принимает класс, напрямую наследующий `WebSocketControllerBase`. Контроллер объявляет собственные `static name` и `static events`:

```js
import { WebSocketControllerBase } from './lib/framework/WebSocketControllerBase.js';

class NotificationsController extends WebSocketControllerBase {
  static name = 'notifications';
  static events = [
    { name: 'subscribe', handler: 'subscribe' },
    { name: 'mark_read', handler: 'markRead' },
  ];

  async subscribe(ctx) {
    return { subscribed: ctx.body.topic };
  }

  async markRead() {}
}

application.registerWebSocketController(NotificationsController);
```

Handler получает `{ body, clientId, sessionId, signal, authSession? }`. Для каждого сообщения создаётся новый экземпляр найденного контроллера. Возвращённый plain object автоматически отправляется с исходными `controller/event`; `undefined` означает отсутствие ответа.

```json
{ "controller": "notifications", "event": "subscribe", "body": { "topic": "news" } }
```

Ответ:

```json
{ "controller": "notifications", "event": "subscribe", "body": { "subscribed": "news" } }
```

Endpoint, lifecycle hooks, максимальный размер входящего и исходящего сообщения и обработчик ошибок задаются в конфигурации:

```js
const application = new Application({
  websocket: {
    authentication: false,
    allowedOrigins: ['https://app.example.com'],
    path: '/websocket',
    maxPayload: 1024 * 1024,
    async onConnect(ctx) {
      console.log(ctx.clientId, ctx.sessionId);
    },
    async onDisconnect(ctx) {
      console.log(ctx.code, ctx.reason);
    },
    onError(error, ctx) {
      console.error(error, ctx?.sessionId);
    },
  },
});
```

Фреймворк создаёт новые `clientId` и `sessionId` для каждой сессии. WebSocket endpoint явно выбирает Authentication scenario либо `false`; подтверждённая `AuthSession` передаётся lifecycle hooks и связывает локальные WebSocket-сессии. Browser handshake дополнительно проходит exact `allowedOrigins`. Адресуемые ошибки возвращаются в `body.error.code`: `INVALID_MESSAGE`, `UNKNOWN_CONTROLLER`, `UNKNOWN_EVENT`, `HANDLER_ERROR` или `INVALID_RESPONSE`. Они представлены публичным `WebSocketProtocolError` и также передаются в `websocket.onError`.

## Фоновые задачи

Фоновая задача должна напрямую наследовать `Job`, экспортироваться по умолчанию из собственного ESM-модуля, объявлять `static metaUrl = import.meta.url` и иметь собственный метод `run()`:

```js
import { Job } from './lib/framework/Job.js';

export default class SumJob extends Job {
  static metaUrl = import.meta.url;

  run({ values }) {
    return { sum: values.reduce((sum, value) => sum + value, 0) };
  }
}
```

Экземпляр HTTP-контроллера получает принадлежащий приложению исполнитель задач как `this.jobRunner`:

```js
const result = await this.jobRunner.run(SumJob, ctx.body, {
  signal: ctx.signal,
  timeout: 5_000,
});

return { status: 200, body: result };
```

Payload и результат задачи должны поддерживать алгоритм structured clone. Transferable-объекты пока не поддерживаются.

Пул настраивается при создании приложения:

```js
const application = new Application({
  jobs: {
    poolSize: 4,
    queueSize: 1000,
    defaultTimeout: 10_000,
    terminationGracePeriod: 1_000,
    shutdownTimeout: 30_000,
  },
  websocket: { authentication: false },
});
```

## Жизненный цикл

`Application.listen()` можно вызвать один раз. `Application.close()` прекращает приём новых HTTP-запросов, ожидает активные запросы в пределах `http.shutdownTimeout`, а затем закрывает пул Worker. После закрытия приложение нельзя запустить повторно.

```js
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await application.close();
    process.exitCode = 0;
  });
}
```

## Пример HTTP-запуска задачи

Запустите приложение:

```sh
npm run example:jobs-http
```

В другом терминале отправьте запрос:

```sh
curl -i -X POST http://127.0.0.1:3000/jobs/sum \
  -H 'content-type: application/json' \
  -d '{"values":[1,2,3]}'
```

Успешный ответ содержит `{"sum":6}`.

## Пример WebSocket-приложения

Запустите приложение:

```sh
npm run example:websocket
```

Откройте `http://127.0.0.1:3000`. Страница подключается к `/websocket` с subprotocol `daevox.v1`, отправляет событие `events/echo` и показывает необязательный реактивный ответ с исходным адресом.

## Разработка

```sh
npm install
npm test
npm run test:unit
npm run test:e2e
npm run test:checks
npm run test:coverage
npm run check
npm run docs:build
npm run docs:check
npm run docs:serve
```

`npm test` последовательно запускает unit-тесты из `test/unit/` и e2e-тесты из `test/e2e/`.
`npm run test:checks` отдельно проверяет harness'ы benchmark, fuzz, mutation, soak и stress,
не запуская сами длительные профили. Coverage включает только unit- и e2e-тесты.
`npm run check` выполняет независимые статические проверки: синтаксис, линтинг, форматирование и
актуальность сгенерированной API-документации.

`npm run docs:build` детерминированно пересобирает коммитимые `docs/API.md` и `docs/api/` из
двуязычных JSDoc-комментариев в `lib/framework/`. `npm run docs:check` проверяет JSDoc и актуальность
обоих артефактов без их изменения. `npm run docs:serve` запускает локальный просмотр HTML-версии.

## Архитектура

`Application` служит общей точкой композиции для транспортов фреймворка и владеет жизненным циклом HTTP/WebSocket runtime и исполнителя задач.

1. `Application` регистрирует HTTP- и WebSocket-контроллеры, запускает оба транспорта на одном `node:http` server и координирует завершение работы.
2. Внутренний `HttpRouter` регистрирует и сопоставляет HTTP-маршруты.
3. Внутренние WebSocket transport и session store обслуживают единый endpoint и протокол `daevox.v1`.
4. Внутренний `Job Runner` принимает классы задач и передаёт их в Worker Pool.
5. Внутренний Worker Pool управляет потоками Worker, очередью и завершением задач.

`HttpRouter`, `Job Runner` и Worker Pool не входят в пользовательский публичный API. Принятые архитектурные решения и их обоснования находятся в [`docs/adr/`](docs/adr/).
