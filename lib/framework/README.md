# Daevox Node Framework

Небольшой транспортный фреймворк для Node.js 26 без runtime-зависимостей. Он объединяет декларативные HTTP- и WebSocket-контроллеры, нормализацию HTTP-запросов и ответов и выполнение фоновых задач в пуле `worker_threads`.

## Возможности

- HTTP runtime на `node:http`.
- Встроенный WebSocket-протокол `daevox.v1` с декларативными контроллерами и событиями.
- Адресуемые fire-and-forget события приложения с FIFO mailbox для каждого listener.
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

Рукописный код проекта использует нативный TypeScript: Node.js запускает `.ts` напрямую встроенным
type stripping, без loader, transpilation или emit. TypeScript 7 нужен только для `npm run typecheck`
и поддержки редактора. Рабочий сценарий — запуск из checkout; публикация и исполнение пакета из
`node_modules` временно не поддерживаются.

## Быстрый старт

```ts
import { Application, HttpControllerBase } from '@daevox/framework';

class AppState {
  currentSubject() {
    return 'anonymous';
  }
}

class UsersController extends HttpControllerBase {
  static prefix = '/users';

  static routes = [
    { method: 'GET', path: '/', handler: 'list' },
    { method: 'GET', path: '/:id', handler: 'getById' },
  ] as const;

  async list(appState, _ctx) {
    return { status: 200, body: { subject: appState.currentSubject(), users: [] } };
  }

  async getById(_appState, ctx) {
    return { status: 200, body: { id: ctx.params.id } };
  }
}

const application = new Application({
  appState: AppState,
  http: {
    bodyLimit: 1024 * 1024,
    shutdownTimeout: 30_000,
  },
});

application.registerHttpController(UsersController);
const address = await application.listen({ port: 3000 });
console.log(`Listening on http://${address.address}:${address.port}`);
```

Явные экспорты [`src/index.ts`](src/index.ts) образуют библиотечную точку входа и окончательно
определяют состав поддерживаемого public interface для запуска из checkout. Подробные публичные
контракты собраны по исходным модулям в
[API-документации](docs/API.md). Поведенческие инварианты, связанные ADR, примеры и seam-тесты
собраны в [карте interface фреймворка](docs/interface/README.md).

Полный пример runtime-регистрации HTTP-, WebSocket- и event-ресурсов находится в
[`examples/runtime-registration/`](examples/runtime-registration/). Его тест запускается командой
`npm run example:runtime-registration:test --workspace @daevox/framework`.

## HTTP-контроллеры и маршруты

`Application.registerHttpController()` принимает класс, напрямую наследующий `HttpControllerBase`. Класс объявляет собственные статические поля `prefix` и `routes`, а каждый указанный HTTP-обработчик должен быть собственным методом его прототипа.

После успешного `listen()` и завершения `onAppStart()` новый HTTP-контроллер можно синхронно
добавить через `registerRuntimeHttpController()`; аналогичные runtime-методы существуют для
WebSocket-контроллеров и слушателей внутренних событий.
TypeScript проверяет наличие и форму `prefix`, `routes` и необязательного `middleware` в точке
регистрации. Для статической проверки строковых имён handler массив `routes` объявляется с
`as const`: регистрация отклоняет отсутствующий instance-метод, несовместимые AppState/context и
неверный результат. Runtime дополнительно проверяет, что поля собственные, метаданные точные, а
обработчики действительно объявлены классом.

Объявление HTTP-маршрута содержит обязательные поля `method`, `path` и `handler`, а также может
содержать необязательный массив `middleware`:

```ts
{ method: 'GET', path: '/:id', handler: 'getById' }
```

После регистрации оно нормализуется с учётом префикса HTTP-контроллера:

```ts
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

`Application` принимает обязательный класс `appState` и создаёт ровно один его экземпляр. Этот
экземпляр передаётся первым аргументом HTTP- и WebSocket-middleware, обработчикам, lifecycle
callbacks транспорта и `onError`. Обработчики получают `(appState, ctx)`, middleware —
`(appState, ctx, next)`, а `ctx.state` остаётся локальным состоянием запроса или WebSocket-сессии.
Методы `beforeAppStart`, `onAppStart` и `onAppClose` могут быть синхронными или асинхронными.
Конкретный тип экземпляра выводится из `new Application({ appState: AppState })` и сохраняется во
всех HTTP- и WebSocket-seams. Прикладной класс не обязан наследоваться от framework-класса или
объявлять lifecycle hooks; публичные generic-типы без аргумента используют `AppStateInstance`.

