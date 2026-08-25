# Связь HTTP-запроса и WebSocket-сессий через AuthSession

## Назначение

Добавить в Daevox единый модуль `Authentication`, который подтверждает общую `AuthSession` для
HTTP-запросов и WebSocket-соединений, и дать авторизованному HTTP-обработчику request-scoped
capability `ctx.webSocket.send()` для best-effort fan-out во все локальные WebSocket-сессии той же
`AuthSession`.

Спецификация следует [ADR 0009](../../docs/adr/0009-auth-session-websocket-server-push.md) и
[исследованию](research.md). Этот документ задаёт точный исполнимый public contract для задач
реализации.

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

## Исполнимый public contract

### Общие правила строгих форм

Если ниже форма названа exact-key, значением должен быть не `null`, не массив, а объект с ровно
перечисленными собственными строковыми ключами. Symbol-ключи, accessors и дополнительные ключи
запрещены. Необязательный ключ может отсутствовать, но не может иметь значение `undefined`.
Каталоги и декларации читаются и проверяются синхронно, копируются до публикации и не сохраняют
ссылки на переданные пользователем массивы или объекты конфигурации. Нормализованные декларации,
массивы `use`, результаты и contexts замораживаются через `Object.freeze()`.

Имя strategy или scenario — строка, соответствующая `/^[A-Za-z][A-Za-z0-9_-]*$/`. Каталоги не
могут быть пустыми. Каталог — record с такими именами в собственных перечислимых ключах; prototype
`Object.prototype` и `null` допустимы. Имена внутри одного каталога уникальны по обычному строгому
сравнению строк.

Под **JSON-совместимым значением** в этом разделе понимаются `null`, boolean, конечное number,
string, массивы и объекты с prototype `Object.prototype` или `null`, рекурсивно содержащие только
JSON-совместимые значения. Циклы, sparse-массивы, `undefined`, `bigint`, symbol, function,
accessors и symbol-ключи запрещены.

### Точки композиции и конфигурация Application

`createAuthentication` экспортируется из `lib/framework/Authentication.js`; `cookieSession`,
`bearerToken` и `oneTimeWebSocketTicket` — из
`lib/framework/authenticationStrategies.js`. `createAuthentication()` возвращает брендированный
неизменяемый экземпляр `Authentication`; конструктор `Authentication` напрямую не экспортируется.

Exact-key форма аргумента `createAuthentication()`:

```js
{
  strategies: {
    browserSession: { authenticate },
  },
  scenarios: {
    browser: { use: ['browserSession'], required: true },
  },
}
```

Оба ключа обязательны. Custom strategy имеет exact-key форму `{ authenticate }`, где
`authenticate` — function. Strategy может вернуть результат непосредственно или через Promise.
Scenario имеет ровно обязательные `use` и `required`: `use` — непустой массив уникальных имён
strategy, `required` — boolean. Порядок `use` является порядком fallback. Ссылка на отсутствующую
strategy — синхронная ошибка `createAuthentication()`; ни один частично собранный каталог при этом
не публикуется.

Exact-key верхнеуровневая конфигурация `Application` содержит обязательный ключ `websocket` и
необязательные ключи `authentication`, `http` и `jobs`. `authentication`, если присутствует, должен
быть результатом `createAuthentication()`. Отсутствие `authentication` не включает authentication
неявно и допустимо только вместе с selectors `false`. Даже HTTP-only приложение явно передаёт
`websocket: { authentication: false }`, поскольку общий `node:http` server всегда обслуживает
WebSocket endpoint.

WebSocket options после этого изменения имеют exact-key форму:

```js
{
  path: '/websocket',
  maxPayload: 1024 * 1024,
  maxWriteQueueBytes: 2 * 1024 * 1024,
  authentication: false,
  allowedOrigins: [],
  onConnect,
  onDisconnect,
  onError,
}
```

