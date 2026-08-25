# WebSocket и протокол `daevox.v1`

Все WebSocket-контроллеры публикуются через один endpoint приложения. Клиент обязан предложить
subprotocol `daevox.v1`; поддерживаются только текстовые JSON-сообщения.

## WebSocket-контроллер

```js
import { WebSocketControllerBase } from 'daevox-node-framework/lib/framework/WebSocketControllerBase.js';

export class NotificationsWebSocketController extends WebSocketControllerBase {
  static name = 'notifications';
  static events = [
    { name: 'subscribe', handler: 'subscribe' },
    { name: 'mark_read', handler: 'markRead' },
  ];

  subscribe(ctx) {
    return { subscribed: ctx.body.topic };
  }

  markRead() {
    return undefined;
  }
}
```

Класс напрямую наследует `WebSocketControllerBase`. `name` и имена событий состоят из латинских
букв, цифр, `_` и `-`; массив `events` непустой, имена в нём уникальны. Каждый элемент содержит
ровно `name` и имя собственного метода `handler`. Для каждого найденного сообщения создаётся новый
экземпляр контроллера.

Обработчик получает замороженный `{ body, clientId, sessionId, signal }`. `signal` отменяется при
закрытии соединения. `clientId` и `sessionId` — отдельные UUID одной физической WebSocket-сессии;
они не являются identity. `this.jobRunner` позволяет запускать фоновые задачи.

## Формат сообщения

Запрос и успешный ответ используют точный envelope без дополнительных полей:

```json
{ "controller": "notifications", "event": "subscribe", "body": { "topic": "news" } }
```

```json
{ "controller": "notifications", "event": "subscribe", "body": { "subscribed": "news" } }
```

`body` — простой JSON-объект, не массив и не `null`. Ответ обработчика должен быть таким же
JSON-совместимым объектом и не может содержать верхнеуровневое поле `error`. `undefined` означает,
что ответ отправлять не нужно. Протокол не содержит correlation ID и не является RPC; сообщения
одной WebSocket-сессии обрабатываются последовательно.

## Подключение клиента

```js
const socket = new WebSocket('wss://api.example.com/websocket', 'daevox.v1');

socket.addEventListener('open', () => {
  socket.send(
    JSON.stringify({
      controller: 'notifications',
      event: 'subscribe',
      body: { topic: 'news' },
    }),
  );
});
```

Handshake проверяет путь, стандартные WebSocket-заголовки, версию 13, subprotocol, Origin и
настроенный Authentication scenario до ответа `101`. Browser Origin должен точно входить в
`allowedOrigins`. Не-browser клиент без `Origin` разрешён.

## Lifecycle hooks

`websocket.onConnect(ctx)` вызывается после Authentication, но до upgrade и регистрации сессии.
Контекст содержит `clientId`, `sessionId`, `path`, `signal`, а также `origin?` и `authSession?`.
Ошибка hook отклоняет handshake с `500`.

`websocket.onDisconnect(ctx)` получает `clientId`, `sessionId`, `code`, `reason`, уже отменённый
`signal` и `authSession?`. `Application.close()` ждёт завершения этих hooks.

`websocket.onError(error, ctx)` наблюдает ошибки фаз `handshake`, `connect`, `session` и
`disconnect`. Ошибка самого observer не влияет на транспорт. Подробнее см. [диагностику](errors.md).

Если у `AuthSession` задан `expiresAt`, соединение закрывается в момент истечения кодом `4001` и
причиной `Authentication expired`. Для продолжения нужен новый handshake.

## Ошибки протокола

Адресуемая ошибка возвращает envelope с теми же `controller` и `event`:

```json
{
  "controller": "notifications",
  "event": "missing",
  "body": { "error": { "code": "UNKNOWN_EVENT" } }
}
```

| Код                  | Значение                                            |
| -------------------- | --------------------------------------------------- |
| `INVALID_MESSAGE`    | Envelope или `body` не соответствует протоколу      |
| `UNKNOWN_CONTROLLER` | WebSocket-контроллер не зарегистрирован             |
| `UNKNOWN_EVENT`      | WebSocket-событие не объявлено                      |
| `HANDLER_ERROR`      | Обработчик выбросил ошибку                          |
| `INVALID_RESPONSE`   | Результат обработчика нельзя отправить по протоколу |

Невалидный JSON или envelope без надёжного адреса закрывает соединение кодом `1007`; binary —
кодом `1003`. Превышение входящего `maxPayload` закрывает соединение, а переполнение исходящей
очереди slow consumer — кодом `1013`.

## Server push из HTTP

Авторизованный HTTP-обработчик может отправить событие всем локальным WebSocket-сессиям той же
`AuthSession`:

```js
const result = ctx.webSocket.send({
  controller: 'notifications',
  event: 'changed',
  body: { revision: 7 },
});
// { matched: 2, queued: 2, dropped: 0 }
```

- `matched` — найденные локальные соединения;
- `queued` — соединения, чья очередь приняла frame;
- `dropped` — соединения, отказавшие из-за закрытия или backpressure.

`matched: 0` — штатный результат. `queued` подтверждает только локальную постановку, а не доставку
или обработку клиентом. Push локален одному `Application`, ephemeral, best-effort и не атомарен с
изменением business state. Для надёжной или распределённой доставки приложение добавляет outbox,
broker, acknowledgements и retries самостоятельно.
