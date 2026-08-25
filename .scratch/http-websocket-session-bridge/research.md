# Совместная модель HTTP- и WebSocket-транспортов для адресного server push

## Research question

Как позволить HTTP-обработчику отправить WebSocket-событие только соединению или соединениям,
которые принадлежат той же сессии аутентификации, что и текущий авторизованный HTTP-запрос,
не смешивая сессию аутентификации с существующими понятиями `WebSocketSession` и
`WebSocketClient`?

Дополнительно: как поддержать разные сценарии аутентификации, дать пользователю явно
выбирать и настраивать сценарий для каждой точки входа и подключать собственные механизмы
без изменения HTTP/WebSocket transport?

Исследование не меняет production-код. Его результат зафиксирован в
[ADR 0009](../../docs/adr/0009-auth-session-websocket-server-push.md), который явно заменяет
часть [ADR 0008](../../docs/adr/0008-websocket-message-protocol.md), исключавшую
authentication, объединение WebSocket-сессий и server push.

## Current repository constraints

- `Application` уже владеет общим `node:http` server, `WebSocketTransport` и
  `WebSocketSessionStore`. Поэтому общий application-owned компонент адресации согласуется с
  существующей границей владения.
- Текущий `WebSocketTransport` создаёт новый независимый `clientId` и `sessionId` через
  `randomUUID()` для каждого handshake. Оба идентификатора живут только до закрытия одного
  соединения и не могут связать последующий HTTP-запрос с этим соединением.
- `WebSocketSessionStore` индексирует только `sessionId -> { clientId, connection, sessionId }` и
  публичной отправки не предоставляет.
- `HttpRequestContext` содержит заголовки, но не результат аутентификации и не сессионный sender;
  новый экземпляр HTTP-контроллера получает только `jobRunner`.
- `daevox.v1` уже задаёт подходящий envelope `{ controller, event, body }`, однако ответы сейчас
  возможны только реактивно на входящее WebSocket-событие. Для push нужен исходящий путь через тот
  же encoder и те же ограничения `maxPayload`.
- Согласно [CONTEXT.md](../../CONTEXT.md), `WebSocketSession` — ровно одно соединение, а
  `WebSocketClient` — техническая сторона того же соединения, не пользователь и не аккаунт.
  Общая HTTP/WS идентичность зафиксирована отдельным термином **сессия аутентификации
  (`AuthSession`)** со стабильным непрозрачным `authSessionId`.

## Protocol and browser facts

