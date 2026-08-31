# Внутренние события приложения

Events module принимает fire-and-forget сообщения по точному адресу `{ listener, event }` и
доставляет их одному долгоживущему `EventListener` через его FIFO mailbox.

## Interface

- Generated types: [events configuration](../api/Application.md),
  [`EventListenerBase`](../api/EventListenerBase.md),
  [event declarations](../api/EventListenerRegistry.md),
  [`ApplicationEventAddress`](../api/EventSender.md),
  [`EventSenderCapability`](../api/capabilities.md#eventsendercapability),
  [event errors](../api/errors.md).
- Пользовательское назначение: [README — внутренние события](../../README.md#внутренние-события-приложения).
- Пример: [`examples/application-events/`](../../examples/application-events).

## Сводка из ADR

<!-- adr-contract:events.addressed-delivery -->

`Application` поддерживает fire-and-forget доставку внутренних событий по явному адресу
`{ listener, event }`. HTTP- и WebSocket-контроллеры передают события через узкий `EventSender`,
а каждый зарегистрированный `EventListener` является долгоживущим получателем с собственным FIFO
mailbox и обрабатывает события последовательно. Listener объявляет собственные статические `name` и
непустой массив `events`, регистрируется до `listen()` и получает принадлежащие приложению `jobRunner` и
`websocket`, но не `EventSender`. Handler вызывается как `(appState, data, context)` и получает тот же
экземпляр `AppState`, который принадлежит `Application` и передаётся transport-handler.

## Минимальный runnable пример

```ts
import { EventListenerBase } from '@daevox/framework';

class OrderCreated {
  readonly orderId: string;

  constructor(orderId: string) {
    this.orderId = orderId;
  }
}

class AppState {
  readonly environment = 'production';
}

class AuditListener extends EventListenerBase {
  static name = 'audit';
  static events = [{ name: 'OrderCreated', data: OrderCreated, handler: 'record' }] as const;

  record(appState: AppState, event: OrderCreated) {
    console.log(`created ${event.orderId} in ${appState.environment}`);
  }
}
```

Runnable HTTP → event → listener пример:

```sh
npm run example:application-events
```

## Инварианты

- Адрес выбирает ровно один handler; подписки, fan-out и pub/sub отсутствуют.
- `push()` синхронно проверяет адрес, DTO и ёмкость, копирует адрес, возвращает `undefined` после
  принятия и не ждёт handler.
- DTO передаётся той же ссылкой без clone или freeze; доставка in-memory и at-most-once.
- Handler получает тот же изменяемый экземпляр `AppState`, что HTTP- и WebSocket-handler.
- Один listener обрабатывает FIFO строго последовательно; разные listener работают независимо.
- Ошибка принятого handler не попадает в HTTP/WebSocket result и наблюдается через `events.onError`
  или `console.error`.
- `handlerTimeout` отменяет signal, но следующий элемент ждёт фактический settlement handler.
- Listener получает `jobRunner` и `websocket`, но не `events`, поэтому event chains отсутствуют.
- TypeScript связывает literal handler с `AppState`, DTO и context в `registerEventListener()`;
  own-поля и wire-имена остаются runtime-инвариантами.
- Shutdown запечатывает sender после transport settlement, затем ограниченно опустошает mailboxes;
  forced cutoff отменяет active и наблюдает queued элементы как `EventDroppedError`.

## Авторитетное решение

- [ADR 0011 — адресуемые внутренние события](../adr/0011-addressed-application-events.md).

## Проверка через seam

- [`test/unit/event-listener.test.ts`](../../test/unit/event-listener.test.ts) — регистрация и
  публичные зависимости.
- [`test/unit/application-events.test.ts`](../../test/unit/application-events.test.ts) — FIFO,
  acceptance, timeout и error isolation.
- [`test/e2e/application-events-shutdown.test.ts`](../../test/e2e/application-events-shutdown.test.ts)
  — transport settlement, drain и forced cutoff.
