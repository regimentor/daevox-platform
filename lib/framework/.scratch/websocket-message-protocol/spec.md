# Встроенный WebSocket-протокол сообщений

## Назначение

Заменить path-based WebSocket-контроллеры встроенным протоколом `daevox.v1`. Все соединения используют единый endpoint, а каждое сообщение в обе стороны имеет точный JSON-envelope `{ controller, event, body }` и маршрутизируется по декларативным метаданным WebSocket-контроллеров. Авторизация, server push и RPC-correlation не входят в эту версию.

Решение соответствует ADR 0001, 0003, 0005 и 0008. ADR 0008 заменяет ADR 0007.

## Конфигурация Application

```js
const application = new Application({
  websocket: {
    path: '/websocket',
    maxPayload: 1024 * 1024,
    async onConnect(ctx) {},
    async onDisconnect(ctx) {},
    onError(error, ctx) {},
  },
});
```

- `path` — путь единственного WebSocket endpoint; default `/websocket`.
- `maxPayload` — конечное неотрицательное целое число байтов; default 1 MiB.
- `onConnect`, `onDisconnect` и `onError` — необязательные функции.
- Неизвестные поля и неверные значения синхронно отклоняются `InvalidWebSocketOptionsError`.
- WebSocket-контроллеры регистрируются только до первого `listen()`.

## Handshake и lifecycle

- Клиент подключается к `websocket.path` и обязан предложить subprotocol `daevox.v1`.
- Неизвестный path даёт HTTP `404`; отсутствие поддерживаемого subprotocol даёт HTTP `400`.
- До `onConnect` фреймворк создаёт разные UUID v4 `clientId` и `sessionId` через `crypto.randomUUID()` и создаёт `AbortSignal` сессии.
- `onConnect` получает `{ clientId, sessionId, path, query, headers, signal }`; его возвращаемое значение игнорируется.
- Сессия добавляется во внутренний `WebSocketSessionStore` только после успешного `onConnect`.
- Ошибка `onConnect` передаётся в `onError` и отклоняет handshake ответом HTTP `500`.
- `onDisconnect` вызывается ровно один раз для принятой сессии и получает контекст подключения плюс `{ code, reason }`.
- Ошибка `onDisconnect` передаётся в `onError` и не меняет завершение сессии.
- Авторизация и объединение нескольких сессий одного пользователя не выполняются.
- `Application.close()` закрывает принятые сессии кодом `1001`, отменяет их сигналы и сохраняет согласованный порядок завершения ресурсов приложения.

## WebSocket-контроллер

```js
class NotificationsController extends WebSocketControllerBase {
  static name = 'notifications';

  static events = [
    { name: 'subscribe', handler: 'subscribe' },
    { name: 'mark_read', handler: 'markRead' },
  ];

  async subscribe(ctx) {
    return { subscribed: true };
  }

  async markRead(ctx) {
    // undefined означает отсутствие ответа.
  }
}
```

- Класс обязан напрямую наследовать `WebSocketControllerBase`.
- Класс объявляет собственное непустое `static name` и собственный непустой массив `static events`.
- Публичные имена контроллера и события соответствуют `^[A-Za-z0-9_-]+$`; регистр значим.
- Имена контроллеров уникальны в приложении; имена событий уникальны внутри контроллера.
- Определение события содержит ровно `{ name, handler }`; неизвестные и symbol-поля отклоняются.
- `handler` — непустая строка, указывающая на собственный метод-функцию прототипа; wire-грамматика на него не распространяется.
- Повторная регистрация класса отклоняется `DuplicateWebSocketControllerError`, конфликт имени — `WebSocketControllerConflictError`.
- Регистрация полностью валидирует и копирует метаданные до атомарного изменения каталога. Последующая мутация исходных объектов не влияет на маршрутизацию.
- Для каждого сообщения создаётся новый экземпляр найденного контроллера с зависимостью `{ jobRunner }`.
- `WebSocketControllerBase` не предоставляет `clientSessions` или raw socket.

## Envelope и JSON-совместимость

Каждый вход и выход является text frame с JSON-объектом ровно следующей формы:

```json
{
  "controller": "notifications",
  "event": "subscribe",
  "body": {}
}
```

- Envelope содержит ровно собственные enumerable string-поля `controller`, `event`, `body`; отсутствие, дополнительное поле или неверный тип отклоняются.
- `controller` и `event` соответствуют wire-грамматике имён.
- `body` на верхнем уровне является plain object, но не `null` и не массивом.
- Рекурсивно разрешены `null`, строки, boolean, конечные числа, плотные массивы и plain objects.
- Запрещены `undefined`, `NaN`, бесконечности, `BigInt`, функции, symbol, sparse arrays, циклы, экземпляры классов, custom prototypes и неподдерживаемые property keys/descriptors.
- Значения не преобразуются через пользовательский `toJSON`; не допускается тихая потеря или замена данных при сериализации.
- Верхнеуровневое собственное поле `body.error` зарезервировано для протокола; успешный результат обработчика не может его содержать.
- Binary frames не поддерживаются.

