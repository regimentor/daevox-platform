# HTTP

## HTTP-контроллер и HTTP-маршруты

HTTP-контроллер должен напрямую наследовать `HttpControllerBase`, объявить собственные статические
поля `prefix` и `routes`, а также собственный метод для каждого HTTP-обработчика.

```js
import { HttpControllerBase } from 'daevox-node-framework/lib/framework/HttpControllerBase.js';

export class UsersHttpController extends HttpControllerBase {
  static prefix = '/users';
  static routes = [
    { method: 'GET', path: '/', handler: 'list', authentication: false },
    { method: 'GET', path: '/:id', handler: 'getById', authentication: false },
    { method: 'POST', path: '/', handler: 'create', authentication: 'api' },
  ];

  list() {
    return { status: 200, body: { users: [] } };
  }

  getById(ctx) {
    return { status: 200, body: { id: ctx.params.id } };
  }

  create(ctx) {
    return { status: 201, body: ctx.body };
  }
}
```

Объявление каждого HTTP-маршрута содержит ровно четыре поля:

- `method` — непустой HTTP token; при регистрации приводится к верхнему регистру;
- `path` — абсолютный путь относительно `prefix`;
- `handler` — имя собственного метода прототипа;
- `authentication` — имя существующего scenario либо `false`.

Поддерживаются статические сегменты и параметры `:name`. Имя параметра начинается с латинской
буквы и затем содержит только буквы или цифры. Wildcard-маршрутов нет. Статический HTTP-маршрут
при совпадении имеет приоритет над параметризованным. Структурно одинаковые HTTP-маршруты одного
метода, например `/:id` и `/:name`, конфликтуют уже при регистрации.

Сегменты percent-decoded до передачи в `ctx.params`. `.` и `..`, backslash, управляющие символы,
закодированные `?` и `#` запрещены. Некорректное percent-encoding запроса даёт `400`.

Для каждого найденного HTTP-маршрута создаётся новый экземпляр HTTP-контроллера. Состояние между
запросами храните во внешних зависимостях приложения, а не в экземпляре контроллера.

## Контекст HTTP-запроса

HTTP-обработчик получает замороженный объект:

```js
{
  method,       // string, верхний регистр
  path,         // string, pathname
  params,       // замороженный Object<string, string>
  query,        // отдельный URLSearchParams
  headers,      // отдельный WHATWG Headers
  body,         // разобранный JSON или undefined
  signal,       // AbortSignal
  authSession,  // только после успешной Authentication
  webSocket,    // только вместе с authSession
}
```

`signal` отменяется при разрыве запроса клиентом и при принудительном завершении приложения.
Передавайте его операциям ввода-вывода и `this.jobRunner.run()`.

Непустое тело должно иметь `Content-Type: application/json` или media type с суффиксом `+json` и
UTF-8 charset. Пустое тело даёт `body === undefined`. Превышение `bodyLimit` даёт `413`, другой
media type — `415`, некорректный UTF-8 или JSON — `400`.

## HTTP-ответ

HTTP-обработчик возвращает объект с `status` от `200` до `599` и необязательными `headers`, `body`:

```js
return {
  status: 200,
  headers: new Headers({ 'x-revision': '7' }),
  body: { ok: true },
};
```

| Тип `body`                        | Автоматический `content-type`     |
| --------------------------------- | --------------------------------- |
| строка                            | `text/plain; charset=utf-8`       |
| `Buffer` или `Uint8Array`         | `application/octet-stream`        |
| другое JSON-представимое значение | `application/json; charset=utf-8` |
| `undefined`                       | не устанавливается                |

Явный `content-type` имеет приоритет. `content-length`, `transfer-encoding` и `connection`
устанавливает транспорт; HTTP-обработчик не может задавать их. Для `HEAD`, `204` и `304` тело не
отправляется. Если отдельный `HEAD` HTTP-маршрут отсутствует, используется соответствующий `GET`.
Для известного пути `OPTIONS` автоматически отвечает `204`, а неверный метод — `405`; оба ответа
содержат `Allow`. Неизвестный путь даёт `404`.

## Ожидаемые ошибки

Для ошибки, которую можно безопасно показать клиенту, выбросьте `HttpError`:

```js
import { HttpError } from 'daevox-node-framework/lib/framework/errors.js';

throw new HttpError(422, {
  headers: new Headers({ 'x-error-code': 'INVALID_EMAIL' }),
  body: { error: { code: 'INVALID_EMAIL' } },
});
```

Статус `HttpError` находится в диапазоне `400..599`. Неожиданная ошибка передаётся в
`http.onError(error, ctx)` и становится безопасным `500` без раскрытия её текста клиенту.

## WebSocket server push из HTTP

После успешной Authentication контекст содержит `ctx.webSocket.send(envelope)`. Он адресует
сообщение всем локальным WebSocket-сессиям той же `AuthSession`. Подробности — в разделе
[server push](websocket.md#server-push-из-http).
