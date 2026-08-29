---
status: accepted
---

# Адресуемые внутренние события

`Application` поддерживает fire-and-forget доставку внутренних событий по явному адресу
`{ listener, event }`. HTTP- и WebSocket-контроллеры передают события через узкий `EventSender`,
а каждый зарегистрированный `EventListener` является долгоживущим получателем с собственным FIFO
mailbox и обрабатывает события последовательно. Listener объявляет собственные статические `name` и
непустой массив `events`, регистрируется до `listen()` и получает принадлежащие приложению `jobRunner` и
`websocket`, но не `EventSender`.

`EventSender.push(address, data)` синхронно проверяет адрес и класс данных, помещает принятое событие в mailbox и
не возвращает Promise обработчика. Ошибки адреса, данных, переполнения и состояния вызова выбрасываются
синхронно; любая ошибка уже принятого обработчика изолируется от отправителя и наблюдается через
необязательный `events.onError` или `console.error` по умолчанию.

Доставка остаётся in-memory и at-most-once: фреймворк не вводит подписки, fan-out, персистентную очередь,
автоматические повторы или цепочки событий из listener. Данные обязаны быть экземпляром объявленного DTO-класса.
Фреймворк передаёт ту же ссылку без замораживания или клонирования; целостность DTO остаётся ответственностью
приложения.

Каждый listener имеет отдельный ограниченный mailbox; `events.queueSize` по умолчанию равен `1000`. Переполнение
представлено синхронным `EventQueueFullError`. Запуск mailbox всегда планируется через `setImmediate()`, поэтому
пользовательский код не выполняется внутри `push()`.

Необработанная ошибка handler не заменяет экземпляр listener: после наблюдения ошибки тот же экземпляр переходит
к следующему событию; целостность его внутреннего состояния остаётся ответственностью listener. Обработчик
получает вторым аргументом `{ signal }`; `events.handlerTimeout` по умолчанию равен `30000` мс. Listener не имеет lifecycle hooks
и не владеет внешними ресурсами.

По истечении `handlerTimeout` фреймворк отменяет `signal` и однократно передаёт `EventHandlerTimeoutError` наблюдателю,
но не запускает следующее событие до фактического settlement текущего handler. Это сохраняет строгий FIFO и делает
кооперативную реакцию handler на `signal` обязательной для продолжения его mailbox.

Listener обязан напрямую наследовать `EventListenerBase`; его собственные статические `name` и непустой массив `events`
проверяются при регистрации, копируются и замораживаются. Имена соответствуют `^[A-Za-z0-9_-]+$`, каждая
декларация содержит класс данных и имя собственного метода prototype, а адреса не повторяются. Все экземпляры listener
создаются во время `listen()`; ошибка конструктора необратимо переводит запуск `Application` в failed-состояние.

Лимит `queueSize` считает только ожидающие в mailbox события, но не уже выполняющийся handler. Наблюдатель `events.onError`
вызывается без ожидания; его синхронная ошибка или rejected Promise передаются в `console.error` и не задерживают mailbox.

Контекст ошибки handler содержит только замороженные `{ listener, event }`; данные события не раскрываются наблюдателю.

При завершении `Application` уже активные HTTP- и WebSocket-handler могут продолжать вызывать `push()`; `EventSender`
запечатывается только после прекращения внешнего ввода и settlement активных transport-handler либо их forced cutoff. WebSocket-сессии
по-прежнему закрываются в начале shutdown, поэтому server push из listener во время drain остаётся best-effort, может ничего не отправить или выбросить
`WebSocketClientNotFoundError`.

`events.shutdownTimeout` по умолчанию равен `30000` мс. По его истечении сигналы активных handler отменяются, ожидающие
события отбрасываются, а фреймворк перестаёт ждать listener и закрывает `Job Runner`. Каждое отброшенное событие
наблюдается как `EventDroppedError`, но `Application.close()` на этом основании не отклоняется. Ограниченный forced shutdown является
исключением из строгой FIFO-семантики.

Внутренние события не поддерживают middleware. Публичные ошибки механизма: `InvalidEventOptionsError`, `InvalidEventListenerError`,
`EventListenerConflictError`, `InvalidEventPushError`, `EventQueueFullError`, `EventSenderClosedError`, `EventHandlerTimeoutError` и `EventDroppedError`.
Реальная ошибка handler передаётся в `events.onError` без обёртки.