`path`, `maxPayload`, `maxWriteQueueBytes`, `allowedOrigins` и hooks необязательны.
`authentication` обязателен и равен `false` либо имени scenario. Defaults: `path` —
`'/websocket'`, `maxPayload` — `1024 * 1024`, `maxWriteQueueBytes` — `2 * maxPayload`,
`allowedOrigins` — новый пустой массив; hooks отсутствуют. `maxWriteQueueBytes` — целое безопасное
число от `0` до `Number.MAX_SAFE_INTEGER`. Если default нельзя вычислить как безопасное целое из-за
слишком большого `maxPayload`, конфигурация невалидна. Наличие custom значения меньше
`maxPayload` разрешено и означает, что некоторые корректные по `maxPayload` исходящие сообщения
могут переполнить очередь.

`maxPayload` — целое безопасное число от `0` до `Number.MAX_SAFE_INTEGER`; `path` проходит прежнюю
canonical absolute-path нормализацию; каждый заданный hook является function. Вложенные exact-key
формы `http` и `jobs`, их defaults и валидация не меняются.

`Application` синхронно копирует и замораживает WebSocket options и `allowedOrigins`. Если
WebSocket selector — строка, наличие `authentication` и указанного scenario проверяется в
конструкторе `Application`, до `listen()`. Неизвестные и symbol-поля дают
`InvalidWebSocketOptionsError`; неверный модуль или ссылка — `InvalidAuthenticationOptionsError`.

### HTTP-маршрут и проверка ссылок

`HttpRouteDeclaration` получает четвёртый обязательный ключ:

```js
{
  method: 'POST',
  path: '/orders',
  handler: 'create',
  authentication: 'browser',
}
```

Exact-key форма содержит ровно `method`, `path`, `handler`, `authentication`.
`authentication` равен `false` либо имени scenario. Нормализованный HTTP-маршрут содержит ровно
`method`, `path`, `handler`, `controller`, `authentication`; значение копируется и объект
замораживается. При `registerHttpController()` строковая ссылка синхронно проверяется против
переданного в `Application` модуля. Отсутствующий модуль или scenario даёт
`InvalidAuthenticationOptionsError`; остальные нарушения декларации по-прежнему дают
`InvalidHttpRouteError`. Весь набор маршрутов HTTP-контроллера регистрируется атомарно.

`authentication: false` полностью пропускает Authentication. String selector выполняется только
после успешного сопоставления HTTP-маршрута и создания request `AbortSignal`, но до чтения первого
body chunk и до создания экземпляра HTTP-контроллера. `404`, `405`, автоматический `OPTIONS` и
ошибка декодирования pathname не запускают strategy.

### Нормализованный strategy input

Для каждого вызова strategy создаётся новый замороженный outer object и новые snapshots `Headers`
и `URLSearchParams`. Мутация этих двух WHATWG-объектов одной strategy не меняет request, context или
input следующей strategy. Один request `AbortSignal` разделяется всеми попытками scenario.

HTTP strategy получает ровно:

```js
{
  transport: 'http',
  method: 'POST',
  path: '/orders',
  headers: new Headers(),
  query: new URLSearchParams(),
  signal,
}
```

`method` — фактический uppercase HTTP-метод, `path` — percent-encoded pathname без query. Params,
body, `IncomingMessage`, `ServerResponse`, socket, remote address и HTTP handler в input не входят.

WebSocket strategy получает ровно:

```js
{
  transport: 'websocket',
  method: 'GET',
  path: '/websocket',
  headers: new Headers(),
  query: new URLSearchParams(),
  origin: 'https://app.example.com',
  signal,
}
```

`origin` необязателен и отсутствует, если header `Origin` отсутствовал. Он никогда не равен
`undefined`. Input создаётся после полной базовой проверки handshake и Origin. `IncomingMessage`,
raw socket, upgrade `head`, `clientId` и `sessionId` в него не входят.

`Authentication.authenticate()` всегда возвращает Promise и до первого вызова strategy проверяет
имя scenario и exact-key input: `headers instanceof Headers`, `query instanceof URLSearchParams`,
`signal instanceof AbortSignal`, допустимый transport и перечисленные выше типы остальных полей.
Неизвестный scenario даёт `InvalidAuthenticationOptionsError`, невалидный input — `TypeError`; ни
одна strategy при этом не вызывается.

