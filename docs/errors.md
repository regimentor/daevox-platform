# Ошибки и диагностика

Все публичные классы ошибок экспортируются из:

```js
import { HttpError } from 'daevox-node-framework/lib/framework/errors.js';
```

## Ошибки конфигурации и регистрации

Эти ошибки обычно означают программную ошибку и должны обнаруживаться при старте:

| Ошибка                              | Причина                                                  |
| ----------------------------------- | -------------------------------------------------------- |
| `InvalidHttpControllerError`        | Неверный базовый класс, metadata или HTTP-обработчик     |
| `InvalidHttpRouteError`             | Неверное объявление или путь HTTP-маршрута               |
| `DuplicateHttpControllerError`      | Повторная регистрация того же класса                     |
| `HttpRouteConflictError`            | Структурно одинаковые HTTP-маршруты одного метода        |
| `InvalidHttpOptionsError`           | Неверная конфигурация HTTP                               |
| `InvalidAuthenticationOptionsError` | Неверные catalogs, scenario, selector или adapter        |
| `InvalidWebSocketControllerError`   | Неверный класс, имя или WebSocket-событие                |
| `InvalidWebSocketOptionsError`      | Неверная или неявная WebSocket-конфигурация              |
| `DuplicateWebSocketControllerError` | Повторная регистрация класса                             |
| `WebSocketControllerConflictError`  | Одинаковое wire name разных контроллеров                 |
| `InvalidJobError`                   | Класс задачи нарушает контракт `Job`                     |
| `InvalidJobOptionsError`            | Неверная конфигурация пула или параметры запуска         |
| `ApplicationStateError`             | Регистрация/запуск недопустимы в текущем lifecycle state |

## Ошибки выполнения HTTP и Authentication

`HttpError` — единственная ожидаемая прикладная HTTP-ошибка. Она превращается в заданный
HTTP-ответ и не передаётся в `http.onError`.

Неожиданные ошибки HTTP-обработчика, неверный `HttpResponse` и сбой strategy передаются в
`http.onError`. Клиент получает безопасный `500`. Во время сбоя Authentication observer получает
контекст `{ phase: 'authentication', method, path, scenario, signal }` без headers, query и
credential.

`AuthenticationStrategyError` оборачивает ошибку strategy и содержит её стабильное имя в
`error.strategy`; исходная ошибка доступна как `error.cause`. Некорректный tagged result также
оборачивается, а его cause — `InvalidAuthenticationResultError`. `AuthenticationAbortedError`
означает отмену HTTP-запроса или WebSocket handshake.

## WebSocket

`WebSocketProtocolError` содержит `code`, `fatal`, `controller` и `event`. Транспорт сам отправляет
протокольный ответ либо закрывает соединение; `websocket.onError` нужен для журнала и метрик.
`InvalidWebSocketPushError` означает неверный push envelope,
`WebSocketPushPayloadTooLargeError` — превышение `websocket.maxPayload`.

Не записывайте в журнал headers, query или credentials: error contexts фреймворка специально
ограничены безопасными идентификаторами и фазой.

## Фоновые задачи

| Ошибка                  | Значение                                                        |
| ----------------------- | --------------------------------------------------------------- |
| `JobDataCloneError`     | Payload или результат несовместим со structured clone           |
| `JobQueueFullError`     | FIFO-очередь достигла `queueSize`                               |
| `JobAbortedError`       | Внешний signal или остановка приложения отменили задачу         |
| `JobTimedOutError`      | Истёк timeout запуска                                           |
| `JobExecutionError`     | `run()` выбросил ошибку; восстановленная причина в `cause`      |
| `WorkerTerminatedError` | Worker завершился до результата или был остановлен при shutdown |
| `JobRunnerClosedError`  | Запуск после начала закрытия приложения                         |

## Рекомендуемая наблюдаемость

Передавайте в журнал тип ошибки, `error.cause`, phase, controller/event, HTTP method/path,
`clientId`, `sessionId` и собственный correlation ID из прикладных данных. Не полагайтесь на тексты
ошибок как на стабильный API: для клиентских решений используйте HTTP status, authentication code,
WebSocket protocol code и `instanceof` публичного класса.
