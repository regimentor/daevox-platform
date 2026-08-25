# Authentication

Authentication подтверждает identity; authorization остаётся политикой приложения. Фреймворк не
хранит пользователей или сессии, не выпускает credentials и не проверяет JWT/OIDC самостоятельно.

## Strategies и scenarios

Strategy извлекает или проверяет один вид credential. Scenario выполняет перечисленные strategies
по порядку:

```js
import { createAuthentication } from 'daevox-node-framework/lib/framework/Authentication.js';

const authentication = createAuthentication({
  strategies: {
    apiToken: {
      async authenticate(input) {
        const token = input.headers.get('x-api-token');
        if (token === null) return { status: 'abstain' };
        const record = await tokenStore.find(token, { signal: input.signal });
        if (!record) return { status: 'rejected', code: 'INVALID_TOKEN' };
        return {
          status: 'authenticated',
          session: {
            authSessionId: record.sessionId,
            principal: { subject: record.subject, roles: record.roles },
            expiresAt: record.expiresAt,
          },
        };
      },
    },
  },
  scenarios: {
    api: { use: ['apiToken'], required: true },
    apiOptional: { use: ['apiToken'], required: false },
  },
});
```

Допустимы ровно три результата strategy:

- `{ status: 'abstain' }` — подходящий credential отсутствует; scenario пробует следующую strategy;
- `{ status: 'rejected', code, challenge? }` — credential присутствует, но отклонён; scenario
  немедленно завершается;
- `{ status: 'authenticated', session }` — identity подтверждена.

Если все strategies ответили `abstain`, required scenario возвращает
`AUTHENTICATION_REQUIRED`, optional scenario — `abstain`. Для HTTP отказ становится `401` с JSON
`{ "error": { "code": "..." } }`; `challenge`, если он есть, становится `WWW-Authenticate`.

Strategy получает отдельный замороженный input: `transport`, `method`, `path`, копии `Headers` и
`URLSearchParams`, `signal`, а для WebSocket при наличии — проверенный `origin`. Не записывайте в
журнал credential или весь input.

## AuthSession

```js
{
  authSessionId: 'opaque-stable-id',
  principal: { subject: '42', roles: ['reader'] },
  expiresAt: Date.now() + 3_600_000,
}
```

`authSessionId` — непустой непрозрачный идентификатор общей подтверждённой identity. `principal` —
JSON-совместимый объект; фреймворк глубоко копирует и замораживает его. `expiresAt`, если
задан, — будущее Unix-время в миллисекундах. Истёкшая сессия отклоняется.

`AuthSession` не равна WebSocket-сессии: две вкладки могут иметь разные `clientId` и `sessionId`, но
один `authSessionId`. HTTP-контекст и WebSocket lifecycle hooks получают `authSession`; обработчик
WebSocket-события получает только транспортные данные события и не получает `authSession`.

## Готовые adapters

```js
import {
  bearerToken,
  cookieSession,
  oneTimeWebSocketTicket,
} from 'daevox-node-framework/lib/framework/authenticationStrategies.js';
```

### Bearer token

```js
const strategy = bearerToken({
  verify: (token, { transport, signal }) => tokenStore.verify(token, { transport, signal }),
});
```

Читает единственный `Authorization: Bearer <token68>` для HTTP или WebSocket. Нет заголовка —
`abstain`; malformed, неизвестный или истёкший token — `INVALID_TOKEN` с challenge `Bearer`.
Callback возвращает `AuthSession` или `null`.

### Session cookie

```js
const strategy = cookieSession({
  cookie: { name: '__Host-session' },
  resolve: (value, { transport, signal }) => sessionStore.resolve(value, { transport, signal }),
});
```

Ищет единственную cookie с точным регистрозависимым именем. Отсутствие — `abstain`; повтор,
malformed, неизвестная или истёкшая cookie — `INVALID_SESSION`. Атрибуты `Secure`, `HttpOnly`,
`SameSite`, создание и отзыв cookie реализует приложение.

### Одноразовый WebSocket ticket

```js
const strategy = oneTimeWebSocketTicket({
  consume: (ticket, { origin, signal }) => ticketStore.consume(ticket, { origin, signal }),
});
```

Работает только для WebSocket handshake и читает единственный query parameter `ticket`. Callback
обязан атомарно погасить ticket и вернуть `AuthSession` либо `null`. Повтор, пустое, неизвестное или
истёкшее значение даёт `INVALID_TICKET`. Для HTTP strategy отвечает `abstain`.

## Подключение к транспортам

```js
const application = new Application({
  authentication,
  websocket: {
    authentication: 'browser',
    allowedOrigins: ['https://app.example.com'],
  },
});
```

Каждый HTTP-маршрут отдельно выбирает scenario или `false`. WebSocket endpoint делает такой выбор
один раз в конфигурации. Указанное имя должно существовать при создании приложения или регистрации
HTTP-контроллера.

Authorization проверяйте в HTTP-обработчике по `ctx.authSession.principal`. Для WebSocket
authorization, зависящей от identity, применяйте `onConnect` или заранее выдавайте узко
авторизованный одноразовый ticket: identity намеренно не передаётся обработчику события.