### AuthSession и результаты strategy

`AuthSession` имеет ровно два обязательных и один необязательный ключ:

```js
{
  authSessionId: 'opaque-session-id',
  principal: { id: 'user-42', roles: ['member'] },
  expiresAt: 1780000000000,
}
```

`authSessionId` — непустая строка. `principal` — JSON-совместимый объект; framework не
интерпретирует его поля. `expiresAt`, если присутствует, — положительное безопасное целое Unix epoch
в миллисекундах. Strategy обязана вернуть только актуальную session: `expiresAt <= Date.now()` не
является `authenticated`.

При результате `authenticated` framework рекурсивно копирует `principal`, замораживает каждый
скопированный объект и массив, затем создаёт и замораживает новый `AuthSession`. Array остаётся
Array; object с `Object.prototype` получает `Object.prototype`, object с `null` prototype — `null`.
Ссылки на session и principal, возвращённые strategy, не сохраняются. Одинаковый `principal` или
`principal.id` никогда не объединяет sessions; единственный membership key — точная строка
`authSessionId`.

Допустимы только три exact-key результата:

```js
{ status: 'abstain' }

{
  status: 'rejected',
  code: 'INVALID_CREDENTIALS',
  challenge: 'Bearer',
}

{
  status: 'authenticated',
  session,
}
```

У `rejected` обязательны `status` и `code`, `challenge` необязателен. `code` соответствует
`/^[A-Z][A-Z0-9_]*$/`. `challenge` — непустая строка из horizontal tab и печатных ASCII-символов
без CR/LF, пригодная как одно значение `WWW-Authenticate`. Невалидная, поддельная, просроченная или
повторно использованная credential должна дать `rejected`, а не `abstain`. `abstain` означает, что
credential именно этой strategy полностью отсутствует.

Прошедший `expiresAt` в результате custom strategy является невалидной `AuthSession`, приводит к
`InvalidAuthenticationResultError` и transport `500`; готовые presets до возврата результата
преобразуют такой callback outcome в обычный `rejected`.

`Authentication.authenticate(scenarioName, input)` последовательно вызывает strategies. После
`abstain` вызывается следующая, после `rejected` или `authenticated` выполнение заканчивается.
Если все дали `abstain`, optional scenario возвращает замороженный `{ status: 'abstain' }`, а
required scenario — замороженный `{ status: 'rejected', code: 'AUTHENTICATION_REQUIRED' }`.
Отмена signal до или между вызовами завершает операцию `AuthenticationAbortedError` и не запускает
следующую strategy. Каждый возвращаемый core result — новая замороженная копия, поэтому ссылка на
tagged result strategy наружу не сохраняется.

### Transport mapping

HTTP и WebSocket используют одинаковое отображение authentication outcome:

| Outcome                                               | HTTP-маршрут                   | WebSocket handshake до `101` |
| ----------------------------------------------------- | ------------------------------ | ---------------------------- |
| `authenticated`                                       | продолжить                     | продолжить                   |
| optional scenario, все `abstain`                      | продолжить                     | продолжить                   |
| required scenario, все `abstain`                      | `401`                          | `401`                        |
| `rejected`                                            | `401`                          | `401`                        |
| strategy throw/rejected Promise или невалидный result | `500`                          | `500`                        |
| request/handshake signal aborted                      | прекратить без нового response | закрыть socket без `101`     |

До этой таблицы сохраняется базовое WebSocket mapping: malformed request target — `400 Bad
Request`, другой endpoint path — `404 Not Found`, неверные method/Upgrade/Connection/version,
`Sec-WebSocket-Key` или отсутствие `daevox.v1` — `400 Bad Request`. Затем проверяется Origin
(`403`), authentication (`401`/`500`) и `onConnect` (`500`) — всегда с закрытием HTTP connection и
без `101`.

