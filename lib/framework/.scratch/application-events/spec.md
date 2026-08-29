# Адресуемые внутренние события

Status: accepted — [ADR 0011](../../docs/adr/0011-addressed-application-events.md)

## Назначение

Добавить адресуемые fire-and-forget события для независимой прикладной логики. HTTP- и
WebSocket-контроллер синхронно помещает событие в mailbox одного `EventListener`, после чего его результат и
ошибка не входят в транспортную операцию отправителя.

Механизм не является pub/sub: адрес `{ listener, event }` выбирает ровно один handler, подписок и fan-out нет.

## Публичный контракт

Listener напрямую наследует `EventListenerBase`, объявляет собственные статические `name` и `events` и регистрируется до
`Application.listen()`:

```js
class NewOrderPush {
  constructor(orderId) {
    this.orderId = orderId;
  }
}

class MailEventListener extends EventListenerBase {
  static name = 'mail';

  static events = [
    {
      name: 'NewOrderPush',
      data: NewOrderPush,
      handler: 'newOrderPush',
    },
  ];

  async newOrderPush(data, { signal }) {
    await this.jobRunner.run(SendMailJob, data, { signal });
  }
}

application.registerEventListener(MailEventListener);
```

HTTP- и WebSocket-контроллеры вызывают:

```js
this.events.push({ listener: 'mail', event: 'NewOrderPush' }, new NewOrderPush(order.id));
```

`push()` проверяет и копирует адрес, проверяет DTO через `instanceof`, помещает событие в mailbox и возвращает
`undefined`. DTO остаётся той же ссылкой; фреймворк не клонирует и не замораживает его. Базовый класс для DTO не вводится.

## Регистрация и зависимости

- listener напрямую наследует `EventListenerBase`;
- `static name` и имена событий соответствуют `^[A-Za-z0-9_-]+$`;
- `static events` — непустой массив строгих `{ name, data, handler }`;
- `data` — DTO-класс, `handler` — собственный метод prototype;
- дополнительные, symbol-, accessor- и унаследованные поля декларации запрещены;
- каталог копируется и замораживается при регистрации;
- повтор класса, listener name или адреса запрещён;
- все listener создаются во время `listen()`; ошибка конструктора переводит запуск в failed-состояние;
- lifecycle hooks listener и middleware внутренних событий не вводятся.

Матрица read-only, enumerable, non-configurable свойств:

| Получатель                | Свойства                           |
| ------------------------- | ---------------------------------- |
| `HttpControllerBase`      | `jobRunner`, `websocket`, `events` |
| `WebSocketControllerBase` | `jobRunner`, `events`              |
| `EventListenerBase`       | `jobRunner`, `websocket`           |

`EventListener` не получает `EventSender`, поэтому цепочки внутренних событий из listener невозможны.

## Mailbox и выполнение

- один долгоживущий экземпляр и один FIFO mailbox на listener;
- listener выполняются параллельно, а события одного listener — строго последовательно;
- `queueSize` считает только ожидающие события, но не активный handler;
- первый и каждый следующий handler запускаются в отдельном `setImmediate()`;
- handler может завершаться синхронно или Promise; его результат игнорируется;
- timeout начинается перед вызовом handler, отменяет `signal` с `EventHandlerTimeoutError` как reason и не включает ожидание в mailbox;
- после timeout следующее событие не запускается до settlement текущего handler;
- escaping error не заменяет экземпляр listener; целостность его состояния остаётся ответственностью listener;
- CPU-heavy работу listener явно передаёт в `jobRunner`; остальные риски блокирующего main-thread кода несёт приложение.

## Ошибки и наблюдение

Ошибки до принятия события синхронно выбрасываются из `push()`. Это ошибки опций, регистрации, адреса, DTO, переполнения и
закрытого sender.

