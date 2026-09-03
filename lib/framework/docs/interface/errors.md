# Карта публичных ошибок

Карта связывает публичный error-класс с seam, на котором он возникает, и наблюдаемым эффектом.
Точные конструкторы и поля находятся в [generated errors module](../api/errors.md).

## Application

| Класс                                                             | Операция                                                                         | Эффект                              |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------- |
| [`ApplicationStateError`](../api/errors.md#applicationstateerror) | Поздняя регистрация, повторный `listen()` или использование закрытого приложения | Синхронный отказ lifecycle-операции |

## HTTP

| Класс                                                                           | Операция                                                        | Эффект                                                        |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------- |
| [`InvalidHttpControllerError`](../api/errors.md#invalidhttpcontrollererror)     | `registerHttpController()` с неверным классом или metadata      | Регистрация атомарно отклонена                                |
| [`InvalidHttpRouteError`](../api/errors.md#invalidhttprouteerror)               | Неверная декларация HTTP-маршрута или handler                   | Регистрация атомарно отклонена                                |
| [`DuplicateHttpControllerError`](../api/errors.md#duplicatehttpcontrollererror) | Повтор класса HTTP-контроллера                                  | Регистрация отклонена                                         |
| [`HttpRouteConflictError`](../api/errors.md#httprouteconflicterror)             | Конфликт структурно одинаковых HTTP-маршрутов одного метода     | Регистрация отклонена без частичного каталога                 |
| [`InvalidHttpPathEncodingError`](../api/errors.md#invalidhttppathencodingerror) | Некорректное percent-encoding при регистрации или маршрутизации | Регистрация отклонена либо HTTP `400`                         |
| [`InvalidHttpOptionsError`](../api/errors.md#invalidhttpoptionserror)           | Неверная секция `http` в `ApplicationOptions`                   | Создание `Application` отклонено                              |
| [`HttpError`](../api/errors.md#httperror)                                       | Ожидаемый отказ HTTP-handler или `onConnect`                    | Заданный HTTP status, headers и body; `onError` не вызывается |
| [`HttpRequestBodyError`](../api/errors.md#httprequestbodyerror)                 | Malformed body либо неподдерживаемый media type/charset         | Безопасный `400` или `415`; может быть перехвачен middleware  |

## WebSocket

| Класс                                                                                     | Операция                                                 | Эффект                                                                                      |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [`InvalidWebSocketControllerError`](../api/errors.md#invalidwebsocketcontrollererror)     | Неверный класс, `name`, `events`, middleware или handler | Регистрация атомарно отклонена                                                              |
| [`InvalidWebSocketOptionsError`](../api/errors.md#invalidwebsocketoptionserror)           | Неверная секция `websocket`                              | Создание `Application` отклонено                                                            |
| [`DuplicateWebSocketControllerError`](../api/errors.md#duplicatewebsocketcontrollererror) | Повтор класса WebSocket-контроллера                      | Регистрация отклонена                                                                       |
| [`WebSocketControllerConflictError`](../api/errors.md#websocketcontrollerconflicterror)   | Повтор wire-name контроллера или события                 | Регистрация атомарно отклонена                                                              |
| [`InvalidWebSocketSendError`](../api/errors.md#invalidwebsocketsenderror)                 | Неверный target или envelope `this.websocket.send()`     | Синхронный отказ server push                                                                |
| [`WebSocketClientNotFoundError`](../api/errors.md#websocketclientnotfounderror)           | Server push для неизвестного `clientId`                  | Синхронный отказ без отправки                                                               |
| [`WebSocketEventError`](../api/errors.md#websocketeventerror)                             | Ожидаемый прикладной отказ middleware или handler        | Адресуемый application code; сессия и очередь сохраняются                                   |
| [`WebSocketProtocolError`](../api/errors.md#websocketprotocolerror)                       | Нарушение `daevox.v1` или кодирования ответа             | Адресуемый framework code либо закрытие сессии; ошибка наблюдаема через `websocket.onError` |

## Внутренние события

| Класс                                                                       | Операция                                                | Эффект                                                                  |
| --------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`InvalidEventOptionsError`](../api/errors.md#invalideventoptionserror)     | Неверная секция `events`                                | Создание `Application` отклонено                                        |
| [`InvalidEventListenerError`](../api/errors.md#invalideventlistenererror)   | Неверный класс, `name`, декларация или handler listener | Регистрация отклонена                                                   |
| [`EventListenerConflictError`](../api/errors.md#eventlistenerconflicterror) | Повтор класса, имени listener или адреса                | Регистрация атомарно отклонена                                          |
| [`InvalidEventPushError`](../api/errors.md#invalideventpusherror)           | Неверный вызов, адрес или DTO                           | `push()` синхронно отклонён до acceptance                               |
| [`EventQueueFullError`](../api/errors.md#eventqueuefullerror)               | Mailbox достиг `queueSize`                              | `push()` синхронно отклонён до acceptance                               |
| [`EventSenderClosedError`](../api/errors.md#eventsenderclosederror)         | `push()` после forced transport cutoff или seal         | Синхронный отказ отправителя                                            |
| [`EventHandlerTimeoutError`](../api/errors.md#eventhandlertimeouterror)     | Handler превысил `handlerTimeout`                       | `signal.reason`, однократное наблюдение; FIFO ждёт settlement           |
| [`EventDroppedError`](../api/errors.md#eventdroppederror)                   | Ожидающее событие отброшено при forced shutdown         | Наблюдение через `events.onError`; `Application.close()` не отклоняется |

## Фоновые задачи

| Класс                                                               | Операция                                            | Эффект                                                        |
| ------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------- |
| [`InvalidJobError`](../api/errors.md#invalidjoberror)               | `run()` с неверным классом или модулем `Job`        | Запуск отклонён до пользовательского `run()`                  |
| [`InvalidJobOptionsError`](../api/errors.md#invalidjoboptionserror) | Неверная jobs-конфигурация или run options          | Создание `Application` либо запуск отклонены                  |
| [`JobDataCloneError`](../api/errors.md#jobdatacloneerror)           | Payload или result не поддерживает structured clone | Promise запуска отклонён с причиной clone failure             |
| [`JobQueueFullError`](../api/errors.md#jobqueuefullerror)           | Очередь достигла `queueSize`                        | Новый запуск отклонён                                         |
| [`JobAbortedError`](../api/errors.md#jobabortederror)               | Отменён `AbortSignal` ожидающей или активной задачи | Promise запуска отклонён; активный Worker может быть завершён |
| [`JobTimedOutError`](../api/errors.md#jobtimedouterror)             | Истёк timeout ожидающей или активной задачи         | Promise запуска отклонён; активный Worker может быть завершён |
| [`JobExecutionError`](../api/errors.md#jobexecutionerror)           | Пользовательский `Job.run()` выбросил ошибку        | Promise запуска отклонён восстановленной цепочкой cause       |
| [`WorkerTerminatedError`](../api/errors.md#workerterminatederror)   | Worker аварийно завершился или нарушил протокол     | Активная задача отклонена, пул заменяет Worker                |
| [`JobRunnerClosedError`](../api/errors.md#jobrunnerclosederror)     | `run()` после закрытия Job Runner                   | Новый запуск отклонён                                         |

## Middleware

| Класс                                                                   | Операция                                      | Эффект                                                                            |
| ----------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------- |
| [`MiddlewareExecutionError`](../api/errors.md#middlewareexecutionerror) | Один middleware повторно вызвал свой `next()` | HTTP: unexpected `500`; WebSocket: `HANDLER_ERROR`; transport observer вызывается |