Authentication-ответ `401` имеет `content-type: application/json; charset=utf-8` и body
`{ "error": { "code": code } }`. Если конечный `rejected` содержит `challenge`, добавляется ровно
один `WWW-Authenticate` с этим значением; без `challenge` header отсутствует. Ни следующий strategy,
ни body parser, ни HTTP-контроллер, ни `onConnect` после отказа не вызываются. Authentication `500`
имеет body `{ "error": { "code": "INTERNAL_SERVER_ERROR" } }`; исходная ошибка и credential
клиенту не раскрываются.

Нормальный `rejected` и required `abstain` не передаются в `http.onError` или
`websocket.onError`. Ошибка выполнения strategy передаётся соответствующему `onError` как
`AuthenticationStrategyError`. HTTP observer получает вторым аргументом замороженный exact-key
context `{ phase: 'authentication', method, path, scenario, signal }`; WebSocket observer —
`{ phase: 'handshake', path, scenario, signal }`. Эти contexts не содержат headers, query или raw
credential.

При `authenticated` HTTP handler context содержит обычные поля плюс собственные замороженные
`authSession` и `webSocket`. При optional `abstain` оба ключа полностью отсутствуют. При
`authentication: false` Authentication не вызывается и оба ключа отсутствуют.

### Origin policy

`allowedOrigins` — массив уникальных строк. Каждая строка должна быть canonical serialized origin:
`new URL(value).origin === value`, protocol равен `http:` или `https:`, а username, password, path,
query и fragment отсутствуют. Wildcards, regex, функции, строка `'null'`, trailing slash и
case-insensitive comparison не поддерживаются.

После endpoint match и базовой проверки Upgrade transport читает `Origin`. Более одного значения,
невалидное значение и literal `null` отклоняются. Присутствующее значение допускается только при
точном, case-sensitive совпадении с элементом snapshot `allowedOrigins`; иначе handshake получает
`403 Forbidden` с JSON body `{ "error": { "code": "ORIGIN_NOT_ALLOWED" } }` и не доходит до
Authentication или `onConnect`.

Отсутствующий `Origin` считается non-browser handshake и допускается. Он всё равно проходит
выбранный authentication scenario. Эта политика не пытается доказать тип клиента: non-browser
клиенту нельзя доверять присланный `Origin`. При `authentication: false` правила Origin остаются
ровно теми же; таким образом default `allowedOrigins: []` запрещает все browser handshakes, но
разрешает handshake без `Origin`.

### WebSocket lifecycle, expiry и cleanup

После успешной Origin/authentication проверки framework создаёт `clientId`, `sessionId` и signal.
Lifecycle contexts не содержат headers или query, чтобы cookie, bearer и ticket не переживали
handshake.

`onConnect(ctx)` получает замороженную exact-key форму:

```js
{
  clientId,
  sessionId,
  path,
  origin,
  signal,
  authSession,
}
```

`origin` присутствует только при наличии header; `authSession` — только после `authenticated`.
Optional `abstain` и `authentication: false` не имеют этого ключа. `onConnect` может вернуть value
или Promise; результат игнорируется. Throw/rejection сообщает `websocket.onError`, даёт HTTP `500`,
отменяет signal и закрывает socket без `101`, membership, expiry timer и `onDisconnect`.

После успешного `onConnect` transport ещё раз проверяет `expiresAt`. Уже истёкшая session получает
`401` с кодом `AUTHENTICATION_EXPIRED` без `101`. Иначе порядок синхронных действий таков:
записать `101`, добавить connection в session store и, при наличии `authSession`, в обе стороны
membership index, установить expiry timer, подключить message processing и обработать upgrade
`head`. Ни одно WebSocket-сообщение не обрабатывается до membership.

`onDisconnect(ctx)` вызывается ровно один раз только для connection, получившего `101`, и получает
замороженную exact-key форму `{ clientId, sessionId, code, reason, signal, authSession? }`. К моменту
вызова signal уже aborted, timer снят, обе стороны membership удалены, connection исключён из
session store и transport listeners очищены. Hook может быть async; `Application.close()` ожидает
его в пределах существующего shutdown lifecycle. Ошибка hook передаётся `websocket.onError` и не
повторяет cleanup или hook.