Каждый HTTP-контроллер получает `this.websocket` — узкий application-wide sender для server push:

```ts
const result = this.websocket.send(
  { clientId, sessionIds },
  { controller: 'notifications', event: 'updated', body: { id: 42 } },
);
// { sent, skipped }
```

Без `sessionIds` сообщение отправляется во все активные сессии `clientId`; пустой массив ничего
не отправляет. Дубликаты устраняются, закрытые и чужие сессии учитываются в `skipped`. Неизвестный
`clientId` вызывает `WebSocketClientNotFoundError`, а неверная цель или сообщение —
`InvalidWebSocketSendError`. Отправка синхронна и best-effort: `sent` означает принятие frame
локальным socket для записи.

### Контекст HTTP-запроса

HTTP-обработчик получает объект `ctx`:

```ts
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

```ts
return {
  status: 200,
  headers: new Headers({ 'x-result': 'success' }),
  body: { ok: true },
};
```

Поддерживаются JSON-совместимые значения, строки, `Buffer` и `Uint8Array`. Заголовок `content-type` выбирается автоматически, если HTTP-обработчик не указал его явно. Заголовки `content-length`, `transfer-encoding` и `connection` устанавливаются транспортом и не могут быть заданы HTTP-обработчиком.

Для ожидаемой ошибки HTTP-обработчик может выбросить `HttpError`:

```ts
import { HttpError } from '@daevox/framework';

throw new HttpError(422, {
  body: { error: 'email is required' },
});
```

Неожиданные ошибки преобразуются в ответ `500`. Опция `http.onError(error, ctx)` позволяет записать их в журнал, не раскрывая детали клиенту.

## Middleware обработчиков

HTTP- и WebSocket-обработчики используют единый контракт middleware:

```ts
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

```ts
import { Application, HttpControllerBase, HttpError } from '@daevox/framework';

async function attachRequestId(_appState, ctx, next) {
  ctx.state.requestId = crypto.randomUUID();
  const response = await next();
  response.headers ??= new Headers();
  response.headers.set('x-request-id', ctx.state.requestId);
  return response;
}

function requireAuthentication(_appState, ctx, next) {
  if (!ctx.headers.has('authorization')) {
    return { status: 401, body: { error: 'Unauthorized' } };
  }
  ctx.state.role = ctx.headers.get('x-role');
  return next();
}

function requireAdmin(_appState, ctx, next) {
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
  ] as const;

  async deleteById(_appState, ctx) {
    return { status: 204 };
  }
}

const application = new Application({
  appState: AppState,
  http: { middleware: [attachRequestId] },
});
```

Цепочка HTTP-запроса выполняется как `http.middleware → HttpController.middleware →
HttpRoute.middleware → HttpHandler`, после чего разворачивается обратно. Новый объект `ctx.state`
с null prototype принадлежит одному HTTP-запросу. Замороженный `ctx.route` содержит объявленные
`{ method, path, handler }`; `ctx.method` и `ctx.path` по-прежнему описывают фактический запрос.
Middleware не вызываются для ошибок, возникших до успешного поиска HTTP-маршрута и разбора тела.

Для сообщений WebSocket используются те же три уровня:

```ts
import { Application, WebSocketControllerBase, WebSocketEventError } from '@daevox/framework';

function countMessages(_appState, ctx, next) {
  ctx.state.messageCount = (ctx.state.messageCount ?? 0) + 1;
  return next();
}

function requireAuthentication(_appState, ctx, next) {
  if (!ctx.state.auth) throw new WebSocketEventError('UNAUTHORIZED');
  return next();
}

function requireTopic(_appState, ctx, next) {
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
  ] as const;

  subscribe(_appState, ctx) {
    return { topic: ctx.body.topic, messageCount: ctx.state.messageCount };
  }
}

const application = new Application({
  appState: AppState,
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

`Application.registerWebSocketController()` принимает класс, напрямую наследующий `WebSocketControllerBase`. Контроллер объявляет собственные `static name` и `static events`.
TypeScript проверяет форму `name`, `events` и необязательного `middleware` в точке регистрации;
`events` с `as const` также связывает строковый handler с совместимым instance-методом. Проверка
собственных полей и wire-имён остаётся runtime-инвариантом.

Пример:

```ts
import { WebSocketControllerBase } from '@daevox/framework';

class NotificationsController extends WebSocketControllerBase {
  static name = 'notifications';
  static events = [
    { name: 'subscribe', handler: 'subscribe' },
    { name: 'mark_read', handler: 'markRead' },
  ] as const;

