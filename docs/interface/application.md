# Application

`Application` — общий module композиции и единственный публичный владелец HTTP, WebSocket,
внутренних событий и фоновых задач.

## Interface

- Generated types: [`Application`, `ApplicationOptions`, `ListenOptions`](../api/Application.md).
- Пользовательское назначение: [README — жизненный цикл](../../README.md#жизненный-цикл).
- Implementation seam: [`lib/framework/Application.ts`](../../lib/framework/Application.ts).

## Сводка из ADR

<!-- adr-contract:application.shutdown-order -->

Завершение сначала прекращает новый HTTP- и WebSocket-ввод и закрывает WebSocket-сессии, затем последовательно предоставляет
отдельные grace-бюджеты HTTP- и WebSocket-операциями, запечатывает `EventSender`, ограниченно опустошает mailboxes и только после
этого закрывает `Job Runner`. Бюджеты `http.shutdownTimeout`, `websocket.shutdownTimeout`, `events.shutdownTimeout` и `jobs.shutdownTimeout` независимы и складываются,
а не делят общий deadline.

## Минимальный runnable пример

Запуск из корня checkout создаёт приложение на случайном порту и сразу корректно завершает его:

```ts
import { Application } from 'daevox-node-framework';

const application = new Application();
const address = await application.listen({ host: '127.0.0.1', port: 0 });
console.log(`listening on ${address.address}:${address.port}`);
await application.close();
```

```sh
node example.ts
```

## Инварианты

- HTTP-контроллеры, WebSocket-контроллеры и слушатели событий регистрируются до `listen()`.
- `listen()` однократен; ошибка запуска, начавшийся `close()` и завершённое приложение необратимы.
- `close()` прекращает новый ingress, закрывает WebSocket-сессии, ждёт transport settlement или
  forced cutoff, запечатывает event sender, ограниченно опустошает mailboxes и затем закрывает Job
  Runner.
- Бюджеты `http`, `websocket`, `events` и `jobs` независимы и складываются.
- Transport object может завершиться раньше пользовательского handler; shutdown отслеживает именно
  settlement handler до соответствующего cutoff.

## Авторитетные решения

- [ADR 0003 — выполнение запросов и жизненный цикл](../adr/0003-request-execution-and-lifecycle.md).
- [ADR 0011 — transport settlement и полный порядок shutdown](../adr/0011-addressed-application-events.md).

## Проверка через seam

- [`test/unit/application.test.ts`](../../test/unit/application.test.ts) — регистрация и состояния.
- [`test/e2e/graceful-shutdown.test.ts`](../../test/e2e/graceful-shutdown.test.ts) — совместное
  завершение транспортов и Worker.
- [`test/e2e/application-events-shutdown.test.ts`](../../test/e2e/application-events-shutdown.test.ts)
  — settlement transport-handler и event drain.
- [`test/e2e/races.test.ts`](../../test/e2e/races.test.ts) — lifecycle-гонки.
