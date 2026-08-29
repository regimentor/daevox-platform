Status: resolved
Blocked by: 01, 02

# Интегрировать EventListener в Application и контроллеры

## Question

Интегрировать registry, listener и `EventSender` в lifecycle `Application`, HTTP- и WebSocket-контроллеры по [`../spec.md`](../spec.md), не меняя пока полный shutdown-порядок.

## Требования

- Работать через TDD; исходники и тесты писать только в `.js`.
- Добавить строгую `events`-секцию конфигурации `Application`; defaults действуют и без явной секции.
- Добавить fluent `Application.registerEventListener()` только в `new`-состоянии.
- Создавать по одному экземпляру listener во время `listen()`; constructor error делает failed-запуск необратимым.
- Передавать listener read-only enumerable non-configurable `jobRunner` и `websocket`, но не `events`.
- Добавить `events` в `HttpControllerBase` и `WebSocketControllerBase` с точной матрицей свойств и сохранить существующие зависимости.
- Всегда передавать контроллеру `this.events`, даже если listener не зарегистрированы.
- Не раскрывать sender на `Application`, в `Job` или listener.
- Добавить двуязычный JSDoc с `@public`/`@private` для production-кода.

## Критерии приёмки

- Unit-тесты покрывают регистрацию, conflicts, late registration, listener construction и failed startup.
- HTTP- и WebSocket-тесты покрывают точную матрицу доступных фасадов.
- Принятое событие обрабатывается после возврата `push()`, а handler error не меняет HTTP- или WebSocket-результат.
- Релевантные unit/integration-тесты и `npm run docs:build` завершаются успешно.

## Comments

Полный transport settlement tracking и shutdown вынесены в зависимую задачу 04.

Регистрация listener и зависимости HTTP-, WebSocket-контроллеров и listener интегрированы в `Application` и проверены через публичный interface.