  async subscribe(_appState, ctx) {
    return { subscribed: ctx.body.topic };
  }

  async markRead(_appState, _ctx) {}
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

`onConnect` получает сгенерированный `ctx.clientId` и может вернуть непустую строку стабильного
прикладного идентификатора; `undefined` сохраняет сгенерированный идентификатор. Итоговый
идентификатор доступен в контекстах WebSocket и `onDisconnect`. Несколько сессий могут использовать
один `clientId`.

```ts
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

```ts
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

## Внутренние события приложения

Адрес `{ listener, event }` выбирает ровно один handler одного `EventListener`; механизм не является
pub/sub и не выполняет fan-out. DTO — обычный прикладной класс без базового класса фреймворка:

```ts
import { EventListenerBase } from '@daevox/framework';

class OrderCreated {
  constructor(orderId) {
    this.orderId = orderId;
  }
}

class AuditEventListener extends EventListenerBase {
  static name = 'audit';
  static events = [{ name: 'OrderCreated', data: OrderCreated, handler: 'orderCreated' }] as const;

  async orderCreated(appState, data, { signal }) {
    console.log('order created', appState, data.orderId);
    // CPU-heavy работу следует явно передавать в this.jobRunner.
    // await this.jobRunner.run(AuditJob, data, { signal });
  }
}

application.registerEventListener(AuditEventListener);
```

Handler получает тот же экземпляр `AppState`, который передаётся HTTP- и WebSocket-handler:
`(appState, data, context)`. TypeScript проверяет форму `name` и `events` в точке регистрации, а
`events` с `as const` связывает имя handler с instance-методом, concrete `AppState`, DTO-классом и
`ApplicationEventContext`. Собственность static-полей, wire-имена и точная runtime-форма metadata
проверяются при регистрации.

HTTP- и WebSocket-контроллеры получают одинаковый узкий фасад `this.events`:

```ts
const result = this.events.push(
  { listener: 'audit', event: 'OrderCreated' },
  new OrderCreated(order.id),
);
// result === undefined
```

`push()` синхронно проверяет точный адрес, DTO и свободное место в mailbox, копирует и замораживает
адрес и возвращает `undefined` сразу после принятия. DTO передаётся той же ссылкой. Ошибки адреса,
DTO, переполнения или закрытого sender синхронно представлены `InvalidEventPushError`,
`EventQueueFullError` и `EventSenderClosedError`.

Некорректная секция `events` создаёт `InvalidEventOptionsError`, неверный контракт listener —
`InvalidEventListenerError`, а повтор класса, listener name или адреса —
`EventListenerConflictError`. Все восемь event error-классов экспортируются из
библиотечной точки входа и поддерживают `instanceof`.

Один долгоживущий экземпляр listener обрабатывает свой FIFO mailbox строго последовательно;
разные listener работают независимо. Доставка in-memory и at-most-once: persistence, retry,
acknowledgements, подписок и listener middleware нет. Listener выполняется в основном потоке, поэтому
синхронная CPU-heavy работа блокирует event loop; для неё доступен `this.jobRunner`. Listener также
получает `this.websocket`, а handler — принадлежащий `Application` объект `AppState`, но listener не
получает `this.events`, поэтому не может строить цепочки внутренних событий.

```ts
const application = new Application({
  events: {
    queueSize: 1000,
    handlerTimeout: 30_000,
    shutdownTimeout: 30_000,
    onError(error, context) {
      console.error(error, context.listener, context.event);
    },
  },
});
```

Escaping error handler не влияет на HTTP-ответ или WebSocket-result и передаётся без обёртки в
`events.onError(error, context)`. Контекст — замороженный `{ listener, event }` без DTO. Timeout
отменяет `signal` с `EventHandlerTimeoutError` как `reason`, но следующий элемент FIFO запускается
только после фактического settlement текущего handler. Без `onError` ошибка попадает в
`console.error`.

При `Application.close()` sender запечатывается после settlement transport-handler или их forced
cutoff. Затем mailboxes опустошаются до `events.shutdownTimeout`; при timeout активные сигналы
отменяются, а каждый ожидающий элемент наблюдается как `EventDroppedError`. Только после event drain
закрывается `Job Runner`.

## Фоновые задачи

Фоновая задача должна напрямую наследовать `Job`, экспортироваться по умолчанию из собственного ESM-модуля, объявлять `static metaUrl = import.meta.url` и иметь собственный метод `run()`:

```ts
import { Job } from '@daevox/framework';

export default class SumJob extends Job {
  static metaUrl = import.meta.url;

  run({ values }) {
    return { sum: values.reduce((sum, value) => sum + value, 0) };
  }
}
```

Экземпляр HTTP-контроллера получает принадлежащий приложению исполнитель задач как `this.jobRunner`:

```ts
const result = await this.jobRunner.run(SumJob, ctx.body, {
  signal: ctx.signal,
  timeout: 5_000,
});

return { status: 200, body: result };
```

Payload и результат задачи должны поддерживать алгоритм structured clone. Transferable-объекты пока не поддерживаются.

Пул настраивается при создании приложения:

```ts
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

`Application.listen()` можно вызвать один раз. `Application.close()` прекращает новый HTTP- и
WebSocket-ввод, закрывает WebSocket-сессии, затем последовательно применяет независимые бюджеты
`http.shutdownTimeout`, `websocket.shutdownTimeout`, `events.shutdownTimeout` и
`jobs.shutdownTimeout`. Transport-handler отслеживаются до settlement даже после уничтожения HTTP
response или закрытия WebSocket-сессии. После закрытия приложение нельзя запустить повторно.

```ts
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

## Пример внутренних событий

Минимальное приложение регистрирует `AuditEventListener`, а HTTP-контроллер принимает заказ и
отправляет `OrderCreated` через `this.events.push()`:

```sh
npm run example:application-events
```

```sh
curl -i -X POST http://127.0.0.1:3000/orders \
  -H 'content-type: application/json' \
  -d '{"orderId":"order-1"}'
```

HTTP сразу отвечает `202`, а listener независимо записывает событие в stdout.

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

Пример показывает входящее событие `events/echo` и server push из HTTP-маршрута
`GET /broadcast`. `onConnect` возвращает стабильный `clientId`, а HTTP-контроллер отправляет
envelope `notifications/updated` через `this.websocket`.

Запустите приложение:

```sh
npm run example:websocket
```

Black-box тест примера проверяет HTTP-результат sender и полученный WebSocket envelope:

```sh
npm run example:websocket:test
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
npm run verify
npm run docs:build
npm run docs:check
```

`npm test` последовательно запускает unit-тесты из `test/unit/` и e2e-тесты из `test/e2e/`.
`npm run test:checks` отдельно проверяет harness'ы benchmark, fuzz, mutation, soak и stress,
не запуская сами длительные профили. Coverage включает только unit- и e2e-тесты.
`npm run check` выполняет независимые статические проверки: синтаксис, линтинг, форматирование и
актуальность сгенерированной API-документации.
`npm run verify` является стандартным критерием завершения изменения и последовательно запускает
`check`, unit- и e2e-тесты, `test:checks` и `test:soak-harness`. Дополнительные профильные проверки
для transport, concurrency, performance, malformed input и resource lifecycle описаны в
[`docs/system-testing.md`](docs/system-testing.md).

`npm run docs:build` детерминированно пересобирает индекс `docs/API.md` и отдельные Markdown-файлы
в `docs/api/` из сущностей, явно экспортированных `src/index.ts`, и их двуязычных
JSDoc-комментариев с меткой `@public`.
`npm run docs:check` проверяет public entrypoint, JSDoc, актуальность всех артефактов, дословное
соответствие помеченных capability-сводок каноническим фрагментам ADR и существование локальных
ссылок в документации без изменения файлов.

## Архитектура

`Application` служит общей точкой композиции для транспортов фреймворка и владеет жизненным циклом
HTTP/WebSocket runtime, адресуемых внутренних событий и исполнителя задач.

1. `Application` регистрирует HTTP- и WebSocket-контроллеры, запускает оба транспорта на одном `node:http` server и координирует завершение работы.
2. Внутренний `HttpRouter` регистрирует и сопоставляет HTTP-маршруты.
3. Внутренние WebSocket transport и session store обслуживают единый endpoint и протокол `daevox.v1`.
4. Внутренние registry, dispatcher и FIFO mailbox доставляют адресуемые события одному
   `EventListener`; решение зафиксировано в [ADR 0011](docs/adr/0011-addressed-application-events.md).
5. Внутренний `Job Runner` принимает классы задач и передаёт их в Worker Pool.
6. Внутренний Worker Pool управляет потоками Worker, очередью и завершением задач.

`HttpRouter`, `Job Runner` и Worker Pool не входят в пользовательский публичный API. Принятые архитектурные решения и их обоснования находятся в [`docs/adr/`](docs/adr/).
