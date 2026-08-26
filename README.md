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
    { method: 'GET', path: '/', handler: 'list' },
    { method: 'GET', path: '/:id', handler: 'getById' },
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

Объявление HTTP-маршрута содержит обязательные поля `method`, `path` и `handler`, а также может
содержать необязательный массив `middleware`:

```js
{ method: 'GET', path: '/:id', handler: 'getById' }
```

После регистрации оно нормализуется с учётом префикса HTTP-контроллера:

```js
{
  method: 'GET',
  path: '/users/:id',
  handler: 'getById',
  controller: UsersController,
}
```

HTTP-контроллеры можно регистрировать только до вызова `listen()`. Для каждого найденного
HTTP-маршрута приложение создаёт новый экземпляр HTTP-контроллера, только если middleware-цепочка
дошла до HTTP-обработчика.

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
  state,   // изменяемое состояние одного HTTP-запроса
  route,   // замороженные { method, path, handler } найденного HTTP-маршрута
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

## Middleware обработчиков

HTTP- и WebSocket-обработчики используют единый контракт middleware:

```js
async function middleware(ctx, next) {
  // Действия до следующих middleware и обработчика.
  const result = await next();
  // Действия после обработчика в обратном порядке цепочки.
  return result;
}
```

`next()` не принимает аргументов и может быть вызван не более одного раза. Middleware может быть
синхронной или асинхронной, завершить цепочку без `next()` (short-circuit), вернуть исходный
результат либо заменить его. Функция вызывается без прикладного `this`.

Для HTTP три уровня задаются независимо:

```js
import { Application } from './lib/framework/Application.js';
import { HttpControllerBase } from './lib/framework/HttpControllerBase.js';
import { HttpError } from './lib/framework/errors.js';

async function attachRequestId(ctx, next) {
  ctx.state.requestId = crypto.randomUUID();
  const response = await next();
  response.headers ??= new Headers();
  response.headers.set('x-request-id', ctx.state.requestId);
  return response;
}

function requireAuthentication(ctx, next) {
  if (!ctx.headers.has('authorization')) {
    return { status: 401, body: { error: 'Unauthorized' } };
  }
  ctx.state.role = ctx.headers.get('x-role');
  return next();
}

function requireAdmin(ctx, next) {
  if (ctx.state.role !== 'admin') throw new HttpError(403);
  return next();
}

class UsersController extends HttpControllerBase {
  static prefix = '/users';
  static middleware = [requireAuthentication];
  static routes = [
    {
      method: 'DELETE',
      path: '/:id',
      handler: 'deleteById',
      middleware: [requireAdmin],
    },
  ];

  async deleteById(ctx) {
    return { status: 204 };
  }
}

const application = new Application({
  http: { middleware: [attachRequestId] },
});
```

Цепочка HTTP-запроса выполняется как `http.middleware → HttpController.middleware →
HttpRoute.middleware → HttpHandler`, после чего разворачивается обратно. Новый объект `ctx.state`
с null prototype принадлежит одному HTTP-запросу. Замороженный `ctx.route` содержит объявленные
`{ method, path, handler }`; `ctx.method` и `ctx.path` по-прежнему описывают фактический запрос.
Middleware не вызываются для ошибок, возникших до успешного поиска HTTP-маршрута и разбора тела.

Для сообщений WebSocket используются те же три уровня:

```js
import { Application } from './lib/framework/Application.js';
import { WebSocketControllerBase } from './lib/framework/WebSocketControllerBase.js';
import { WebSocketEventError } from './lib/framework/errors.js';

function countMessages(ctx, next) {
  ctx.state.messageCount = (ctx.state.messageCount ?? 0) + 1;
  return next();
}

function requireAuthentication(ctx, next) {
  if (!ctx.state.auth) throw new WebSocketEventError('UNAUTHORIZED');
  return next();
}

function requireTopic(ctx, next) {
  if (typeof ctx.body.topic !== 'string') {
    throw new WebSocketEventError('INVALID_TOPIC');
  }
  return next();
}

class NotificationsController extends WebSocketControllerBase {
  static name = 'notifications';
  static middleware = [requireAuthentication];
  static events = [
    {
      name: 'subscribe',
      handler: 'subscribe',
      middleware: [requireTopic],
    },
  ];

  subscribe(ctx) {
    return { topic: ctx.body.topic, messageCount: ctx.state.messageCount };
  }
}

const application = new Application({
  websocket: { middleware: [countMessages] },
});
```