## Диспетчеризация и ответ

- Транспорт находит контроллер по `controller`, затем событие по `event`, создаёт новый экземпляр контроллера и вызывает найденный handler.
- Handler получает новый объект `{ body, clientId, sessionId, signal }`; socket и transport objects не раскрываются.
- Синхронные и асинхронные handlers обрабатываются одинаково.
- Handler возвращает `undefined` либо JSON-совместимый plain object по правилам `body`.
- `undefined` завершает обработку без ответа.
- Объект автоматически отправляется как `{ controller, event, body: result }` с адресом входящего сообщения.
- Server push, изменение адреса ответа и correlation ID отсутствуют.
- Сообщения одной сессии выполняются строго последовательно, ответы сохраняют входной порядок, ошибка не останавливает очередь.
- Разные сессии выполняются независимо и могут обрабатываться параллельно.

## Ошибки протокола

Адресуемая ошибка возвращает text frame:

```json
{
  "controller": "notifications",
  "event": "subscribe",
  "body": {
    "error": {
      "code": "UNKNOWN_EVENT"
    }
  }
}
```

Стабильные коды:

- `INVALID_MESSAGE` — адрес известен, но envelope или `body` нарушает контракт;
- `UNKNOWN_CONTROLLER` — синтаксически допустимый контроллер не зарегистрирован;
- `UNKNOWN_EVENT` — синтаксически допустимое событие не зарегистрировано у найденного контроллера;
- `HANDLER_ERROR` — handler или конструктор контроллера выбросил исключение;
- `INVALID_RESPONSE` — результат handler нарушает контракт, содержит зарезервированное поле или превышает лимит.

После адресуемой ошибки соединение остаётся открытым и продолжает очередь сообщений. Детали внутренних исключений клиенту не раскрываются.

- Binary frame закрывает соединение кодом `1003`.
- Невалидный JSON, не-объектный envelope или невозможность извлечь синтаксически допустимые `controller/event` закрывает соединение кодом `1007`.
- Входное сообщение больше `maxPayload` закрывает соединение кодом `1009` до JSON-разбора.
- `maxPayload` также ограничивает сериализованный исходящий envelope. Слишком большой результат даёт `INVALID_RESPONSE`; невозможность отправить даже error envelope закрывает соединение кодом `1011`.
- Все нарушения создают публичный `WebSocketProtocolError` со стабильным `code` и передаются в `websocket.onError(error, ctx)`.
- Контекст ошибки содержит доступные `{ clientId, sessionId, controller, event, signal }`; неизвестные значения отсутствуют.
- Исходная ошибка handler передаётся в `onError` как есть, но клиент получает только `HANDLER_ERROR`.
- Возврат или Promise `onError` не ожидается; его собственная ошибка безопасно передаётся в `console.error`.

## Публичные ошибки

- `WebSocketProtocolError extends Error` содержит стабильное строковое `code`.
- `InvalidWebSocketControllerError extends TypeError` покрывает класс, наследование, метаданные, handler и прямое создание базы.
- `DuplicateWebSocketControllerError extends Error` покрывает повторную регистрацию класса.
- `WebSocketControllerConflictError extends Error` покрывает конфликт публичного имени.
- `InvalidWebSocketOptionsError extends TypeError` покрывает конфигурацию.
- Ошибки доступны прямыми импортами и поддерживают `instanceof`.

## Проверки и документация

- Unit-тесты покрывают конфигурацию, метаданные, атомарную регистрацию, копирование деклараций, JSON-валидацию, ошибки и `WebSocketControllerBase`.
- Integration-тесты на реальном ephemeral-порту покрывают handshake, subprotocol, hooks, маршрутизацию, порядок, ответы, все error codes, close codes, payload limits и shutdown.
- README документирует только новый публичный контракт после его реализации.
- WebSocket example использует `daevox.v1`, декларативные события и необязательный реактивный ответ.
- Используются только JavaScript-файлы `.js` и встроенные API Node.js; runtime-зависимости не добавляются.
- `npm run check` завершается успешно.

## Вне scope

- Авторизация, аутентификация и пользовательская идентичность.
- Несколько сессий одного логического клиента и восстановление `clientId`.
- Server push и публичный API произвольной отправки сообщений.
- Request ID, correlation ID, RPC и сопоставление ответа конкретному запросу.
- Binary application messages, пользовательские codecs, compression и fragmented-message streaming.
- Compatibility mode со старым path/lifecycle/raw-message контрактом.
- Версии протокола кроме `daevox.v1` и согласование нескольких версий.
