# Middleware HTTP- и WebSocket-обработчиков

Status: draft

## Назначение

Добавить единый контракт middleware для выполнения HTTP-обработчиков и обработчиков
WebSocket-событий. Middleware поддерживаются на трёх уровнях:

- приложения — отдельно для HTTP и WebSocket;
- HTTP- или WebSocket-контроллера;
- HTTP-маршрута или WebSocket-события.

Middleware WebSocket применяются только к сообщениям протокола. Подключение и отключение
WebSocket-сессии остаются глобальными lifecycle callbacks `websocket.onConnect` и
`websocket.onDisconnect`; `connectionMiddleware` не вводится.

Спецификация является текущим архитектурным наброском, а не принятым ADR. Она расширяет строгие
декларации HTTP-маршрутов и WebSocket-событий и требует отдельного архитектурного решения перед
реализацией.

## План реализации

1. [`01-record-middleware-architecture.md`](issues/01-record-middleware-architecture.md) — принять
   архитектурное решение и терминологию.
2. [`02-implement-middleware-chain.md`](issues/02-implement-middleware-chain.md) — реализовать общий
   исполнитель цепочки и публичные ошибки.
3. После задачи 02 параллельно выполнить
   [`03-integrate-http-middleware.md`](issues/03-integrate-http-middleware.md) и
   [`04-integrate-websocket-middleware.md`](issues/04-integrate-websocket-middleware.md).
4. После обеих transport-интеграций выполнить
   [`05-document-and-verify-middleware.md`](issues/05-document-and-verify-middleware.md).

## Основной контракт

Middleware является обычной функцией:

```js
async function middleware(ctx, next) {
  const result = await next();
  return result;
}
```

- `ctx` — транспортно-специализированный контекст текущей операции.
- `next` — функция без аргументов, продолжающая текущую цепочку.
- `next()` разрешено вызвать не более одного раза в рамках одного вызова middleware.
- Middleware может завершить цепочку, не вызывая `next()`, и самостоятельно вернуть результат.
- Middleware может выполнить действия до и после `await next()`.
- Middleware может быть синхронным или асинхронным; transport всегда ожидает его результат.
- Middleware вызывается без прикладного receiver; полагаться на `this` нельзя.
- Результат middleware имеет тот же контракт, что и результат соответствующего обработчика.
- Исключение middleware имеет ту же транспортную семантику, что и исключение соответствующего
  обработчика.

Фреймворк скрывает композицию цепочки за одной внутренней реализацией, концептуально эквивалентной:

```js
composeMiddleware(
  [...applicationMiddleware, ...controllerMiddleware, ...handlerMiddleware],
  terminalHandler,
);
```

## Уровень приложения

Middleware приложения задаются отдельно в конфигурации транспорта:

```js
const application = new Application({
  http: {
    middleware: [requestId, authenticateHttp],
  },
  websocket: {
    middleware: [traceWebSocketMessage, authorizeWebSocketMessage],
    async onConnect(ctx) {},
    async onDisconnect(ctx) {},
    onError(error, ctx) {},
  },
});
```

- `http.middleware` применяется к каждому успешно найденному HTTP-маршруту.
- `websocket.middleware` применяется к каждому валидному и успешно маршрутизированному сообщению
  WebSocket-протокола.
- Общий `application.middleware`, автоматически применяемый к обоим транспортам, не вводится.
- Одну совместимую функцию можно явно включить в оба транспортных массива.
- Неизвестные поля и некорректные элементы массивов отклоняются при создании `Application`.
- Массивы копируются при создании `Application`; последующая мутация исходных массивов не влияет
  на выполнение.

Инфраструктурные ошибки, возникшие до успешной маршрутизации, не проходят через middleware:

- неверный HTTP pathname, неизвестный HTTP-маршрут и неподдерживаемый HTTP-метод;
- превышение HTTP body limit и ошибка разбора JSON;
- ошибка WebSocket handshake;
- невалидный WebSocket envelope, неизвестный WebSocket-контроллер или неизвестное
  WebSocket-событие.