1. WebSocket начинается с HTTP Upgrade request. RFC 6455 разрешает в handshake cookie и
   authentication headers, а сервер может выполнить дополнительную аутентификацию до ответа
   `101`. После успешного handshake начинается независимый двусторонний канал; последующие
   WebSocket-сообщения уже не являются HTTP-запросами. Поэтому HTTP и WS можно связать общей
   credential только во время handshake, а удаление cookie при logout само по себе уже открытое
   соединение не закрывает. Источник: [RFC 6455, sections 1.3, 4.1, 4.2 and
   10.5](https://www.rfc-editor.org/rfc/rfc6455.html).
2. Browser WebSocket API создаёт handshake с Fetch credentials mode `include`, то есть применимые
   cookies участвуют автоматически. Но конструктор принимает только URL и список subprotocols —
   стандартного параметра для произвольного `Authorization` header нет. Поэтому для обычного
   browser-клиента cookie является самым прямым способом повторно предъявить HTTP-сессию;
   bearer-only схема требует отдельного ticket/message flow. Источник: [WHATWG WebSockets,
   opening handshake и interface definition](https://websockets.spec.whatwg.org/#opening-handshake).
3. Cookie отправляется только когда подходят её host/domain, path, secure и lifetime rules. Для
   `/websocket` cookie должна иметь совместимый `Path`; production-соединение должно использовать
   `wss`, а session cookie — `Secure` и `HttpOnly`. `SameSite` влияет на cross-site handshake и не
   заменяет проверку `Origin`. Источники: [RFC 6265](https://www.rfc-editor.org/rfc/rfc6265.html),
   [одобренный RFC6265bis draft, sections 4.1.2 and
   8](https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-rfc6265bis).
4. Browser-клиент посылает `Origin`; RFC 6455 рекомендует серверу проверять ожидаемые origins.
   Cookie — ambient authority, поэтому без allowlist чужая web-страница может инициировать
   credentialed handshake. `Origin` является защитой браузерного сценария, но не идентичностью:
   non-browser клиент способен прислать произвольное значение и всё равно должен пройти обычную
   аутентификацию. Источник: [RFC 6455, sections 4.2.2 and
   10.2](https://www.rfc-editor.org/rfc/rfc6455.html#section-10.2).
5. Session cookie обычно содержит непрозрачный nonce, по которому сервер находит session state;
   спецификация отдельно предупреждает о session fixation. После входа или повышения привилегий
   идентификатор следует ротировать, а соединения старой сессии закрывать, не «повышать» их права
   на месте. Источник: [RFC 6265, section
   8.4](https://www.rfc-editor.org/rfc/rfc6265.html#section-8.4).

## Findings: target model

### Separate authentication identity from transport identity

Связующим ключом должен быть `authSessionId`, полученный доверенной серверной strategy.
HTTP- и WebSocket-credentials могут отличаться, но обе должны после проверки разрешаться в одну
каноническую `AuthSession`. Нельзя использовать:

- `clientId` или `sessionId`: сейчас они случайны и относятся к одному WebSocket-соединению;
- `userId` как замену: он объединит разные логины, устройства и сроки действия одной учётной
  записи, тогда как требование говорит о той же HTTP-сессии;
- значение `authSessionId`, присланное клиентом без проверки: клиент мог бы выбрать чужой адресат.

Внутренний registry должен хранить обе стороны отношения:

```text
authSessionId -> Set<WebSocketSessionId>
WebSocketSessionId -> { authSessionId, connection }
```

Это обычная server-side room/group модель. Похожая официально документированная реализация хранит
`rooms: Map<Room, Set<SocketId>>` и `sids: Map<SocketId, Set<Room>>`; тот же материал приводит
fan-out на каждое устройство/вкладку пользователя как штатный use case. Источник: [Socket.IO
Rooms](https://socket.io/docs/v4/rooms/). В Daevox имя `room` вводить необязательно: достаточно
углубить `WebSocketSessionStore` или выделить application-owned `WebSocketEventHub`, сохранив raw
socket приватным.

### Use one deep Authentication module with pluggable scenarios

Фреймворк не должен сам выбирать cookie, bearer, ticket, API key, mTLS или иную
модель. Внешний seam для `Application` должен быть один — глубокий модуль
`Authentication`. Он принимает нормализованную попытку обоих transport, выбирает заданный
пользователем сценарий и возвращает единую `AuthSession`.

Внутри модуля разделяются две роли:

- **authentication strategy** — adapter одного механизма credential: извлекает и проверяет cookie,
  bearer, ticket или пользовательскую credential;
- **authentication scenario** — именованная политика, которая задаёт состав strategies, их порядок,
  required/optional и правила fallback.

Authoritative session store, stateful lifecycle сессии, revalidation, revoke и distributed
invalidation остаются ответственностью пользователя. Framework не определяет для них отдельный
`AuthSessionAuthority`: stateful strategy при необходимости обращается к пользовательской
инфраструктуре внутри собственного `authenticate()`.

Авторизация HTTP-маршрута или WebSocket-события — другая ответственность. Её не следует
включать в первый интерфейс под именем authentication: strategy доказывает, кто клиент, а
authorization policy решает, можно ли ему выполнить операцию.

#### User-facing composition

Рекомендуемая форма конфигурации:

```js
const authentication = createAuthentication({
  strategies: {
    browserSession: cookieSession({
      cookie: { name: '__Host-session' },
      resolve: sessionStore.resolve,
    }),
    apiToken: bearerToken({ verify: accessTokens.verify }),
    socketTicket: oneTimeWebSocketTicket({ consume: tickets.consume }),
    partner: partnerAuthentication,
  },
  scenarios: {
    browser: { use: ['browserSession'], required: true },
    api: { use: ['apiToken'], required: true },
    websocket: {
      use: ['socketTicket', 'browserSession'],
      required: true,
    },
    public: { use: ['browserSession'], required: false },
  },
});

const application = new Application({
  authentication,
  websocket: {
    authentication: 'websocket',
  },
});
```

Готовые фабрики strategies облегчают типовые сценарии, но не вшивают в ядро формат session store,
JWT/OIDC provider или внешнюю базу. Каждая фабрика принимает пользовательские callbacks и строго
проверяет свою конфигурацию. Новый механизм credential можно реализовать custom strategy adapter с
тем же одним методом, не изменяя transport или controllers. Первая версия не определяет отдельный
контракт custom scenario: оркестрация strategies остаётся декларативной и строгой.

HTTP-маршрут выбирает сценарий локально:

```js
static routes = [
  {
    method: 'POST',
    path: '/orders',
    handler: 'create',
    authentication: 'browser',
  },
  {
    method: 'POST',
    path: '/imports',
    handler: 'import',
    authentication: 'api',
  },
  {
    method: 'GET',
    path: '/health',
    handler: 'health',
    authentication: false,
  },
];
```

Это требует явно расширить exact-key contract `HttpRouteDeclaration` и ADR 0002. Внешний selector по
path мог бы сохранить текущую форму маршрута, но ухудшил бы locality: security requirement жило бы
отдельно от HTTP-возможности. Для WebSocket сценарий выбирается на endpoint/handshake; личность
соединения не меняется от WebSocket-события к событию.

#### Strategy adapter contract

Один метод пользовательской strategy получает только нормализованные данные:

```js
const partnerAuthentication = {
  async authenticate(input) {
    // input: { transport, method, path, headers, query, signal }
    // no IncomingMessage, ServerResponse or socket
  },
};
```

Результат — строгий tagged union:

```js
{ status: 'abstain' }

{
  status: 'rejected',
  code: 'INVALID_CREDENTIALS',
  challenge: 'Bearer',
}

{
  status: 'authenticated',
  session: {
    authSessionId: 'opaque-id',
    principal: { id: 'user-42', roles: ['member'] },
    expiresAt: 1780000000000,
  },
}
```

`abstain` означает только полное отсутствие credential этой strategy. Невалидная, просроченная или
поддельная credential обязана вернуть `rejected`. Сценарий переходит к следующей strategy только
после `abstain`; `rejected` завершает его без fallback. Первая версия не предоставляет custom
scenario, способный ослабить это правило. Это предотвращает downgrade, когда неверный bearer или
ticket незаметно откатывается на cookie.

Два transport связываются, только если разные strategies вернули одинаковый `authSessionId`.
Совпадение `principal.id` недостаточно. Например, bearer HTTP-сценария и
одноразовый WebSocket ticket должны разрешаться в одну каноническую `AuthSession`.

HTTP transport вызывает модуль после нахождения HTTP-маршрута, но до чтения body. WebSocket transport
вызывает его после проверки endpoint, Upgrade, subprotocol и Origin, но до `101`. Так transport остаётся
ответственным за lifecycle, а `Authentication` — за выбор и выполнение сценария. Границы ADR 0003 и ADR
0005 сохраняются.

#### Alternatives compared

Рассматривались три формы интерфейса:

1. Одна функция `authentication(input)`. Минимальна и даёт полную свободу, но переносит выбор
   путей, fallback, challenge и downgrade-защиту в каждый пользовательский adapter.
2. Декларативный каталог scenarios и custom strategies. Даёт строгую оркестрацию, locality и
   пользовательские механизмы credentials, но сознательно не позволяет менять fallback policy.
3. Полный граф strategy/custom scenario/authority/authorizer/policy. Максимально гибок, но в первой версии создаёт
   широкий и мелкий интерфейс, а также смешивает authentication с authorization.

Гибрид выше сохраняет малый внешний seam, но даёт готовую безопасную оркестрацию и не закрывает
путь custom adapters.

### Give the HTTP handler a request-scoped sender

Для исходного требования безопаснее capability interface, уже привязанный к текущей
авторизованной сессии, чем глобальный interface `send(authSessionId, ...)`:

```js
await ctx.webSocket.send({
  controller: 'notifications',
  event: 'updated',
  body: { id: '...' },
});
```

`ctx.webSocket` существует только в авторизованном `HttpRequestContext` и внутри хранит
`authSessionId`; HTTP-обработчик не выбирает получателя. Это делает случайную или
злонамеренную отправку в чужую сессию невозможной на уровне публичного интерфейса. Альтернатива —
аналогичный request-scoped объект в конструкторе HTTP-контроллера, но контекст лучше отражает его
срок жизни и не расширяет глобальные полномочия экземпляра.

Для административного fan-out, фоновых задач и отправки по account/user нужен отдельный явно
привилегированный интерфейс в будущей задаче; он не должен появиться как побочный эффект текущего
решения.

### Multiple tabs and exact-tab targeting

Одна browser session cookie обычно общая для нескольких вкладок, каждая вкладка создаёт отдельную
`WebSocketSession`. Поэтому естественная семантика `ctx.webSocket.send()` — fan-out во **все
активные WebSocket-сессии той же `AuthSession`**. Это предотвращает случайный выбор вкладки и
поддерживает согласованное состояние UI.

Если продукту нужен ответ только во вкладку, инициировавшую HTTP-запрос, одной cookie недостаточно.
Нужен дополнительный `connectionId`/capability, выданный сервером после WS connect и переданный в
HTTP-запросе. Сервер обязан проверить, что этот connection действительно входит в множество
текущего `authSessionId`; затем можно сузить fan-out. Этот режим должен быть явным,
иначе отсутствие/устаревание connection ID даст труднообъяснимую доставку «в случайную вкладку».

### Future extension: logout and early revocation

Первая версия закрывает соединение только по локально известному `expiresAt`. Stateful logout,
досрочная revocation, generation/version и distributed invalidation отложены. Если framework будет
поддерживать их в будущем, logout должен будет быть серверной операцией над `AuthSession`, а не
только `Set-Cookie` с прошедшим сроком:

1. пометить/удалить session state в authoritative store и увеличить generation либо записать
   revocation version;
2. запретить новые HTTP-запросы и WS handshakes с прежней credential;
3. удалить membership всех соответствующих WebSocket-сессий и начать их closing handshake;
4. опубликовать revocation всем процессам при распределённом запуске;
5. клиент при close очищает локальное состояние и не переподключается без новой аутентификации.

Для прикладной причины закрытия можно зарезервировать код из private-use диапазона `4000–4999`;
этот диапазон определён RFC 6455. Номер и стабильное значение reason должны быть частью нового
протокольного решения: [RFC 6455, section
7.4.2](https://www.rfc-editor.org/rfc/rfc6455.html#section-7.4.2).

В таком будущем режиме есть гонка `connect <-> revoke`: проверка сессии до `registry.add()` сама по
себе недостаточна.
Практичная модель — version/generation в authoritative session state, запись этой версии в
membership и повторная проверка после регистрации. Revocation и push несут generation; процесс
отбрасывает событие, если локальная membership относится к другой версии. Для строгой гарантии
нужна атомарность в выбранном session store или сериализация команд по `authSessionId`.

До такого расширения framework не обещает немедленно закрывать уже открытые соединения по досрочной
revocation. Операции с высоким риском могут проверять актуальный session state внутри
пользовательской авторизации при обработке события.

### Future extension: multi-process and multi-node operation

Raw WebSocket connection принадлежит ровно тому процессу, который принял TCP connection; её
нельзя положить в общий store. Node `cluster` распределяет соединения между отдельными процессами
и прямо предупреждает не полагаться на in-memory objects для sessions/login. Источник: [Node.js
cluster documentation](https://nodejs.org/api/cluster.html#how-it-works).

Первая версия имеет только локальный registry с raw connections. Возможное будущее решение добавит
межпроцессный adapter, который пересылает
команду `{ authSessionId, generation, envelope, eventId }` всем потенциальным владельцам. Каждый
процесс делает локальный lookup и отправляет только своим соединениям. HTTP-запрос на node A не
обязан быть sticky к node B с WebSocket: sticky routing не решает случай нескольких вкладок и
отдельного HTTP traffic. Официальная документация Socket.IO также разделяет две задачи
multi-node deployment: load balancing и forwarding messages между servers. Источник: [Socket.IO,
Using multiple nodes](https://socket.io/docs/v4/using-multiple-nodes/).

Публичный интерфейс adapter не следует определять до отдельного исследования. Одна из возможных форм:

```text
publishToAuthSession(authSessionId, generation, envelope) -> PublishResult
revokeAuthSession(authSessionId, generation) -> void
```

Возможные distributed реализации:

- broadcast Pub/Sub channel + локальная фильтрация — проще, но каждое событие получают все nodes;
- channel per shard/session — меньше лишней работы, больше управления subscriptions;
- directory `authSessionId -> ownerNodeIds` + targeted channels — эффективнее, но появляется
  согласованность presence directory и очистка после падения node.

Redis Pub/Sub является возможным adapter, но не обязательной runtime-зависимостью фреймворка.
Его официальная семантика — at-most-once: отключённый subscriber теряет событие. Для persistence,
replay или at-least-once Redis рекомендует Streams. Источник: [Redis Pub/Sub delivery
semantics](https://redis.io/docs/latest/develop/pubsub/#delivery-semantics). Это согласуется с ADR
0001 только как пользовательский adapter после отдельного решения о зависимости; ядро может
поставлять лишь in-process реализацию.

### Delivery and failure semantics

Нужно явно различить четыре уровня результата:

1. business-операция HTTP завершилась;
2. событие опубликовано в local/distributed hub;
3. frame принят в write queue конкретного connection;
4. browser application обработал событие.

WebSocket и `socket.write()` сами по себе не подтверждают пункт 4. Node сообщает только, ушли ли
данные в kernel buffer или были поставлены в user-memory queue; `false` требует backpressure через
`drain`. Источник: [Node.js `net.Socket.write()`](https://nodejs.org/api/net.html#socketwritedata-encoding-callback).
Текущий `WebSocketConnection.send()` игнорирует boolean, возвращённый `socket.write()`, поэтому
будущая реализация push обязана отдельно определить лимит очереди и политику медленного клиента.

Рекомендуемая базовая семантика — ephemeral best effort:

- `send()` валидирует и сериализует envelope до fan-out;
- возвращает структурированный итог наподобие `{ matched, queued, dropped }`, но не обещает
  browser delivery;
- `matched: 0` является штатным исходом (нет открытого WS) и не превращает успешную HTTP business
  operation в `500`;
- закрытое соединение удаляется до/во время fan-out; частичная доставка по нескольким вкладкам
  отражается в результате и telemetry;
- на переполнении per-connection queue событие отбрасывается либо соединение закрывается по одной
  заранее выбранной политике; бесконечное буферирование запрещено;
- порядок сохраняется внутри очереди одного connection. Глобальный порядок между процессами или
  вкладками без sequence number не обещается.

Если событие является единственным источником данных и потеря недопустима, это уже durable
messaging: commit business state + outbox/stream, стабильный `eventId`, client acknowledgement,
deduplication, replay/reconciliation после reconnect. Такой режим существенно шире server push и
не должен маскироваться под успешный `send()`.

## Options

### Option A — shared session cookie at handshake

HTTP и WS resolver проверяют одну server-side session cookie; registry группирует connections по
полученному `authSessionId`.

Плюсы: browser отправляет cookie автоматически; secret не доступен JavaScript при `HttpOnly`;
естественно соответствует «той же HTTP-сессии»; минимум клиентского протокола.

Минусы: требуется правильный cookie scope и `Origin` allowlist; cross-site deployment зависит от
cookie/SameSite policy; logout требует явной серверной revocation connections.

### Option B — short-lived one-time WebSocket ticket

Авторизованный HTTP endpoint выдаёт одноразовый ticket, связанный с `authSessionId`, origin,
коротким TTL и nonce. Клиент использует ticket в WS handshake; сервер атомарно погашает его до
`101`.

Плюсы: работает при bearer-based HTTP auth и когда cookie нельзя/нежелательно посылать WS host;
не превращает долгоживущий access token в URL credential.

Минусы: дополнительный round trip, storage и гонки reuse/expiry; query URL может попасть в access
logs и history инфраструктуры, поэтому ticket должен быть одноразовым и очень коротким. Передача
секрета через `Sec-WebSocket-Protocol` смешивает credential с `daevox.v1` negotiation и также может
логироваться. Аутентификация первым WS message принимает unauthenticated connection и усложняет
lifecycle/DoS limits.

### Option C — client sends WebSocket `sessionId` with the HTTP request

Плюсы: позволяет выбрать точную вкладку.

Минусы: transport ID становится публичной credential; простое знание/подмена ID даёт confused
deputy; остаются reconnect races и multi-node routing. В качестве основной связи HTTP/WS вариант
неприемлем. Допустим только как дополнительное сужение адресата после серверной проверки, что
connection принадлежит уже аутентифицированной HTTP-сессии.

## Recommendation

1. Ввести один глубокий модуль `Authentication`: пользователь явно регистрирует strategies,
   собирает из них именованные scenarios и выбирает scenario для HTTP-маршрута и WebSocket
   handshake. Никакой credential-сценарий не включается неявно.
2. Поставлять готовые `cookieSession`, `bearerToken` и `oneTimeWebSocketTicket` как строго
   настраиваемые фабрики adapters. Cookie — удобный browser preset, а не обязательная модель
   framework. Любая custom strategy реализует тот же `authenticate(input)`.
3. Зафиксировать три исхода strategy: `abstain`, `rejected`, `authenticated`. Scenario продолжает
   fallback только после `abstain`; `rejected` всегда завершает authentication. Custom scenario в
   первой версии отсутствует.
4. Ввести отдельную `AuthSession` и не менять смысл существующих `clientId`/`sessionId`.
5. Добавить application-owned in-process hub с двусторонним local registry. Raw connections
   остаются локальными и приватными; distributed adapter в первой версии отсутствует.
6. Добавить `ctx.webSocket` как request-scoped capability, которая всегда адресует текущий
   `authSessionId`; default fan-out — все соединения этой сессии.
7. Выполнять WS authentication и exact `Origin` allowlist до `101`. Опциональный `expiresAt`
   локально закрывает соединение кодом `4001`; stateful logout/revocation остаётся ответственностью
   пользователя.
8. Зафиксировать best-effort semantics, результат `{ matched, queued, dropped }`, byte-based FIFO с
   default-лимитом `2 * maxPayload` и закрытие slow consumer кодом `1013`.
9. Зафиксировать решение successor ADR к ADR 0008. Это выполнено в
   [ADR 0009](../../docs/adr/0009-auth-session-websocket-server-push.md): он определяет
   `Authentication`, strategy/scenario contracts, выбор сценария, server-push addressing, multi-tab
   semantics, close codes, delivery guarantees и порядок `onConnect`, а также расширяет exact-key
   форму `HttpRouteDeclaration` из ADR 0002 полем `authentication`.

## Human review decisions

- Framework определяет `AuthSession`, authentication strategies и scenarios, но не authoritative
  session store и не `AuthSessionAuthority`. Stateful-аутентификацию пользователь реализует сам.
- Scenario продолжает fallback только после `abstain`; custom scenario, способный изменить это
  правило, в первой версии отсутствует.
- `ctx.webSocket.send()` отправляет событие всем активным WebSocket-сессиям текущей `AuthSession`.
  Точная вкладка, account-wide, device-wide и principal-wide адресация не поддерживаются.
- Встроенных guest sessions нет. `ctx.webSocket` существует только при наличии `AuthSession`.
- Push имеет best-effort семантику и не меняет HTTP status автоматически. `send()` возвращает
  `{ matched, queued, dropped }`; `matched: 0` является штатным результатом.
- Per-connection очередь является byte-based FIFO. Её default-лимит равен `2 * maxPayload`, а slow
  consumer при переполнении закрывается кодом `1013`.
- Первая версия работает только внутри одного экземпляра `Application`. Distributed/Redis adapter
  и межпроцессный контракт отложены.
- `send()` не атомарен с business state. Outbox, acknowledgement, replay и durable delivery не входят
  в scope.
- WebSocket authentication выполняется один раз при handshake. Опциональный `expiresAt` закрывает
  соединение кодом `4001`; periodic revalidation и in-band re-authentication отсутствуют.
- Порядок подключения: проверка handshake и `Origin`, authentication, создание context с
  `AuthSession`, `onConnect`, ответ `101`, регистрация membership, обработка сообщений.
- Решения, сознательно вынесенные из первой версии, перечислены в
  [`.plans/http-websocket-session-bridge-out-of-scope.md`](../../.plans/http-websocket-session-bridge-out-of-scope.md).

## Primary sources

- [WHATWG WebSockets Living Standard](https://websockets.spec.whatwg.org/)
- [RFC 6455 — The WebSocket Protocol](https://www.rfc-editor.org/rfc/rfc6455.html)
- [RFC 6265 — HTTP State Management Mechanism](https://www.rfc-editor.org/rfc/rfc6265.html)
- [RFC6265bis, approved draft in RFC Editor queue](https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-rfc6265bis)
- [Node.js `cluster` documentation](https://nodejs.org/api/cluster.html)
- [Node.js `net.Socket` documentation](https://nodejs.org/api/net.html)
- [Redis Pub/Sub documentation](https://redis.io/docs/latest/develop/pubsub/)
- [Socket.IO Rooms documentation](https://socket.io/docs/v4/rooms/)
- [Socket.IO multi-node documentation](https://socket.io/docs/v4/using-multiple-nodes/)
