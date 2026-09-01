---
status: accepted
---

# Runtime-регистрация возможностей Application

`Application` сохраняет startup-регистрацию HTTP-контроллеров, WebSocket-контроллеров и
`EventListener` только до `listen()`. После успешного `onAppStart()` и fulfillment `listen()`
открываются отдельные синхронные fluent-методы `registerRuntimeHttpController()`,
`registerRuntimeWebSocketController()` и `registerRuntimeEventListener()`.

Runtime-регистрация принимает те же compile-time и runtime проверки, что startup-операция, и
публикует полностью проверенный snapshot атомарно. HTTP-маршруты и WebSocket-адреса доступны
следующему ingress; уже разрешённая операция продолжает использовать свой snapshot.

Runtime-регистрация закрыта до готовности startup hook, после failed startup, при начале `close()`
и после `closed`. `close()` сначала синхронно закрывает окно регистрации, поэтому операция либо
полностью публикуется до shutdown, либо отклоняется без частичного каталога.

Для runtime `EventListener` metadata сначала валидируется и копируется, затем создаются listener
и mailbox, после чего registry entry и mailbox публикуются без пользовательского кода между этими
шагами. Ошибка конструктора пробрасывается без обёртки и не оставляет частичного состояния.

Это решение пересматривает startup-only положения [ADR 0003](0003-request-execution-and-lifecycle.md)
и [ADR 0011](0011-addressed-application-events.md). Удаление, замена, unload, hot reload,
batch-регистрация и публичная инспекция каталогов остаются вне scope.