Любая escaping error уже принятого handler изолируется от transport-операции и без обёртки передаётся в необязательный
`events.onError(error, context)`. Контекст — замороженные `{ listener, event }`; DTO не раскрывается. Observer не ожидается, а его ошибка передаётся в
`console.error`. Без observer исходная ошибка также передаётся в `console.error`.

Поздний rejection после уже сообщённого handler timeout или forced shutdown перехватывается, но повторно не наблюдается.
Специальная прикладная ошибка не вводится: listener сам ловит ожидаемые отказы.

Публичные ошибки:

- `InvalidEventOptionsError`;
- `InvalidEventListenerError`;
- `EventListenerConflictError`;
- `InvalidEventPushError`;
- `EventQueueFullError`;
- `EventSenderClosedError`;
- `EventHandlerTimeoutError`;
- `EventDroppedError`.

## Конфигурация

```js
new Application({
  events: {
    queueSize: 1000,
    handlerTimeout: 30_000,
    shutdownTimeout: 30_000,
    onError(error, context) {},
  },
  websocket: {
    shutdownTimeout: 30_000,
  },
});
```

Неизвестные поля запрещены. `queueSize`, `handlerTimeout`, `shutdownTimeout` и `websocket.shutdownTimeout` — положительные safe integer; нулевые,
бесконечные и отключённые timeout не поддерживаются. Defaults для `events.queueSize`, `events.handlerTimeout`, `events.shutdownTimeout` и
`websocket.shutdownTimeout` — `1000`, `30000`, `30000` и `30000` соответственно.

## Shutdown

`Application.close()`:

1. переводит приложение в `closing`;
2. прекращает новый HTTP- и WebSocket-ввод и закрывает WebSocket-сессии;
3. отдельно и ограниченно ждёт settlement HTTP-handler, WebSocket message-handler, pending upgrade, `onConnect` и `onDisconnect`;
4. после transport settlement или forced cutoff запечатывает `EventSender`;
5. ждёт пустых mailboxes до `events.shutdownTimeout`;
6. при forced event shutdown отменяет active signals, отбрасывает ожидающие события с `EventDroppedError` для каждого и перестаёт ждать active handler;
7. закрывает `Job Runner`;
8. переводит приложение в `closed`.

Бюджеты HTTP, WebSocket, events и jobs независимы и последовательно складываются. Поздний `push()` после cutoff выбрасывает `EventSenderClosedError`.
WebSocket send из listener во время drain остаётся best-effort и может выбросить `WebSocketClientNotFoundError`.

## Публичные экспорты

Экспортируются `EventListenerBase` и восемь публичных ошибок. `EventSender`, registry, dispatcher и mailbox остаются внутренними. `this.events` существует
у контроллера даже без зарегистрированных listener. Публичные `flush`, `size`, `isIdle` и каталог адресов не вводятся.

## План реализации

1. [`01-event-listener-contract-and-registry.md`](issues/01-event-listener-contract-and-registry.md) — публичный контракт, options, errors и registry.
2. [`02-event-mailbox-and-sender.md`](issues/02-event-mailbox-and-sender.md) — fire-and-forget sender, mailbox, timeout и error observation.
3. [`03-application-integration.md`](issues/03-application-integration.md) — регистрация, создание listener и инъекция фасадов.
4. [`04-transport-tracking-and-shutdown.md`](issues/04-transport-tracking-and-shutdown.md) — settlement tracking транспортов и полный shutdown.
5. [`05-document-and-verify-events.md`](issues/05-document-and-verify-events.md) — README, examples, generated docs и end-to-end проверка.

## Вне scope

- pub/sub, subscriptions и fan-out;
- persistence, retry, acknowledgements и exactly-once delivery;
- межпроцессная и распределённая доставка;
- отправка внутренних событий из `EventListener` и `Job`;
- middleware, priorities и lifecycle hooks listener;
- публичные flush и инспекция mailbox;
- базовый класс DTO;
- автоматический перенос listener в Worker.