Порядок — `websocket.middleware → WebSocketController.middleware → WebSocketEvent.middleware →
handler` и обратное разворачивание. Контекст сообщения содержит `controller`, `event` и
session-scoped `state`. Одна ссылка `state` доступна в `onConnect`, во всех сообщениях сессии, в
`onDisconnect` и в контексте ошибок известной сессии; разные сессии получают разные объекты.
Middleware не вызываются для неверного envelope, неизвестного WebSocket-контроллера или события.

Массивы middleware строго проверяются и копируются при создании `Application` или регистрации
контроллера. Повторный `next()` создаёт публичный `MiddlewareExecutionError` и обрабатывается как
неожиданная ошибка транспорта. В HTTP ожидаемый отказ выражается `HttpError`, а прочие ошибки дают
`500` и передаются в `http.onError`. В WebSocket `WebSocketEventError` возвращает прикладной
`body.error.code` без вызова `websocket.onError`; прочие ошибки возвращают `HANDLER_ERROR`,
наблюдаются через `websocket.onError` и не закрывают сессию.

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

Handler получает `{ body, clientId, sessionId, controller, event, signal, state }`. Для каждого
сообщения создаётся новый экземпляр найденного контроллера, только если middleware-цепочка дошла до
handler. Возвращённый plain object автоматически отправляется с исходными `controller/event`;
`undefined` означает отсутствие ответа.

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

Фреймворк создаёт новые `clientId` и `sessionId` для каждой сессии. Встроенная авторизация,
объединение сессий пользователя и server push в `daevox.v1` отсутствуют. Адресуемые ошибки
фреймворка возвращаются в `body.error.code`: `INVALID_MESSAGE`, `UNKNOWN_CONTROLLER`,
`UNKNOWN_EVENT`, `HANDLER_ERROR` или `INVALID_RESPONSE`. Они представлены публичным
`WebSocketProtocolError` и также передаются в `websocket.onError`.

Прикладную аутентификацию можно выполнить один раз в глобальном `onConnect`. Проверка JWT остаётся
кодом приложения и не добавляет зависимости фреймворку:

```js
const application = new Application({
  websocket: {
    async onConnect(ctx) {
      const token = readBearerToken(ctx.headers);
      if (!token) {
        throw new HttpError(401, {
          headers: new Headers({ 'www-authenticate': 'Bearer' }),
          body: { error: 'Unauthorized' },
        });
      }

      const claims = await verifyJwt(token);
      ctx.state.auth = { subjectId: claims.sub, roles: claims.roles ?? [] };
    },
  },
});
```

`HttpError` из `onConnect` отклоняет HTTP handshake заданным статусом, заголовками и телом без
вызова `websocket.onError`. Любая другая ошибка даёт безопасный `500` и передаётся в `onError`.
`onConnect` и `onDisconnect` остаются одиночными lifecycle callbacks; `connectionMiddleware` не
поддерживается.

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

## Пример аутентификации и авторизации через middleware

Запустите приложение:

```sh
npm run example:middleware-auth
```

Application-level middleware распознаёт демонстрационный Bearer-токен и сохраняет principal в
`ctx.state.auth`. Controller-level middleware требует аутентификацию, а route-level middleware
разрешает `/auth/admin` только роли `admin`.

```sh
# Аутентифицированный пользователь: 200
curl -i http://127.0.0.1:3000/auth/profile \
  -H 'authorization: Bearer user-token'

# Аутентифицирован, но не авторизован: 403
curl -i http://127.0.0.1:3000/auth/admin \
  -H 'authorization: Bearer user-token'

# Аутентифицирован и авторизован: 200
curl -i http://127.0.0.1:3000/auth/admin \
  -H 'authorization: Bearer admin-token'
```

Запрос без токена или с неизвестным токеном получает `401` и заголовок `WWW-Authenticate`.

Black-box тест внутри примера проверяет анонимный запрос, неизвестный токен, обычного пользователя
и пользователя с ролью `admin`:

```sh
npm run example:middleware-auth:test
```

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
