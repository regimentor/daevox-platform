# Приложение и жизненный цикл

`Application` — общая точка композиции HTTP, WebSocket, Authentication и фоновых задач. Один
экземпляр владеет всеми созданными им транспортными ресурсами и Worker Pool.

## Конфигурация

```js
const application = new Application({
  authentication,
  http: {
    bodyLimit: 1024 * 1024,
    shutdownTimeout: 30_000,
    onError(error, ctx) {
      console.error(error, ctx);
    },
  },
  websocket: {
    authentication: 'browser',
    allowedOrigins: ['https://app.example.com'],
    path: '/websocket',
    maxPayload: 1024 * 1024,
    maxWriteQueueBytes: 2 * 1024 * 1024,
    onConnect(ctx) {},
    onDisconnect(ctx) {},
    onError(error, ctx) {},
  },
  jobs: {
    poolSize: 4,
    queueSize: 1000,
    defaultTimeout: 10_000,
    terminationGracePeriod: 1_000,
    shutdownTimeout: 30_000,
  },
});
```

Все разделы, кроме `websocket`, необязательны. Объекты конфигурации проверяются строго: неизвестные
поля и значения `undefined` в явно переданных полях считаются ошибкой.

| Параметр                       |             По умолчанию | Назначение                                        |
| ------------------------------ | -----------------------: | ------------------------------------------------- |
| `http.bodyLimit`               |                `1048576` | Максимум байтов непустого HTTP-тела               |
| `http.shutdownTimeout`         |                  `30000` | Ожидание активных HTTP-запросов при остановке, мс |
| `websocket.authentication`     |                      нет | Обязательный scenario или явное `false`           |
| `websocket.allowedOrigins`     |                     `[]` | Точный allowlist browser Origin                   |
| `websocket.path`               |             `/websocket` | Единый WebSocket endpoint                         |
| `websocket.maxPayload`         |                `1048576` | Максимум байтов сообщения протокола               |
| `websocket.maxWriteQueueBytes` |         `2 * maxPayload` | Очередь исходящих frames на соединение            |
| `jobs.poolSize`                | `availableParallelism()` | Число Worker                                      |
| `jobs.queueSize`               |                   `1000` | Максимум ожидающих задач                          |
| `jobs.defaultTimeout`          |          без ограничения | Тайм-аут одного запуска, мс                       |
| `jobs.terminationGracePeriod`  |                   `1000` | Пауза между отменой и остановкой Worker, мс       |
| `jobs.shutdownTimeout`         |                  `30000` | Ожидание активных задач при остановке, мс         |

`allowedOrigins` содержит только canonical origins вида `https://example.com` без пути, query и
fragment. Пустой список разрешает handshake без заголовка `Origin`, но отклоняет browser handshake
с любым Origin. Для браузерного клиента перечислите каждый допустимый origin явно.

## Регистрация и запуск

HTTP- и WebSocket-контроллеры регистрируются до запуска. Оба метода возвращают тот же экземпляр,
поэтому регистрацию можно объединять в цепочку:

```js
application
  .registerHttpController(UsersHttpController)
  .registerWebSocketController(NotificationsWebSocketController);

const address = await application.listen({ port: 3000, host: '127.0.0.1' });
```

`port` обязателен; значение `0` позволяет операционной системе выбрать свободный порт. `listen()`
можно вызвать ровно один раз. После начала запуска новые контроллеры не принимаются.

## Корректное завершение

`close()` идемпотентен: повторные вызовы возвращают ту же операцию. Приложение:

1. закрывает WebSocket-сессии кодом `1001`;
2. прекращает принимать новые соединения;
3. ждёт активные HTTP-запросы до `http.shutdownTimeout`, затем отменяет их `AbortSignal` и закрывает;
4. ждёт WebSocket disconnect hooks;
5. прекращает принимать задачи, снимает ожидающие задачи и закрывает Worker Pool.

После `close()` приложение нельзя запустить снова. Сигналы процесса подключайте в коде приложения,
как показано в [быстром старте](getting-started.md).