Конфигурация `events` допускает только `queueSize`, `handlerTimeout`, `shutdownTimeout` и `onError`. Числовые поля обязаны быть
положительными safe integer; нулевые, бесконечные или отключённые timeout не поддерживаются. `push()` после успешного
принятия возвращает `undefined`.

Handler может завершаться синхронно или возвращать Promise; его значение игнорируется, а следующее событие начинается
только после settlement. Если timeout уже был сообщён, позднейший rejection того же handler повторно не наблюдается. Специальной
прикладной ошибки нет: handler сам перехватывает ожидаемые отказы, а любая escaping error считается ошибкой listener.

HTTP-контроллер получает read-only свойства `jobRunner`, `websocket` и `events`, WebSocket-контроллер — `jobRunner` и `events`, а listener — `jobRunner` и
`websocket`; все эти свойства enumerable и non-configurable. `Application.registerEventListener()` регистрирует класс только до `listen()`
и возвращает тот же `Application`; повтор класса или имени представлен `EventListenerConflictError`, а поздняя регистрация —
существующим `ApplicationStateError`.

Чтобы сохранить право уже активного transport-handler на `push()` во время grace-фазы, `Application` отдельно отслеживает settlement
HTTP-handler, WebSocket message-handler, начатых upgrade, `onConnect` и `onDisconnect`. Отсутствие transport response или сессии само по себе не
означает settlement пользовательского handler.

WebSocket-конфигурация получает `shutdownTimeout` с default `30000` мс, охватывающий активные message-handler, pending upgrade, `onConnect` и
`onDisconnect`. По истечении transport timeout запечатывается `EventSender`; поздний `push()` из не завершившегося handler выбрасывает
`EventSenderClosedError`.

Завершение сначала прекращает новый HTTP- и WebSocket-ввод и закрывает WebSocket-сессии, затем последовательно предоставляет
отдельные grace-бюджеты HTTP- и WebSocket-операциями, запечатывает `EventSender`, ограниченно опустошает mailboxes и только после
этого закрывает `Job Runner`. Бюджеты `http.shutdownTimeout`, `websocket.shutdownTimeout`, `events.shutdownTimeout` и `jobs.shutdownTimeout` независимы и складываются,
а не делят общий deadline.

Каждый запланированный через `setImmediate()` шаг mailbox запускает не более одного события; после settlement следующий шаг планируется
отдельно. `handlerTimeout` начинается непосредственно перед вызовом handler и не включает время ожидания в mailbox.

По истечении `events.shutdownTimeout` активный handler получает обычную отмену `signal` без отдельной наблюдаемой ошибки; поздний rejection после
forced cutoff перехватывается внутри, но больше не передаётся в `events.onError`. При обычном `handlerTimeout` публичный `EventHandlerTimeoutError` также
становится `signal.reason`.

`push()` синхронно копирует и замораживает нормализованный адрес, поэтому последующая мутация исходного объекта не меняет маршрут и
контекст ошибки. Каждая декларация события имеет ровно собственные строковые ключи `name`, `data` и `handler`; дополнительные, symbol-, accessor- и
унаследованные поля недопустимы.

Listener выполняется в основном потоке. Синхронная CPU-heavy работа или бесконечный цикл блокируют event loop и не могут быть прерваны
таймером фреймворка; listener сам передаёт такую работу в `jobRunner`, а остальные риски блокирующего кода несёт приложение.

Публично экспортируются `EventListenerBase` и публичные классы ошибок механизма. `EventSender`, registry, dispatcher и mailbox остаются внутренними;
приложение получает sender только как `this.events` контроллера. DTO не требует базового класса фреймворка. `this.events` существует даже без
зарегистрированных listener или явной `events`-конфигурации; неизвестный адрес по-прежнему представлен `InvalidEventPushError`.

Публичные `flush`, `size`, `isIdle` и каталог адресов не вводятся. Тест синхронизируется с listener через контролируемый Promise или наблюдаемый побочный
эффект, либо вызывает `Application.close()`, который ограниченно опустошает mailbox.

## Пересмотр ADR 0003

`Application.close()` больше не определяет активность пользовательского handler только по жизненному циклу transport object. Фреймворк отслеживает settlement
transport-handler до соответствующего forced cutoff, а EventListener mailboxes опустошаются до закрытия принадлежащего приложению `Job Runner`.

## Пересмотр ADR 0010

WebSocket sender больше не ограничен HTTP-контроллерами: он также передаётся `EventListener`. Семантика его
доставки и изоляция от raw socket и `WebSocketSessionStore` не меняются.
