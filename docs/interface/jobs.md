# Фоновые задачи

Jobs module принимает пользовательский класс `Job` через принадлежащий `Application` Job Runner и
выполняет работу во внутреннем Worker Pool.

## Interface

- Generated types: [`Job`](../api/Job.md),
  [`JobRunnerCapability`](../api/capabilities.md#jobrunnercapability),
  [job configuration](../api/JobRunner.md), [job errors](../api/errors.md).
- Пользовательское назначение: [README — фоновые задачи](../../README.md#фоновые-задачи).
- Пример: [`examples/jobs-http/`](../../examples/jobs-http).

## Сводка из ADR

<!-- adr-contract:jobs.worker-pool -->

`Application` владеет единственным внутренним `Job Runner`, который проверяет пользовательские классы `Job` и передаёт нормализованную работу во внутренний пул потоков `node:worker_threads`. Класс задачи напрямую наследует публичный `Job`, экспортируется из собственного ESM-модуля по умолчанию и объявляет собственное статическое поле `metaUrl = import.meta.url`; Worker загружает только локальные `file:` URL и вызывает экземплярный `run`. Такой контракт не переносит классы между потоками, сохраняет изоляцию фоновой работы от HTTP-обработчиков и позволяет переиспользовать Worker, не раскрывая управление пулом в публичном API.

## Минимальный runnable пример

Задача должна находиться в собственном модуле:

```ts
import { Job } from 'daevox-node-framework';

export default class SumJob extends Job {
  static metaUrl = import.meta.url;

  run({ left, right }: { left: number; right: number }) {
    return left + right;
  }
}
```

Её запуск через injected capability выглядит так:

```ts
const sum = await this.jobRunner.run(SumJob, { left: 2, right: 3 });
```

Runnable HTTP → Job пример:

```sh
npm run example:jobs-http
```

## Инварианты

- Класс задачи напрямую наследует `Job`, экспортируется по умолчанию из собственного ESM-модуля,
  объявляет собственное `static metaUrl = import.meta.url` и собственный `run()`.
- Payload и result проходят structured clone; transferable-объекты не поддерживаются.
- Job Runner и Worker Pool принадлежат `Application` и не доступны как свойства приложения.
- Контроллер получает Job Runner через `this.jobRunner`; его `run()` поддерживает `AbortSignal` и
  timeout, а `close()` закрывает общий пул приложения.
- Ограниченная очередь выполняет ожидающие задачи FIFO; Worker переиспользуется, но экземпляр `Job`
  создаётся для каждого запуска.
- Некооперативная работа принудительно завершает Worker после termination grace period.

## Авторитетное решение

- [ADR 0006 — фоновые задачи в Worker Pool](../adr/0006-background-jobs-in-worker-pool.md).

## Проверка через seam

- [`test/unit/job-runner.test.ts`](../../test/unit/job-runner.test.ts) — запуск, clone, очередь,
  отмена, timeout, Worker failure и close.
- [`test/unit/http-transport.test.ts`](../../test/unit/http-transport.test.ts) — запуск Job через
  реальный HTTP-контроллер.
- [`test/e2e/races.test.ts`](../../test/e2e/races.test.ts) — терминальные гонки Job Runner.
