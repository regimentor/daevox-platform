Status: resolved
Blocked by: 01

# Реализовать EventSender и actor mailbox

## Question

Реализовать внутреннюю fire-and-forget доставку, последовательный mailbox каждого listener, timeout и изоляцию ошибок по
[`../spec.md`](../spec.md).

## Требования

- Работать через TDD; исходники и тесты писать только в `.js`.
- Скрыть dispatcher, sender и mailboxes за внутренними интерфейсами; публичный фасад имеет только `push(address, data)`.
- Синхронно проверять точный адрес, `instanceof` DTO, capacity и состояние sender.
- Копировать и замораживать адрес; DTO передавать той же ссылкой.
- Возвращать `undefined` сразу после принятия, не раскрывать Promise или результат handler.
- Поддержать один долгоживущий экземпляр и один FIFO mailbox на listener, параллельные listener и ровно один handler за один `setImmediate()`.
- Считать capacity только по ожидающим событиям, не включая active handler.
- Вызывать handler с `(data, { signal })`, игнорировать результат и ждать settlement до следующего события.
- Начинать timeout перед handler; передавать `EventHandlerTimeoutError` в `signal.reason` и observer, но не нарушать FIFO до settlement.
- Не заменять listener после handler error; позднюю ошибку после уже сообщённого timeout не наблюдать повторно.
- Вызывать `events.onError` без ожидания с исходной ошибкой и замороженным `{ listener, event }`; observer errors и fallback передавать в `console.error`.
- Не добавлять pub/sub, retry, middleware, lifecycle hooks, публичные flush или инспекцию.
- Добавить двуязычный JSDoc с `@public`/`@private` для production-кода.

## Критерии приёмки

- Unit-тесты доказывают fire-and-forget возврат, FIFO, fairness между listener и параллельность разных listener.
- Покрыты неверный адрес/DTO, unknown listener/event, queue full и closed sender.
- Покрыты sync throw, rejected Promise, timeout, cooperative abort, late rejection, observer failure и сохранение listener.
- Мутация исходного address не меняет доставку; в handler передаётся исходная DTO-ссылка.
- Релевантные unit-тесты и `npm run docs:build` завершаются успешно.

## Comments

Обработка выполняется в основном потоке; CPU-heavy работу приложение явно передаёт в `jobRunner`.

`EventSender` и FIFO mailbox реализованы на TypeScript; acceptance, fairness, timeout и изоляция ошибок покрыты unit-тестами.