Такие ошибки продолжают обрабатываться соответствующим transport и существующими error hooks.

## Уровень контроллера

HTTP- и WebSocket-контроллеры могут объявить собственный необязательный массив
`static middleware`:

```js
class UsersController extends HttpControllerBase {
  static prefix = '/users';
  static middleware = [requireAuthentication];

  static routes = [
    { method: 'GET', path: '/:id', handler: 'getById' },
  ];

  async getById(ctx) {}
}
```

```js
class NotificationsController extends WebSocketControllerBase {
  static name = 'notifications';
  static middleware = [requireAuthentication];

  static events = [
    { name: 'subscribe', handler: 'subscribe' },
  ];

  async subscribe(ctx) {}
}
```

- Отсутствующее поле эквивалентно пустому массиву.
- Каждый элемент обязан быть функцией.
- Middleware уровня контроллера являются функциями, а не именами методов контроллера.
- Экземпляр контроллера не раскрывается middleware через `this` или `ctx`.
- Массив проверяется и копируется при регистрации контроллера.
- Ошибка в middleware-метаданных атомарно отклоняет регистрацию всего контроллера.

## Уровень обработчика

Декларация HTTP-маршрута получает необязательное поле `middleware`:

```js
static routes = [
  {
    method: 'DELETE',
    path: '/:id',
    handler: 'deleteById',
    middleware: [requireRole('admin'), audit],
  },
];
```

Декларация WebSocket-события получает такое же поле:

```js
static events = [
  {
    name: 'subscribe',
    handler: 'subscribe',
    middleware: [requirePermission('notifications:subscribe')],
  },
];
```

- Отсутствующее поле эквивалентно пустому массиву.
- При наличии поле содержит массив функций.
- Неизвестные поля декларации по-прежнему отклоняются.
- Декларации и массивы middleware полностью копируются и замораживаются при регистрации.
- Последующая мутация статических метаданных не меняет каталог или цепочку выполнения.

## Порядок выполнения

Для HTTP-запроса:

```text
http.middleware
→ HttpController.middleware
→ HttpRoute.middleware
→ HttpHandler
→ HttpRoute.middleware после next()
→ HttpController.middleware после next()
→ http.middleware после next()
```

Для сообщения WebSocket-протокола:

```text
websocket.middleware
→ WebSocketController.middleware
→ WebSocketEvent.middleware
→ WebSocketEvent handler
→ WebSocketEvent.middleware после next()
→ WebSocketController.middleware после next()
→ websocket.middleware после next()
```

Порядок функций внутри каждого массива совпадает с порядком объявления. Цепочка разворачивается
обратно после выполнения terminal handler.

Сообщения одной WebSocket-сессии сохраняют существующую последовательную обработку. Вся цепочка
middleware и обработчик одного сообщения завершаются до начала цепочки следующего сообщения этой
сессии. Разные сессии могут выполняться параллельно.

## Состояние контекста

Оба транспортных контекста получают поле `state`:

```js
{
  state: Object.create(null),
  // Существующие транспортно-специализированные поля.
}
```

- Верхнеуровневый объект `ctx` заморожен.
- Ссылка `ctx.state` неизменяема, но собственные поля объекта `state` можно добавлять, изменять и
  удалять.
- Фреймворк не задаёт прикладную структуру `state` и не интерпретирует её поля.
- Имена и значения в `state` принадлежат приложению и его middleware.

Контекст HTTP middleware и HTTP-обработчика дополнительно получает замороженные нормализованные
метаданные найденного HTTP-маршрута:

```js
{
  // Существующие поля HTTP-контекста.
  state,
  route: {
    method: 'GET',
    path: '/users/:id',
    handler: 'getById',
  },
}
```

- `ctx.method` остаётся фактическим методом HTTP-запроса.
- `ctx.path` остаётся фактическим нормализованным pathname.
- `ctx.route.method` и `ctx.route.path` описывают декларацию найденного HTTP-маршрута.
- Класс HTTP-контроллера через `ctx.route` не раскрывается.

Контекст middleware и обработчика WebSocket-события получает публичный адрес сообщения:

```js
{
  body,
  clientId,
  sessionId,
  controller: 'notifications',
  event: 'subscribe',
  signal,
  state,
}
```

Поля `controller` и `event` доступны на всех трёх уровнях middleware и в terminal handler. Это
позволяет application-level middleware выполнять журналирование и авторизацию по публичному адресу
сообщения без доступа к внутреннему каталогу контроллеров.

Для HTTP новый объект `state` создаётся для каждого HTTP-запроса и живёт до завершения его цепочки.

Для WebSocket объект `state` создаётся перед `onConnect` и живёт всю WebSocket-сессию. Одна и та же
ссылка передаётся в:

- `websocket.onConnect`;
- middleware и обработчики всех сообщений этой сессии;
- `websocket.onDisconnect`;
- WebSocket error context, когда сессия уже известна.

Это позволяет выполнить аутентификацию один раз в `onConnect`:

```js
const application = new Application({
  websocket: {
    async onConnect(ctx) {
      const claims = await verifyJwt(readToken(ctx.headers));

      ctx.state.auth = {
        subjectId: claims.sub,
        roles: claims.roles ?? [],
      };
    },
    middleware: [requireAuthentication],
  },
});
```

`onConnect` остаётся одиночным глобальным lifecycle callback. У него нет `next()`, и он не является
частью message middleware chain.

## Short-circuit и результаты

HTTP middleware может остановить цепочку и вернуть обычный `HttpResponse`:

```js
async function requireAuthentication(ctx, next) {
  if (!ctx.state.auth) {
    return {
      status: 401,
      body: { error: 'Unauthorized' },
    };
  }

  return next();
}
```

Результат всей HTTP-цепочки проходит существующую централизованную нормализацию `HttpResponse`.

WebSocket middleware возвращает `undefined` либо plain object по тем же правилам, что и обработчик
WebSocket-события. Возвращённый объект получает адрес исходного сообщения. `undefined` завершает
обработку без исходящего сообщения.

После `await next()` middleware может вернуть исходный результат либо преобразовать его и вернуть
другой результат, допустимый для соответствующего транспорта. Фреймворк не клонирует и не
замораживает промежуточные результаты между уровнями, поэтому изменение полученного объекта также
допускается, но middleware обязана явно вернуть итоговое значение. Вся цепочка имеет один
окончательный этап транспортной валидации и нормализации.

Успешный WebSocket-результат по-прежнему не может содержать зарезервированное верхнеуровневое поле
`error`. Для ожидаемого прикладного отказа HTTP middleware использует `HttpError`, а WebSocket
middleware или обработчик WebSocket-события — `WebSocketEventError`:

```js
throw new WebSocketEventError('UNAUTHORIZED');
```

- Код соответствует `^[A-Z][A-Z0-9_]*$`.
- Стабильные коды самого протокола зарезервированы и не могут использоваться приложением.
- Ошибка преобразуется в `body.error.code` с адресом текущего сообщения.
- Ошибка не передаётся в `websocket.onError`, поскольку является ожидаемым прикладным результатом.
- WebSocket-сессия остаётся открытой, а очередь следующих сообщений продолжает работу.

## Ошибки выполнения

- Вызов `throw new Error()` и отклонение возвращённого Promise внутри middleware являются
  штатно изолируемыми ошибками текущей операции.
- Фреймворк ожидает всю цепочку внутри собственного `try`/`catch`; такая ошибка не должна стать
  `uncaughtException` или `unhandledRejection` и не должна завершить процесс приложения.
- Повторный вызов одного `next()` создаёт публичный `MiddlewareExecutionError`. Он обрабатывается
  как произвольная ошибка текущего транспорта и доступен наблюдателю через `instanceof`.
- Исключение HTTP middleware завершает только текущий HTTP-запрос. `HttpError` сохраняет свою
  ожидаемую семантику, а произвольная ошибка наблюдается через `http.onError` и преобразуется в
  HTTP `500` без раскрытия деталей клиенту.
