# Runtime-регистрация возможностей Application

Status: accepted

## Назначение

Позволить готовому `Application` атомарно добавлять HTTP-контроллеры,
WebSocket-контроллеры и слушателей внутренних событий без перезапуска transport и без изменения
startup-регистрации.

## Публичный контракт

Startup-регистрация сохраняет существующий interface:

- `registerHttpController()`;
- `registerWebSocketController()`;
- `registerEventListener()`.

Эти методы принимают классы только в состоянии `new` и остаются недоступны после начала
`listen()`.

Для готового приложения добавляются отдельные синхронные fluent-методы:

- `registerRuntimeHttpController()`;
- `registerRuntimeWebSocketController()`;
- `registerRuntimeEventListener()`.

Runtime-методы сохраняют те же generic handler/AppState проверки и runtime-валидацию классов,
metadata и conflicts, что соответствующие startup-методы. Успешный вызов возвращает тот же
экземпляр `Application`.

## Lifecycle

Runtime-регистрация открывается только после успешного завершения `onAppStart()` и fulfillment
`Application.listen()`. Вызов runtime-метода до `listen()`, во время `beforeAppStart()` или
`onAppStart()`, после failed startup, а также во время или после `close()` выбрасывает
`ApplicationStateError`.

`close()` синхронно закрывает runtime-регистрацию до начала асинхронного shutdown. Поэтому
синхронная регистрация либо полностью завершается перед `close()` и становится частью обычного
shutdown, либо отклоняется без изменения каталогов.

Успешно опубликованный HTTP-маршрут или WebSocket-адрес доступен следующему ingress. Уже
разрешённый handler продолжает работу с прежним snapshot и не перенаправляется на новую
регистрацию.

## Атомарность и ошибки

Каждый runtime-метод выполняет полную валидацию до публикации. Невалидный класс, повтор класса,
имени, маршрута или адреса использует существующий специализированный error-класс и не меняет
каталог.

Runtime-регистрация `EventListener` сначала проверяет и копирует metadata, затем создаёт listener
и mailbox и только после этого одновременно делает адрес и mailbox доступными `EventSender`.
Ошибка конструктора пробрасывается без обёртки, не оставляет metadata, адрес или mailbox и не
переводит работающее приложение в `failed`. После любой неуспешной попытки приложение допускает
следующую runtime-регистрацию.

## План реализации

1. [`01-implement-runtime-registration.md`](issues/01-implement-runtime-registration.md) —
   реализовать lifecycle, атомарную публикацию, публичные seam-тесты, ADR и документацию.

## Вне scope

- удаление и замена зарегистрированных классов;
- unload и hot reload;
- batch-регистрация и публичная транзакция;
- публичная инспекция каталогов или mailbox;
- изменение transport protocol, middleware order или shutdown timeout.