`websocket.onError(error, ctx)` получает один из следующих замороженных contexts:

- handshake: `{ phase: 'handshake', path, scenario, signal }`;
- connect hook: `{ phase: 'connect', clientId, sessionId, path, signal, authSession? }`;
- session/handler/protocol: `{ phase: 'session', clientId, sessionId, signal, authSession? }`, с
  дополнительными одновременно присутствующими `controller` и `event`, когда адрес известен;
- disconnect hook: `{ phase: 'disconnect', clientId, sessionId, signal, authSession? }`.

Expected Origin/authentication refusals и штатные close не вызывают `onError`. Ошибка `onError`
никогда не меняет transport outcome и, как раньше, безопасно уходит в `console.error`.

Для `expiresAt` используется application-owned timer. Delay больше максимума Node timer
разбивается на повторные интервалы; при каждом срабатывании сверяется текущее `Date.now()`. По
достижении срока connection начинает единственный close с code `4001` и reason
`Authentication expired`. Timer очищается при любом более раннем close, socket `end`/`error`,
queue overflow и shutdown. Expiry, peer close, transport error и `Application.close()` сходятся в
один idempotent cleanup; победившая причина задаёт единственный disconnect context. Shutdown для
ещё открытого connection использует `1001` и `Server shutting down`.

### Исходящая FIFO и request-scoped server push

Все text responses, protocol errors, pong и server push одного connection проходят одну FIFO из
полностью сериализованных WebSocket frames. Close frame имеет приоритет, не расходует лимит и после
начала close новые data/control frames не принимаются. `maxWriteQueueBytes` считает байты frames,
принятых framework, но ещё не переданных в `socket.write()`. После `socket.write() === false`
текущий frame считается переданным socket, connection становится blocked и следующий frame не
передаётся до единственного `drain`.

Если добавление frame сделало бы счётчик больше лимита, frame не ставится, результат enqueue —
`dropped`, а connection ровно один раз начинает close code `1013`, reason
`Write queue overflow`. Оставшаяся пользовательская FIFO очищается. `error`, `end`, `close` и
shutdown также очищают FIFO и listener `drain`; повторный close и запись после close запрещены.
FIFO сохраняет порядок только внутри одного connection.

`ctx.webSocket` — замороженный request-scoped объект с единственным методом `send`. Он содержит
`authSessionId` только в private state и не принимает recipient. `send()` синхронно принимает
exact-key envelope `{ controller, event, body }`: `controller` и `event` соответствуют
`/^[A-Za-z0-9_-]+$/`, `body` — JSON-совместимый объект. Envelope полностью проверяется,
JSON-сериализуется и проверяется против `maxPayload` до первого membership lookup/enqueue. Ошибка
формы даёт `InvalidWebSocketPushError`, превышение `maxPayload` —
`WebSocketPushPayloadTooLargeError`; частичного fan-out нет.

`send()` делает snapshot всех активных локальных connections точного `authSessionId`, пытается
поставить один и тот же сериализованный frame в каждую FIFO и возвращает новый замороженный
exact-key result:

```js
{ matched: 2, queued: 1, dropped: 1 }
```

Все поля — неотрицательные целые и `matched === queued + dropped`. `matched` — размер snapshot,
`queued` — число connections, принявших frame, включая немедленный `socket.write`, `dropped` —
число уже closing/closed или переполненных connections. `matched: 0` — успешный штатный результат.
Результат означает только локальный enqueue, не browser delivery, не меняет HTTP status и не
атомарен с business state.

### Public errors

Новые публичные классы экспортируются из `lib/framework/errors.js`:

- `InvalidAuthenticationOptionsError extends TypeError` — любая синхронная ошибка формы,
  selector, ссылки или preset options;
- `InvalidAuthenticationResultError extends TypeError` — невалидный tagged result или
  `AuthSession`; содержит только имя strategy, но не result;
- `AuthenticationStrategyError extends Error` — strategy throw/rejection; имеет строковое поле
  `strategy` и стандартный `cause`, равный исходной ошибке или
  `InvalidAuthenticationResultError`;