- Исключение WebSocket middleware наблюдается через `websocket.onError` и возвращает клиенту
  `HANDLER_ERROR`, как исключение обработчика WebSocket-события. Оно завершает только обработку
  текущего WebSocket-события; соединение остаётся открытым, очередь следующих сообщений этой
  сессии продолжает работу, остальные сессии не затрагиваются.
- Детали неожиданных исключений клиенту не раскрываются.
- Ошибка в действиях после `await next()` считается ошибкой вызвавшего middleware.
- Short-circuit является штатным завершением, а не ошибкой.

```js
async function failingMiddleware() {
  throw new Error('Unexpected middleware failure');
}
```

Гарантия изоляции распространяется только на синхронную работу middleware и Promise, который она
возвращает. Ошибки в запущенной без ожидания сторонней асинхронной работе не принадлежат цепочке и
не могут быть перехвачены transport:

```js
async function incorrectMiddleware(ctx, next) {
  void detachedWork(); // Возможное отклонение Promise находится вне цепочки.
  return next();
}
```

## Lifecycle WebSocket

Конфигурация WebSocket сохраняет одиночные lifecycle callbacks:

```js
websocket: {
  path: '/websocket',
  maxPayload: 1024 * 1024,
  middleware: [],
  async onConnect(ctx) {},
  async onDisconnect(ctx) {},
  onError(error, ctx) {},
}
```

Контекст `onConnect` после расширения:

```js
{
  clientId,
  sessionId,
  path,
  query,
  headers,
  signal,
  state,
}
```

- `onConnect` вызывается ровно один раз до принятия сессии.
- Если `onConnect` выбрасывает исключение, сессия не регистрируется.
- `onDisconnect` вызывается ровно один раз для принятой сессии и получает тот же `state`.
- `onConnect` и `onDisconnect` не поддерживаются на уровне контроллера или события.
- `connectionMiddleware` не поддерживается.

Для корректного отказа JWT-аутентификации во время handshake переиспользуется существующий
`HttpError`, поскольку WebSocket handshake является HTTP-запросом:

```js
async function onConnect(ctx) {
  const token = readToken(ctx.headers);

  if (!token) {
    throw new HttpError(401, {
      headers: new Headers({ 'www-authenticate': 'Bearer' }),
      body: { error: 'Unauthorized' },
    });
  }
}
```

- `HttpError` из `onConnect` отклоняет handshake указанным HTTP-статусом, заголовками и телом.
- Ожидаемый отказ не передаётся в `websocket.onError`.
- Любая другая ошибка `onConnect` передаётся в `websocket.onError` и отклоняет handshake ответом
  HTTP `500` без раскрытия деталей.
- Сессия и её индексы создаются только после успешного завершения `onConnect`.

## Аутентификация и адресация WebSocket-сессий

Middleware предоставляет место для аутентификационной информации, но не реализует server push и
поиск сессий пользователя.

Рекомендуемое разделение ответственности для последующей инициативы:

- `ctx.state.auth` хранит минимальный снимок аутентифицированного субъекта конкретной
  WebSocket-сессии;
- внутренний `WebSocketSessionStore` может поддерживать вторичный индекс
  `subjectId → Set<sessionId>`;
- отдельный узкий интерфейс доставки скрывает поиск сессий и отправку по `subjectId` или
  `sessionId`;
- внешнее распределённое хранилище и pub/sub нужны только при нескольких процессах или узлах.

Эта функциональность пересматривает принятое в ADR 0008 отсутствие объединения пользовательских
сессий и server push, поэтому не входит в реализацию middleware без отдельного решения.

## Публичные ошибки

`MiddlewareExecutionError extends Error` создаётся фреймворком при нарушении runtime-контракта
middleware, в текущем draft — при повторном вызове одного `next()`. Ошибка передаётся в
соответствующий error hook как неожиданная ошибка текущей операции.

`WebSocketEventError extends Error` представляет ожидаемый прикладной отказ middleware или
обработчика WebSocket-события:

```js
throw new WebSocketEventError('FORBIDDEN');
```