- `AuthenticationAbortedError extends Error` — отмена scenario signal;
- `InvalidWebSocketPushError extends TypeError` — невалидный push envelope;
- `WebSocketPushPayloadTooLargeError extends RangeError` — сериализованный envelope превышает
  `maxPayload`.

Сообщения framework errors содержат только имя strategy/scenario или название нарушенного поля.
Framework никогда не добавляет в message/result/context headers, query, cookie, bearer, ticket,
полный strategy input или невалидный result. Custom strategy обязана не включать raw credential в
выбрасываемую ей ошибку. Готовые presets не сохраняют callback error как `cause`: они выбрасывают
стабильную внутреннюю ошибку без исходного message/stack, после чего core оборачивает её в
`AuthenticationStrategyError`. Это гарантирует, что preset credential не появляется и через
`cause`/inspection.

### Готовые strategy presets

Все presets синхронно проверяют и копируют options и возвращают custom strategy exact-key формы
`{ authenticate }`. Callback вызывается не более одного раза на attempt, может вернуть значение
или Promise и получает raw credential только первым аргументом.

`cookieSession()` принимает ровно:

```js
cookieSession({
  cookie: { name: '__Host-session' },
  resolve: async (cookieValue, { transport, signal }) => authSessionOrNull,
});
```

`cookie` имеет ровно обязательный `name`, являющийся непустым RFC cookie-name token. `resolve` —
function. Strategy применима к обоим transports. Отсутствие header `Cookie` или нужного имени даёт
`abstain`. Cookie разбирается разделением по `;`; у каждого segment удаляются крайние SP/HTAB и
ищется первый `=`. Пары с другим case-sensitive name и segments без `=` не интерпретируются.
Нужное значение должно встретиться один раз и быть непустой unquoted последовательностью RFC
cookie-octet; quotes, control/whitespace, comma, semicolon и backslash запрещены. Нарушение даёт
`rejected` с code `INVALID_SESSION`. Percent-decoding не выполняется; callback получает точное
opaque значение после `=`. `null` или AuthSession с истёкшим `expiresAt` даёт тот же `rejected`;
корректная AuthSession — `authenticated`. Любой другой callback result является невалидным result.
Challenge отсутствует.

`bearerToken()` принимает ровно:

```js
bearerToken({
  verify: async (token, { transport, signal }) => authSessionOrNull,
});
```

`verify` обязателен и является function. Strategy применима к обоим transports. Отсутствие
`Authorization` или другая корректная auth-scheme даёт `abstain`. Значение Bearer должно состоять
из case-insensitive scheme `Bearer`, одного или нескольких SP и непустого RFC token68 без comma;
повторный/объединённый header, пустой или malformed Bearer даёт `rejected` с code `INVALID_TOKEN` и
challenge `Bearer`. `null` или истёкшая AuthSession даёт тот же `rejected`; корректная AuthSession —
`authenticated`; иной result невалиден.

`oneTimeWebSocketTicket()` принимает ровно:

```js
oneTimeWebSocketTicket({
  consume: async (ticket, { origin, signal }) => authSessionOrNull,
});
```

`consume` обязателен и является function. Единственный carrier — query parameter `ticket` в
WebSocket handshake; HTTP input всегда даёт `abstain`. Отсутствие parameter даёт `abstain`.
Parameter должен встретиться ровно один раз и иметь непустое значение; иначе результат —
`rejected` с code `INVALID_TICKET`. Strategy передаёт opaque значение callback без decoding сверх
стандартного `URLSearchParams`; optional `origin` присутствует в metadata только при наличии
header. Пользовательский `consume` обязан атомарно погасить ticket: `null`, в том числе для expiry
или replay, даёт `INVALID_TICKET`; корректная актуальная AuthSession — `authenticated`; иной result
невалиден. Challenge отсутствует. Framework не выдаёт ticket и не хранит nonce, TTL или consumed
state.

Callback metadata — новый замороженный exact-key object на вызов. Ни один preset не логирует, не
возвращает и не включает raw credential в errors или observer contexts.

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