- Конструктор принимает один прикладной машинный код.
- Код сохраняется в публичном поле `code`.
- Некорректный или зарезервированный код синхронно отклоняется `TypeError`.
- Зарезервированы `INVALID_MESSAGE`, `UNKNOWN_CONTROLLER`, `UNKNOWN_EVENT`, `HANDLER_ERROR` и
  `INVALID_RESPONSE`.

Существующий `HttpError` расширяет область применения: помимо HTTP middleware и обработчиков, он
является ожидаемым способом отклонить WebSocket handshake из `websocket.onConnect`.

## Валидация и снимки метаданных

- Все middleware приложения валидируются при создании `Application`.
- Все controller- и handler-level middleware валидируются при регистрации контроллера.
- Middleware обязана быть функцией; callable proxy и обычная функция одинаково удовлетворяют
  проверке `typeof value === 'function'`.
- Пустые массивы разрешены.
- Sparse arrays и дополнительные enumerable или symbol-свойства массивов не поддерживаются.
- Нормализованные цепочки не зависят от последующих изменений пользовательских массивов.
- Регистрация остаётся атомарной: ошибка в одной цепочке не сохраняет часть контроллера.

## Проверки

Будущая реализация должна проверить как минимум:

- точный порядок входа и обратного выхода на всех трёх уровнях;
- HTTP и WebSocket short-circuit;
- синхронные и асинхронные middleware;
- исключение до и после `next()`;
- преобразование произвольной ошибки HTTP middleware в `500` без завершения приложения;
- преобразование произвольной ошибки WebSocket middleware в `HANDLER_ERROR` с сохранением сессии
  и очереди следующих сообщений;
- преобразование `WebSocketEventError` в прикладной код без вызова `websocket.onError`;
- отклонение handshake через `HttpError` и преобразование неожиданной ошибки `onConnect` в `500`;
- отсутствие влияния ошибки middleware одной операции на параллельные запросы и сессии;
- запрет повторного `next()`;
- публичный `MiddlewareExecutionError` и проверку через `instanceof`;
- передачу и время жизни `ctx.state`;
- нормализованные `ctx.route` для HTTP и `ctx.controller`/`ctx.event` для WebSocket;
- преобразование результата middleware на обратном пути и единственную финальную валидацию;
- изоляцию `state` разных HTTP-запросов и WebSocket-сессий;
- последовательность цепочек сообщений одной WebSocket-сессии;
- атомарную регистрацию и снимки массивов middleware;
- отсутствие middleware при инфраструктурных ошибках до маршрутизации;
- lifecycle `onConnect`/`onDisconnect` без `connectionMiddleware`.

После изменения production-кода в `lib/framework/*.js` необходимо добавить двуязычный JSDoc ко
всем новым и изменённым сущностям, выполнить `npm run docs:build` и затем полный `npm run check`.

## Принятые решения draft

- Повторный вызов `next()` создаёт публичный `MiddlewareExecutionError`.
- Ожидаемый отказ `websocket.onConnect` выражается существующим `HttpError`; отдельная ошибка
  handshake не вводится.
- Ожидаемый прикладной отказ WebSocket middleware или обработчика выражается публичным
  `WebSocketEventError` с прикладным машинным кодом.
- Middleware может вернуть исходный или преобразованный результат; окончательная транспортная
  валидация выполняется один раз после завершения всей цепочки.
- HTTP-контекст содержит замороженное `ctx.route` без ссылки на класс контроллера.
- Контекст WebSocket-события содержит публичные `ctx.controller` и `ctx.event`.

## Вне scope

- Controller-level или handler-level WebSocket lifecycle callbacks.
- `connectionMiddleware` и middleware WebSocket handshake.
- Встроенная реализация JWT, cookies, ролей или разрешений.
- Server push и публичная произвольная отправка WebSocket-сообщений.
- Поиск, объединение и распределённое хранение сессий пользователя.
- Raw `IncomingMessage`, `ServerResponse`, socket или WebSocket connection в контексте.
- Hot reload и изменение цепочек после запуска приложения.
- Middleware фоновых задач.
